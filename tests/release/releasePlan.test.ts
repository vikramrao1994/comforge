import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { draftIntent, INTENT_SCHEMA, type ReleaseIntent } from "../../tooling/release/releaseIntent";
import {
  applyBump,
  changelogSection,
  changelogSectionOf,
  collectCommits,
  collectIntents,
  evaluatePlan,
  groupBranch,
  groupOrder,
  type IntentRecord,
  type PlanInput,
  PlanRefusal,
  setDependencyVersion,
  setManifestVersion,
  setVersionConstant,
  versionBranch,
  withoutVersionConstant,
  writeChangelogSection,
} from "../../tooling/release/releasePlan";

// COMFORGE-RELEASE-AUTOMATION-001: the planner turns reviewed release intents and the real
// difference between two candidate builds into a version decision, or refuses.

const sha = (n: number) => n.toString(16).padStart(40, "0");
const FILES = { "src/index.ts": "a", "dist/index.js": "b", "README.md": "c", "package.json": "d" };
const intent = (over: Partial<ReleaseIntent> = {}): ReleaseIntent => ({
  schema: INTENT_SCHEMA,
  package: "@comforge/core",
  bump: "patch",
  summary: "Fix a thing.",
  breaking: null,
  covers: [],
  ...over,
});
const record = (file: string, i: ReleaseIntent, addedIn = sha(1)): IntentRecord => ({
  file: `release-intents/${file}.json`,
  intent: i,
  addedIn,
});
const input = (over: Partial<PlanInput> = {}): PlanInput => ({
  package: "@comforge/core",
  head: sha(99),
  baseline: { version: "0.1.2", sourceCommit: sha(0), files: FILES },
  headVersion: "0.1.2",
  changelog: "# Changelog\n\nIntro.\n\n## 0.1.2\n\nOld.\n",
  candidateFiles: FILES,
  manifestChanged: false,
  exports: { before: ["a", "b"], after: ["a", "b"] },
  commits: [],
  intents: [],
  editedIntents: [],
  invalidIntents: [],
  ...over,
});
const libraryCommit = (n: number, intentsAdded: string[] = []) => ({
  sha: sha(n),
  subject: `change ${n}`,
  libraryChange: true,
  intentsAdded,
});
const refusal = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    if (error instanceof PlanRefusal) return error.code;
    throw error;
  }
  return "no refusal";
};

describe("SemVer with the pre-1.0 policy", () => {
  test.each([
    ["0.1.2", "none", "0.1.2"],
    ["0.1.2", "patch", "0.1.3"],
    ["0.1.2", "minor", "0.2.0"],
    ["0.1.2", "major", "0.2.0"],
    ["1.4.2", "patch", "1.4.3"],
    ["1.4.2", "minor", "1.5.0"],
    ["1.4.2", "major", "2.0.0"],
  ] as const)("%s + %s = %s", (from, bump, to) => {
    expect(applyBump(from, bump)).toBe(to);
  });
});

describe("evaluatePlan", () => {
  test("nothing changed and no intent is no release", () => {
    const plan = evaluatePlan(input());
    expect(plan.status).toBe("no-release");
    expect(plan.nextVersion).toBeNull();
    expect(plan.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test("a covered library change asks for its version PR with the highest bump", () => {
    const plan = evaluatePlan(
      input({
        candidateFiles: { ...FILES, "src/index.ts": "x", "dist/index.js": "y" },
        exports: { before: ["a"], after: ["a", "b"] },
        commits: [libraryCommit(1, ["release-intents/one.json"]), libraryCommit(2, ["release-intents/two.json"])],
        intents: [record("one", intent({ bump: "patch", summary: "Fix one." })), record("two", intent({ bump: "minor", summary: "Add b." }), sha(2))],
      }),
    );
    expect(plan.status).toBe("version-pr-due");
    expect(plan.bump).toBe("minor");
    expect(plan.nextVersion).toBe("0.2.0");
    expect(plan.api.added).toEqual(["b"]);
    expect(plan.changes.library).toEqual(["dist/index.js", "src/index.ts"]);
    expect(plan.changelogSection).toBe("## 0.2.0\n\n- Add b.\n- Fix one.\n");
    expect(versionBranch(plan)).toBe("comforge-release/core/v0.2.0");
  });

  test("a breaking intent below 1.0 raises the minor and is labelled in the changelog", () => {
    const plan = evaluatePlan(
      input({
        exports: { before: ["a", "b"], after: ["a"] },
        intents: [record("break", intent({ bump: "major", summary: "Remove b.", breaking: "Use a instead." }))],
      }),
    );
    expect(plan.nextVersion).toBe("0.2.0");
    expect(plan.changelogSection).toContain("- **Breaking:** Remove b. Use a instead.");
  });

  test("a library commit without an intent is refused; a later intent's covers classifies it", () => {
    const base = input({
      candidateFiles: { ...FILES, "src/index.ts": "x" },
      commits: [libraryCommit(1), { sha: sha(2), subject: "intent", libraryChange: false, intentsAdded: ["release-intents/late.json"] }],
    });
    expect(refusal(() => evaluatePlan({ ...base, intents: [record("late", intent(), sha(2))] }))).toBe("uncovered-change");
    const plan = evaluatePlan({ ...base, intents: [record("late", intent({ covers: [sha(1)] }), sha(2))] });
    expect(plan.commits.coveredBy[sha(1)]).toBe("release-intents/late.json");
    expect(plan.status).toBe("version-pr-due");
  });

  test("covers must name a commit since the last release", () => {
    expect(refusal(() => evaluatePlan(input({ intents: [record("x", intent({ covers: [sha(7)] }))] })))).toBe("intent-covers-unknown");
  });

  test("a shipped library difference no intent classifies is refused (a toolchain change, for one)", () => {
    expect(refusal(() => evaluatePlan(input({ candidateFiles: { ...FILES, "dist/index.js": "rebuilt" } })))).toBe("unclassified-change");
    expect(refusal(() => evaluatePlan(input({ manifestChanged: true })))).toBe("unclassified-change");
  });

  test("a distribution-only difference without an intent waits for the next release", () => {
    const plan = evaluatePlan(input({ candidateFiles: { ...FILES, "README.md": "edited" } }));
    expect(plan.status).toBe("no-release");
    expect(plan.changes.distribution).toEqual(["README.md"]);
  });

  test("removed exports need a major intent, added exports at least a minor one", () => {
    expect(refusal(() => evaluatePlan(input({ exports: { before: ["a", "b"], after: ["a"] }, intents: [record("m", intent({ bump: "minor" }))] })))).toBe(
      "breaking-unclassified",
    );
    expect(refusal(() => evaluatePlan(input({ exports: { before: ["a"], after: ["a", "c"] }, intents: [record("p", intent())] })))).toBe(
      "feature-unclassified",
    );
  });

  test("invalid and edited intents are refused before anything else", () => {
    expect(refusal(() => evaluatePlan(input({ invalidIntents: [{ file: "release-intents/x.json", message: "bad" }] })))).toBe("intent-invalid");
    expect(refusal(() => evaluatePlan(input({ editedIntents: ["release-intents/x.json"] })))).toBe("intent-edited");
  });

  test("another package's intent never bumps this one", () => {
    const other = { ...intent({ bump: "major", breaking: "x" }), package: "@comforge/github" } as unknown as ReleaseIntent;
    expect(evaluatePlan(input({ intents: [record("other", other)] })).status).toBe("no-release");
  });

  test("after the version PR the plan is release-ready only while the changelog matches the intents", () => {
    const intents = [record("one", intent({ summary: "Fix one." }))];
    const section = changelogSection("0.1.3", intents);
    const ready = evaluatePlan(input({ headVersion: "0.1.3", changelog: writeChangelogSection("# C\n\n## 0.1.2\n", section, "0.1.3"), intents }));
    expect(ready.status).toBe("release-ready");
    const stale = evaluatePlan(
      input({
        headVersion: "0.1.3",
        changelog: writeChangelogSection("# C\n\n## 0.1.2\n", section, "0.1.3"),
        intents: [...intents, record("two", intent({ summary: "Fix two." }), sha(3))],
      }),
    );
    expect(stale.status).toBe("version-pr-due");
    expect(stale.reason).toContain("refresh");
  });

  test("a version moved by hand, or with no intent, is ambiguous", () => {
    expect(refusal(() => evaluatePlan(input({ headVersion: "0.1.3" })))).toBe("version-state-ambiguous");
    expect(refusal(() => evaluatePlan(input({ headVersion: "0.1.4", intents: [record("one", intent())] })))).toBe("version-state-ambiguous");
  });

  test("an already published next version is refused", () => {
    expect(refusal(() => evaluatePlan(input({ intents: [record("one", intent())], publishedVersions: ["0.1.2", "0.1.3"] })))).toBe("version-published");
  });

  test("the digest binds the plan to its head commit", () => {
    expect(evaluatePlan(input()).digest).not.toBe(evaluatePlan(input({ head: sha(98) })).digest);
  });
});

describe("version file writers", () => {
  test("the manifest version and the example dependency change and nothing else", () => {
    const manifest = '{\n  "name": "@comforge/core",\n  "version": "0.1.2",\n  "dependencies": {\n    "zod": "^4.6.6"\n  }\n}\n';
    expect(setManifestVersion(manifest, "0.1.2", "0.2.0")).toBe(manifest.replace('"0.1.2"', '"0.2.0"'));
    expect(() => setManifestVersion(manifest, "0.1.1", "0.2.0")).toThrow();
    const example = '{ "dependencies": { "@comforge/core": "0.1.2", "zod": "^4" } }';
    expect(setDependencyVersion(example, "@comforge/core", "0.1.2", "0.2.0")).toContain('"@comforge/core": "0.2.0"');
  });

  test("a registered version literal moves with the version, and only an exact match is rewritten", () => {
    const source = 'export const SERVER_NAME = "comforge-mcp";\nexport const SERVER_VERSION = "0.2.0";\n';
    expect(setVersionConstant(source, "SERVER_VERSION", "0.2.0", "0.2.1")).toBe(source.replace('"0.2.0"', '"0.2.1"'));
    expect(() => setVersionConstant(source, "SERVER_VERSION", "0.1.0", "0.2.1")).toThrow();
  });

  test("the mcp package registers its serverInfo literal, and it matches the package version", async () => {
    const { PACKAGES } = await import("../../tooling/release/packages");
    const { readFileSync } = await import("node:fs");
    const mcp = PACKAGES["@comforge/mcp"];
    expect(mcp.versionConstant).toEqual({ file: "src/tools.ts", name: "SERVER_VERSION" });
    const version = JSON.parse(readFileSync(`${mcp.dir}/package.json`, "utf8")).version;
    expect(readFileSync(`${mcp.dir}/src/tools.ts`, "utf8")).toContain(`export const SERVER_VERSION = "${version}";`);
  });

  test("a changelog section goes above the newest entry and replaces its own version's", () => {
    const changelog = "# Changelog\n\nIntro.\n\n## 0.1.2\n\nOld.\n";
    const once = writeChangelogSection(changelog, "## 0.1.3\n\n- A.\n", "0.1.3");
    expect(once).toBe("# Changelog\n\nIntro.\n\n## 0.1.3\n\n- A.\n\n## 0.1.2\n\nOld.\n");
    const twice = writeChangelogSection(once, "## 0.1.3\n\n- A.\n- B.\n", "0.1.3");
    expect(changelogSectionOf(twice, "0.1.3")).toBe("## 0.1.3\n\n- A.\n- B.");
    expect(changelogSectionOf(twice, "0.1.2")).toBe("## 0.1.2\n\nOld.");
  });
});

describe("collection from Git", () => {
  const repo = mkdtempSync(path.join(tmpdir(), "release-plan-git-"));
  const g = (...args: string[]) => {
    const r = spawnSync("git", args, { cwd: repo, encoding: "utf8", env: { ...process.env, HUSKY: "0" } });
    if (r.status !== 0) throw new Error(r.stderr);
    return r.stdout.trim();
  };
  const write = (file: string, text: string) => {
    mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    writeFileSync(path.join(repo, file), text);
  };
  const commit = (message: string) => {
    g("add", "-A");
    g("-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", message);
    return g("rev-parse", "HEAD");
  };
  const intentText = (i: ReleaseIntent) => `${JSON.stringify(i, null, 2)}\n`;

  g("init", "-q", "-b", "main");
  write("packages/core/package.json", '{\n  "name": "@comforge/core",\n  "version": "0.1.2"\n}\n');
  write("packages/core/src/index.ts", "export const a = 1;\n");
  const baseline = commit("release");
  write("packages/core/src/index.ts", "export const a = 2;\n");
  write("release-intents/fix.json", intentText(draftIntent("@comforge/core", { bump: "patch" }, "Fix a.")));
  const withIntent = commit("fix with intent");
  write("packages/core/test/x.test.ts", "test\n");
  commit("test only");
  write("packages/core/package.json", '{\n  "name": "@comforge/core",\n  "version": "0.1.3"\n}\n');
  commit("version only");
  write("packages/core/src/index.ts", "export const a = 3;\n");
  const bare = commit("fix without intent");

  test("a commit that changes only the version constant is not a library change", () => {
    // The version step rewrites `SERVER_VERSION` in the MCP server's source; any other edit to
    // that file, or a different line, is still library code that needs an intent.
    const source = 'import x from "y";\nexport const SERVER_VERSION = "0.2.0";\nexport const a = 1;\n';
    expect(withoutVersionConstant(source, "SERVER_VERSION")).toBe(withoutVersionConstant(source.replace('"0.2.0"', '"0.3.0"'), "SERVER_VERSION"));
    expect(withoutVersionConstant(source, "SERVER_VERSION")).not.toBe(withoutVersionConstant(source.replace("a = 1", "a = 2"), "SERVER_VERSION"));
    expect(withoutVersionConstant(source, "SERVER_VERSION")).not.toBe(
      withoutVersionConstant(source.replace('SERVER_VERSION = "0.2.0"', 'OTHER = "0.2.0"'), "SERVER_VERSION"),
    );
    // The committed MCP version commit is recognised as one (a6209d7c: 0.2.0 → 0.3.0).
    const repoRoot = path.resolve(import.meta.dir, "../..");
    const has = spawnSync("git", ["cat-file", "-e", "a6209d7c^{commit}"], { cwd: repoRoot });
    if (has.status === 0) {
      const commits = collectCommits(repoRoot, "@comforge/mcp", "a6209d7c^", "a6209d7c");
      expect(commits.map((c) => [c.subject, c.libraryChange])).toEqual([["build(architecture): version @comforge/mcp 0.3.0", false]]);
    }
  });

  test("commits are classified by library change and the intents they add", () => {
    const commits = collectCommits(repo, "@comforge/core", baseline, "HEAD");
    expect(commits.map((c) => [c.subject, c.libraryChange, c.intentsAdded])).toEqual([
      ["fix with intent", true, ["release-intents/fix.json"]],
      ["test only", false, []],
      ["version only", false, []],
      ["fix without intent", true, []],
    ]);
    expect(commits[0]?.sha).toBe(withIntent);
    expect(commits[3]?.sha).toBe(bare);
  });

  test("intents carry the commit that added them; an edited or malformed one is reported", () => {
    const first = collectIntents(repo, baseline, "HEAD");
    expect(first.intents.map((r) => [r.file, r.addedIn])).toEqual([["release-intents/fix.json", withIntent]]);
    write("release-intents/fix.json", intentText(draftIntent("@comforge/core", { bump: "minor" }, "Fix a.")));
    write("release-intents/bad.json", "{}\n");
    write("release-intents/README.md", "How intents work.\n");
    commit("edit the intent");
    const second = collectIntents(repo, baseline, "HEAD");
    expect(second.editedIntents).toEqual(["release-intents/fix.json"]);
    expect(second.invalidIntents.map((i) => i.file)).toEqual(["release-intents/bad.json"]);
    rmSync(repo, { recursive: true, force: true });
  });
});

describe("group version PRs", () => {
  test("a group is planned in dependency order, whatever order it was named in", () => {
    expect(groupOrder(["@comforge/mcp", "github", "@comforge/cli"])).toEqual(["@comforge/github", "@comforge/cli", "@comforge/mcp"]);
    expect(groupOrder(["cli"])).toEqual(["@comforge/cli"]);
  });

  test("a package named twice, or an unknown one, is refused", () => {
    expect(() => groupOrder(["cli", "@comforge/cli"])).toThrow(/twice/);
    expect(() => groupOrder(["@comforge/nope"])).toThrow();
  });

  test("a group's branch names its packages in dependency order", () => {
    expect(groupBranch(groupOrder(["mcp", "github", "cli"]))).toBe("comforge-release/group-github-cli-mcp");
  });
});
