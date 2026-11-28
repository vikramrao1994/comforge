import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { keyIdFor } from "@comforge/core";
import { checkProvenance, PACKAGES as MIRROR_PACKAGES, verifyRelease } from "../../tooling/release/assets/npm-release.mjs";
import { buildCandidateRecord, type CandidateInput } from "../../tooling/release/candidate";
import { candidateDependencies } from "../../tooling/release/candidates";
import { decideConsumerUpdate } from "../../tooling/release/consumerUpdate";
import {
  buildCandidate,
  type Candidate,
  dryRunRelease,
  git,
  isOwnedBy,
  listFiles,
  OWNERSHIP_FILE,
  OWNERSHIP_SCHEMA,
  planSync,
  RELEASE_FILE,
  ReleaseRefusal,
  scanForDisclosure,
} from "../../tooling/release/mirror";
import { allTests, assertRegistry, CORE, dependentsOf, PACKAGES, type PackageProfile, profileOf, sourceInputs } from "../../tooling/release/packages";
import {
  AuthorizationRefusal,
  buildAuthorization,
  parseTrust,
  signAuthorization,
  TRUST_SCHEMA,
  verifyDispatch,
  verifyReleaseAuthorization,
} from "../../tooling/release/releaseAuthorization";
import { INTENT_SCHEMA, parseIntent, ReleaseIntentSchema } from "../../tooling/release/releaseIntent";
import { applyBump, evaluatePlan, type PlanInput, satisfiesRange, UNRELEASED } from "../../tooling/release/releasePlan";
import { RELEASE_REPOSITORY_SLUG as ENGINEERING_REPOSITORY_SLUG } from "../../tooling/release/repository";

// two packages released independently from one registry. Core keeps its
// exact identity; neither package's version, tag, branch, npm workflow or owner approval can
// stand in for the other's.

const REPO = path.resolve(import.meta.dir, "../..");
/** The version the consumer pinned for a package after reading its release back. */
const pinnedVersion = (name: string) =>
  (JSON.parse(readFileSync(path.join(REPO, profileOf(name).pinDir, "npm-pin.json"), "utf8")) as { version: string }).version;
const GITHUB = PACKAGES["@comforge/github"];

describe("the package registry", () => {
  test("core keeps exactly the identity it had before the registry", () => {
    expect(CORE).toMatchObject({
      name: "@comforge/core",
      dir: "packages/core",
      example: "examples/core-consumer",
      tagPrefix: "core/v",
      releaseBranch: "releases/core",
      npmWorkflow: ".github/workflows/npm-publish.yml",
      pinDir: "releases/baseline/core",
    });
    expect(sourceInputs(CORE)).toEqual(["packages/core", "examples/core-consumer", "tooling/release/assets"]);
  });

  test("every package has its own tag, branch, pin and npm workflow, and ships no other's workflow", () => {
    expect(() => assertRegistry()).not.toThrow();
    expect(GITHUB.npmWorkflow).not.toBe(CORE.npmWorkflow);
    expect(Object.keys(GITHUB.assets)).not.toContain(CORE.npmWorkflow);
    expect(Object.keys(CORE.assets)).not.toContain(GITHUB.npmWorkflow);
  });

  test("the registry refuses cycles, unknown dependencies and shared identities", () => {
    const cyclic = { a: { ...CORE, name: "a", dependsOn: ["b"] }, b: { ...GITHUB, name: "b", dependsOn: ["a"] } } as unknown as Record<string, PackageProfile>;
    expect(() => assertRegistry(cyclic)).toThrow(/cycle/);
    const unknown = { a: { ...GITHUB, dependsOn: ["@comforge/agents"] } } as unknown as Record<string, PackageProfile>;
    expect(() => assertRegistry(unknown)).toThrow(/unknown/);
    const shared = { a: CORE, b: { ...GITHUB, tagPrefix: "core/v" } } as unknown as Record<string, PackageProfile>;
    expect(() => assertRegistry(shared)).toThrow(/duplicate tagPrefix/);
    const crossWorkflow = { a: CORE, b: { ...GITHUB, assets: { ...GITHUB.assets, ...CORE.assets } } } as unknown as Record<string, PackageProfile>;
    expect(() => assertRegistry(crossWorkflow)).toThrow(/ships @comforge\/core's npm workflow/);
  });

  test("dependencies run one way: github on core, the cli on all three, the mcp on the cli, nothing on the mcp", () => {
    expect(dependentsOf("@comforge/core")).toEqual(["@comforge/github", "@comforge/cli", "@comforge/mcp"]);
    expect(dependentsOf("@comforge/github")).toEqual(["@comforge/cli", "@comforge/mcp"]);
    expect(dependentsOf("@comforge/ledger")).toEqual(["@comforge/cli", "@comforge/mcp"]);
    expect(dependentsOf("@comforge/cli")).toEqual(["@comforge/mcp"]);
    expect(dependentsOf("@comforge/mcp")).toEqual([]);
    expect(() => profileOf("@comforge/agents")).toThrow(/not a releasable Comforge package/);
    expect(profileOf("github")).toBe(GITHUB);
  });

  test("the github package declares the core range the registry expects, and the npm helper knows both", () => {
    const manifest = JSON.parse(readFileSync(path.join(REPO, GITHUB.dir, "package.json"), "utf8"));
    expect(Object.keys(manifest.dependencies)).toContain(CORE.name);
    // The mirror's copy of the registry is exactly the registry.
    expect(MIRROR_PACKAGES).toEqual(Object.fromEntries(Object.values(PACKAGES).map((p) => [p.name, { tagPrefix: p.tagPrefix, workflow: p.npmWorkflow }])));
  });
});

describe("the @comforge/ledger profile", () => {
  const LEDGER = PACKAGES["@comforge/ledger"];
  test("has its own identity, workflow and tests, depends on nothing and is consumed from npm", () => {
    expect(profileOf("ledger")).toBe(LEDGER);
    expect(LEDGER).toMatchObject({
      dir: "packages/ledger",
      tagPrefix: "ledger/v",
      releaseBranch: "releases/ledger",
      npmWorkflow: ".github/workflows/npm-publish-ledger.yml",
      dependsOn: [],
      consumedDownstream: true,
    });
    const manifest = JSON.parse(readFileSync(path.join(REPO, LEDGER.dir, "package.json"), "utf8"));
    // The version moves with each version PR; only its form and the example's pin are fixed here.
    expect(manifest).toMatchObject({ name: "@comforge/ledger", private: true });
    expect(manifest.version).toMatch(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
    expect(manifest.dependencies).toBeUndefined();
    const example = JSON.parse(readFileSync(path.join(REPO, LEDGER.example, "package.json"), "utf8"));
    expect(example.dependencies).toEqual({ "@comforge/ledger": manifest.version });
  });

  test("its npm workflow publishes only @comforge/ledger, from ledger/v tags, through its own environment", () => {
    const text = readFileSync(path.join(REPO, "tooling/release/assets/npm-publish-ledger.yml"), "utf8");
    const wf = Bun.YAML.parse(text) as { on: { push: { tags: string[] } }; jobs: Record<string, { environment?: string }> };
    expect(wf.on.push.tags).toEqual(["ledger/v*"]);
    expect(wf.jobs.publish?.environment).toBe("npm-ledger");
    expect(text).toContain("--package @comforge/ledger");
    expect(text).not.toMatch(/@comforge\/(core|github)\b/);
  });

  test("the release workflow can build its candidate and runs its tests", () => {
    const text = readFileSync(path.join(REPO, ".github/workflows/release.yml"), "utf8");
    expect(text).toContain("options: [core, github, ledger, cli, mcp]");
    expect(text).toContain("packages/mcp/test");
    expect(text).toContain("tests/mcp");
    expect(text).toContain("packages/ledger/test");
    expect(text).toContain("tests/ledger");
  });
});

describe("the @comforge/cli profile", () => {
  const CLI = PACKAGES["@comforge/cli"];
  test("has its own identity, workflow and tests, depends on the three published packages and is pinned from npm", () => {
    expect(profileOf("cli")).toBe(CLI);
    expect(CLI).toMatchObject({
      dir: "packages/cli",
      tagPrefix: "cli/v",
      releaseBranch: "releases/cli",
      npmWorkflow: ".github/workflows/npm-publish-cli.yml",
      dependsOn: ["@comforge/core", "@comforge/github", "@comforge/ledger"],
      consumedDownstream: true,
    });
    const manifest = JSON.parse(readFileSync(path.join(REPO, CLI.dir, "package.json"), "utf8"));
    expect(manifest).toMatchObject({ name: "@comforge/cli", private: true, bin: { comforge: "./src/cli.ts" } });
    expect(manifest.version).toMatch(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
    // Exact versions, and exactly the ones the consumer pinned after reading each release back.
    // Each is the pinned release, or an unreleased sibling candidate the planner refuses to
    // version until it is published and pinned (dependency order, tooling/release/candidates.ts).
    const candidates = candidateDependencies(CLI.name);
    for (const dep of CLI.dependsOn) if (!candidates.includes(dep)) expect(manifest.dependencies[dep]).toBe(pinnedVersion(dep));
    const example = JSON.parse(readFileSync(path.join(REPO, CLI.example, "package.json"), "utf8"));
    expect(example.dependencies).toEqual({ "@comforge/cli": manifest.version });
  });

  test("its npm workflow publishes only @comforge/cli, from cli/v tags, through its own environment", () => {
    const text = readFileSync(path.join(REPO, "tooling/release/assets/npm-publish-cli.yml"), "utf8");
    const wf = Bun.YAML.parse(text) as { on: { push: { tags: string[] } }; jobs: Record<string, { environment?: string }> };
    expect(wf.on.push.tags).toEqual(["cli/v*"]);
    expect(wf.jobs.publish?.environment).toBe("npm-cli");
    expect(text).toContain("--package @comforge/cli");
    expect(text).not.toMatch(/@comforge\/(core|github|ledger)\b/);
  });
});

describe("the @comforge/mcp profile", () => {
  const MCP = PACKAGES["@comforge/mcp"];
  test("has its own identity, workflow and tests, depends on published packages and is installed (local read-only host)", () => {
    expect(profileOf("mcp")).toBe(MCP);
    expect(MCP).toMatchObject({
      dir: "packages/mcp",
      tagPrefix: "mcp/v",
      releaseBranch: "releases/mcp",
      npmWorkflow: ".github/workflows/npm-publish-mcp.yml",
      dependsOn: ["@comforge/core", "@comforge/github", "@comforge/ledger", "@comforge/cli"],
      consumedDownstream: true,
    });
    const manifest = JSON.parse(readFileSync(path.join(REPO, MCP.dir, "package.json"), "utf8"));
    expect(manifest).toMatchObject({ name: "@comforge/mcp", private: true, bin: { "comforge-mcp": "./src/bin.ts" } });
    // Exactly the versions the consumer pinned after reading each release back.
    // Each is the pinned release, or an unreleased sibling candidate the planner refuses to
    // version until it is published and pinned (dependency order, tooling/release/candidates.ts).
    // In this workspace an unreleased sibling candidate is pinned at its own workspace version
    // (the root node_modules links the workspace, so candidateDependencies cannot tell it apart).
    const candidates = candidateDependencies(MCP.name);
    const workspaceVersion = (dep: string) =>
      (JSON.parse(readFileSync(path.join(REPO, profileOf(dep).dir, "package.json"), "utf8")) as { version: string }).version;
    for (const dep of MCP.dependsOn) if (!candidates.includes(dep)) expect([pinnedVersion(dep), workspaceVersion(dep)]).toContain(manifest.dependencies[dep]);
    const example = JSON.parse(readFileSync(path.join(REPO, MCP.example, "package.json"), "utf8"));
    expect(example.dependencies["@comforge/mcp"]).toBe(manifest.version);
  });

  test("its npm workflow publishes only @comforge/mcp, from mcp/v tags, through its own environment", () => {
    const text = readFileSync(path.join(REPO, "tooling/release/assets/npm-publish-mcp.yml"), "utf8");
    const wf = Bun.YAML.parse(text) as { on: { push: { tags: string[] } }; jobs: Record<string, { environment?: string }> };
    expect(wf.on.push.tags).toEqual(["mcp/v*"]);
    expect(wf.jobs.publish?.environment).toBe("npm-mcp");
    expect(text).toContain("--package @comforge/mcp");
    expect(text).not.toMatch(/@comforge\/(core|github|ledger|cli)\b/);
  });
});

describe("intents across packages", () => {
  const base = { schema: INTENT_SCHEMA, bump: "patch", summary: "A fix.", breaking: null, covers: [] };
  test("an intent names one package, or several distinct ones; never an unknown one", () => {
    expect(ReleaseIntentSchema.safeParse({ ...base, package: "@comforge/core" }).success).toBe(true);
    expect(ReleaseIntentSchema.safeParse({ ...base, package: ["@comforge/core", "@comforge/github"] }).success).toBe(true);
    for (const bad of [[], ["@comforge/core", "@comforge/core"], ["@comforge/agents"], "@comforge/agents"])
      expect(ReleaseIntentSchema.safeParse({ ...base, package: bad }).success).toBe(false);
  });

  test("the committed first-release intent of @comforge/ledger is valid", () => {
    const file = "release-intents/2026-11-26-comforge-ledger-first-release.json";
    const intent = parseIntent(file, readFileSync(path.join(REPO, file), "utf8"));
    expect(intent).toMatchObject({ package: "@comforge/ledger", bump: "minor" });
  });

  test("the committed first-release intent of @comforge/github is valid", () => {
    const file = "release-intents/2026-11-24-comforge-github-first-release.json";
    const intent = parseIntent(file, readFileSync(path.join(REPO, file), "utf8"));
    expect(intent).toMatchObject({ package: "@comforge/github", bump: "minor" });
  });
});

// ── Planning: the evaluatePlan contract for each package ─────────────────────

const SHA = (c: string) => c.repeat(40);
const intentRecord = (file: string, pkg: string | string[], bump: string, addedIn: string, covers: string[] = []) =>
  ({
    file,
    intent: { schema: INTENT_SCHEMA, package: pkg, bump, summary: `${file} summary`, breaking: bump === "major" ? "Breaks X; migrate by Y." : null, covers },
    addedIn,
  }) as PlanInput["intents"][number];
/** One library commit that adds its own intent: the shape every covered change has. */
const declared = (file: string, pkg: string | string[], bump: string) => ({
  intents: [intentRecord(file, pkg, bump, SHA("1"))],
  commits: [{ sha: SHA("1"), subject: file, libraryChange: true, intentsAdded: [file] }],
});
const input = (over: Partial<PlanInput>): PlanInput => ({
  package: "@comforge/github",
  head: SHA("f"),
  baseline: { version: UNRELEASED, sourceCommit: SHA("0"), files: {} },
  headVersion: UNRELEASED,
  changelog: "# Changelog\n",
  candidateFiles: { "src/index.ts": "1", "dist/index.js": "2", "README.md": "3" },
  manifestChanged: true,
  exports: { before: [], after: ["createGitHubEvidence"] },
  ...declared("release-intents/gh.json", "@comforge/github", "minor"),
  editedIntents: [],
  invalidIntents: [],
  ...over,
});
const refusalOf = (fn: () => unknown) => {
  try {
    fn();
    return "ok";
  } catch (error) {
    return (error as { code?: string }).code ?? String(error);
  }
};

describe("planning each package independently", () => {
  test("a never-released package is planned from 0.0.0: its first release is a reviewed minor intent", () => {
    const plan = evaluatePlan(input({}));
    expect(plan).toMatchObject({ status: "version-pr-due", bump: "minor", currentVersion: "0.0.0", nextVersion: "0.1.0" });
    const section = plan.changelogSection as string;
    const ready = evaluatePlan(input({ headVersion: "0.1.0", changelog: `# Changelog\n\n${section}\n` }));
    expect(ready.status).toBe("release-ready");
  });

  test("a first release without an intent, or with only a patch for new exports, is refused", () => {
    expect(refusalOf(() => evaluatePlan(input({ intents: [], commits: [{ sha: SHA("1"), subject: "x", libraryChange: true, intentsAdded: [] }] })))).toBe(
      "uncovered-change",
    );
    expect(refusalOf(() => evaluatePlan(input(declared("release-intents/gh.json", "@comforge/github", "patch"))))).toBe("feature-unclassified");
  });

  test("a github-only change never moves core, and a core intent never covers a github change", () => {
    const corePlan = evaluatePlan({
      ...input({}),
      package: "@comforge/core",
      baseline: { version: "0.1.2", sourceCommit: SHA("0"), files: { "src/index.ts": "c" } },
      headVersion: "0.1.2",
      changelog: "## 0.1.2\n",
      candidateFiles: { "src/index.ts": "c" },
      manifestChanged: false,
      exports: { before: ["a"], after: ["a"] },
      commits: [{ sha: SHA("1"), subject: "github work", libraryChange: false, intentsAdded: ["release-intents/gh.json"] }],
    });
    expect(corePlan).toMatchObject({ status: "no-release", bump: "none", nextVersion: null });
    const coreIntentOnly = input(declared("release-intents/core.json", "@comforge/core", "minor"));
    expect(refusalOf(() => evaluatePlan(coreIntentOnly))).toBe("uncovered-change");
  });

  test("one intent naming both packages releases each at its own next version", () => {
    const both = declared("release-intents/both.json", ["@comforge/core", "@comforge/github"], "patch");
    const gh = evaluatePlan(
      input({
        baseline: { version: "0.1.0", sourceCommit: SHA("0"), files: { "src/index.ts": "0" } },
        headVersion: "0.1.0",
        candidateFiles: { "src/index.ts": "1" },
        manifestChanged: false,
        exports: { before: ["a"], after: ["a"] },
        ...both,
      }),
    );
    const core = evaluatePlan(
      input({
        package: "@comforge/core",
        baseline: { version: "0.1.2", sourceCommit: SHA("0"), files: { "src/index.ts": "0" } },
        headVersion: "0.1.2",
        candidateFiles: { "src/index.ts": "1" },
        manifestChanged: false,
        exports: { before: ["a"], after: ["a"] },
        ...both,
      }),
    );
    expect([gh.nextVersion, core.nextVersion]).toEqual(["0.1.1", "0.1.3"]);
    expect(gh.digest).not.toBe(core.digest);
  });

  test("a core breaking change is a pre-1.0 minor, and caret ranges tell which dependents still fit", () => {
    expect(applyBump("0.1.2", "major")).toBe("0.2.0");
    expect(satisfiesRange("0.1.3", "^0.1.2")).toBe(true);
    expect(satisfiesRange("0.2.0", "^0.1.2")).toBe(false);
    expect(satisfiesRange("0.1.1", "^0.1.2")).toBe(false);
    expect(satisfiesRange("1.4.0", "^1.2.3")).toBe(true);
    expect(satisfiesRange("2.0.0", "^1.2.3")).toBe(false);
    expect(satisfiesRange("0.0.4", "^0.0.3")).toBe(false);
    expect(satisfiesRange("0.1.2", "0.1.2")).toBe(true);
    expect(satisfiesRange("0.2.3", "^0.1.2 || ^0.2.0")).toBe(true);
    expect(satisfiesRange("0.3.0", "^0.1.2 || ^0.2.0")).toBe(false);
    expect(satisfiesRange("0.1.2", ">=0.1")).toBeNull();
  });

  test("a version already on the registry is refused for that package", () => {
    expect(refusalOf(() => evaluatePlan(input({ publishedVersions: ["0.1.0"] })))).toBe("version-published");
  });

  // offline (the publisher's candidate job), a committed release record
  // is the same fact, so a released-but-not-yet-adopted version is never planned again.
  test("a version with a committed release record is refused offline too", () => {
    expect(refusalOf(() => evaluatePlan(input({ releasedVersions: ["0.1.0"] })))).toBe("version-published");
    expect(evaluatePlan(input({ releasedVersions: ["0.0.9"] })).nextVersion).toBe("0.1.0");
  });
});

// ── Candidates and the mirror: the github package at the committed head ──────

describe("the @comforge/github candidate", () => {
  let work: string;
  let candidate: Candidate;
  const head = git(REPO, ["rev-parse", "HEAD"]);
  const committed = git(REPO, ["cat-file", "-t", `${head}:${GITHUB.dir}/package.json`], true) === "blob";

  beforeAll(() => {
    work = mkdtempSync(path.join(tmpdir(), "comforge-github-candidate-"));
    if (committed)
      candidate = buildCandidate({
        repo: REPO,
        sourceCommit: head,
        outDir: path.join(work, "a"),
        stagingRoot: path.join(REPO, "generated", "multi-package-staging"),
        profile: GITHUB,
        planning: true,
      });
  }, 180_000);
  afterAll(() => {
    rmSync(work, { recursive: true, force: true });
    rmSync(path.join(REPO, "generated", "multi-package-staging"), { recursive: true, force: true });
  });

  test.skipIf(!committed)("is named, tagged and laid out as @comforge/github, with only its own npm workflow", () => {
    expect(candidate.release).toMatchObject({ package: "@comforge/github", tag: `github/v${candidate.release.version}` });
    const files = listFiles(candidate.dir);
    expect(files).toContain(".github/workflows/npm-publish-github.yml");
    expect(files).not.toContain(".github/workflows/npm-publish.yml");
    expect(files.filter((f) => !isOwnedBy(GITHUB, f))).toEqual([]);
    expect(files.some((f) => f.startsWith("examples/github-consumer/"))).toBe(true);
    expect(scanForDisclosure(candidate.dir)).toEqual([]);
  });

  test.skipIf(!committed)("ships the licence in its npm tarball", () => {
    const listed = spawnSync("tar", ["-tzf", candidate.tarball], { encoding: "utf8" }).stdout.split("\n");
    expect(listed).toContain("package/LICENSE");
    expect(listed).toContain("package/dist/index.d.ts");
    expect(listed.some((f) => f.startsWith("package/src/"))).toBe(false);
  });

  test.skipIf(!committed)("cannot be synced onto the core release branch", () => {
    const dest = path.join(work, "dest");
    git(work, ["init", "-q", "-b", "releases/core", dest]);
    expect(() => planSync(candidate.dir, dest)).toThrow(ReleaseRefusal);
    try {
      planSync(candidate.dir, dest);
    } catch (error) {
      expect((error as ReleaseRefusal).code).toBe("destination-branch");
    }
  });

  test.skipIf(!committed)("a dry run rehearses on github's own branch, never core's", () => {
    // A release-numbered copy of the planning candidate, its records rewritten consistently.
    const dir = path.join(work, "versioned");
    spawnSync("cp", ["-R", candidate.dir, dir]);
    const hash = (f: string) => new Bun.CryptoHasher("sha256").update(readFileSync(path.join(dir, f))).digest("hex");
    const manifest = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
    writeFileSync(path.join(dir, "package.json"), `${JSON.stringify({ ...manifest, version: "0.1.0" }, null, 2)}\n`);
    const release = JSON.parse(readFileSync(path.join(dir, RELEASE_FILE), "utf8"));
    release.version = "0.1.0";
    release.tag = "github/v0.1.0";
    release.files = Object.fromEntries(
      listFiles(dir)
        .filter((f) => f !== RELEASE_FILE && f !== OWNERSHIP_FILE)
        .map((f) => [f, hash(f)]),
    );
    writeFileSync(path.join(dir, RELEASE_FILE), `${JSON.stringify(release, null, 2)}\n`);
    const owned = Object.fromEntries(
      listFiles(dir)
        .filter((f) => f !== OWNERSHIP_FILE)
        .map((f) => [f, hash(f)]),
    );
    writeFileSync(path.join(dir, OWNERSHIP_FILE), `${JSON.stringify({ schema: OWNERSHIP_SCHEMA, files: owned }, null, 2)}\n`);
    // A mirror checkout on main that already carries core's release branch.
    const dest = path.join(work, "dry-dest");
    git(work, ["init", "-q", "-b", "main", dest]);
    writeFileSync(path.join(dest, "NOTES.md"), "owner\n");
    git(dest, ["add", "NOTES.md"]);
    git(dest, ["-c", "user.name=o", "-c", "user.email=o@example.invalid", "commit", "-q", "-m", "notes"]);
    git(dest, ["branch", "releases/core"]);
    const scratch = mkdtempSync(path.join(work, "scratch-"));
    const { outcome } = dryRunRelease(dir, dest, scratch);
    expect(outcome.tag).toBe("github/v0.1.0");
    expect(outcome.plan.write).toContain(".github/workflows/npm-publish-github.yml");
    expect(git(dest, ["symbolic-ref", "--short", "HEAD"])).toBe("main");
  });

  test("a release build refuses the unreleased placeholder version, and builds a released one", () => {
    if (!committed) return;
    // Whatever the committed version is: 0.0.0 before the first version PR, a release after it.
    const version = (JSON.parse(git(REPO, ["show", `${head}:${GITHUB.dir}/package.json`])) as { version: string }).version;
    const build = () =>
      buildCandidate({
        repo: REPO,
        sourceCommit: head,
        outDir: path.join(work, "b"),
        stagingRoot: path.join(REPO, "generated", "multi-package-staging"),
        profile: GITHUB,
      });
    if (version === "0.0.0") expect(build).toThrow(/0\.0\.0 is the unreleased placeholder/);
    else expect(build().release).toMatchObject({ version, tag: `github/v${version}` });
  }, 120_000);
});

// ── The mirror's npm helper and provenance, per package ──────────────────────

describe("npm publication identity per package", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "npm-identity-"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const releaseDir = (record: Record<string, unknown>) => {
    const d = mkdtempSync(path.join(dir, "r-"));
    writeFileSync(path.join(d, "RELEASE.json"), JSON.stringify({ schema: "comforge-release/v1", files: { LICENSE: "x" }, ...record }));
    writeFileSync(path.join(d, "package.json"), JSON.stringify({ name: record.package, version: record.version }));
    return d;
  };
  const code = (fn: () => unknown) => {
    try {
      fn();
      return "ok";
    } catch (error) {
      return (error as { code?: string }).code;
    }
  };

  test("a release is verified against its own package's tag prefix and the workflow's package", () => {
    expect(code(() => verifyRelease({ releaseDir: releaseDir({ package: "@comforge/github", version: "0.1.0", tag: "core/v0.1.0" }) }))).toBe("tag-mismatch");
    expect(
      code(() =>
        verifyRelease({ releaseDir: releaseDir({ package: "@comforge/core", version: "0.1.3", tag: "core/v0.1.3" }), packageName: "@comforge/github" }),
      ),
    ).toBe("package-mismatch");
    expect(code(() => verifyRelease({ releaseDir: releaseDir({ package: "@comforge/agents", version: "0.1.0", tag: "agents/v0.1.0" }) }))).toBe(
      "package-mismatch",
    );
  });

  test("provenance for github must name github's workflow; core's workflow does not count", () => {
    const integrity = `sha512-${Buffer.from("ab", "hex").toString("base64")}`;
    const statement = (workflow: string) => ({
      subject: [{ name: "pkg:npm/%40comforge/github@0.1.0", digest: { sha512: "ab" } }],
      predicate: {
        buildDefinition: {
          externalParameters: { workflow: { repository: "https://github.com/o/comforge", path: workflow, ref: "refs/tags/github/v0.1.0" } },
          resolvedDependencies: [{ digest: { gitCommit: "c".repeat(40) } }],
        },
      },
    });
    const ctx = { name: "@comforge/github", version: "0.1.0", integrity, repository: "o/comforge", tag: "github/v0.1.0", commit: "c".repeat(40) };
    expect(checkProvenance(statement(GITHUB.npmWorkflow), ctx)).toEqual([]);
    expect(checkProvenance(statement(CORE.npmWorkflow), ctx)).toEqual(["workflow path"]);
  });
});

describe("the publish workflow follows the registry", () => {
  const wf = Bun.YAML.parse(readFileSync(path.join(REPO, ".github/workflows/release.yml"), "utf8")) as {
    on: { workflow_dispatch: { inputs: { package: { options: string[] } } } };
    jobs: { candidate: { steps: { run?: string }[] } };
  };
  test("its package choices are exactly the registry ids", () => {
    expect(wf.on.workflow_dispatch.inputs.package.options).toEqual(Object.values(PACKAGES).map((p) => p.id));
  });
  test("every candidate job runs every package's suites", () => {
    const run = wf.jobs.candidate.steps.map((s) => s.run ?? "").find((r) => r.includes("bun test")) ?? "";
    for (const suite of allTests()) expect(run.split(/\s+/)).toContain(suite);
  });
});

test("every package's shipped source, documents and example pass the disclosure scan, as they are now", () => {
  // The release scans the candidate built from a commit, in CI; this catches a private path
  // in a README, llms.txt, CHANGELOG, source file or example before it is committed (a README
  // line once pointed at a private document and refused the candidate build).
  for (const p of Object.values(PACKAGES)) {
    const dir = mkdtempSync(path.join(tmpdir(), `shipped-${p.id}-`));
    try {
      for (const name of ["README.md", "llms.txt", "CHANGELOG.md", "LICENSE", "src"])
        if (existsSync(path.join(REPO, p.dir, name))) cpSync(path.join(REPO, p.dir, name), path.join(dir, p.dir, name), { recursive: true });
      cpSync(path.join(REPO, p.example), path.join(dir, p.example), {
        recursive: true,
        filter: (src) => !src.includes(`${path.sep}node_modules`),
      });
      expect({ package: p.name, findings: scanForDisclosure(dir) }).toEqual({ package: p.name, findings: [] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("every package's shipped release assets pass the disclosure scan, as they are now", () => {
  // The scan runs on candidates built from commits; this catches a private path in an
  // asset before it is committed (a comment once named private files).
  for (const p of Object.values(PACKAGES)) {
    const dir = mkdtempSync(path.join(tmpdir(), `assets-${p.id}-`));
    try {
      for (const [dest, src] of Object.entries(p.assets)) {
        mkdirSync(path.dirname(path.join(dir, dest)), { recursive: true });
        writeFileSync(path.join(dir, dest), readFileSync(path.join(REPO, src)));
      }
      expect(scanForDisclosure(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("the mirror workflows", () => {
  const read = (file: string) => readFileSync(path.join(REPO, "tooling/release/assets", file), "utf8");
  test("core's npm workflow is byte for byte the one already released (no workflow change for core)", () => {
    const pinned = JSON.parse(readFileSync(path.join(REPO, CORE.pinDir, "RELEASE.json"), "utf8")) as { files: Record<string, string> };
    const digest = new Bun.CryptoHasher("sha256").update(read("npm-publish.yml")).digest("hex");
    expect(digest).toBe(pinned.files[CORE.npmWorkflow] as string);
  });

  test("github's npm workflow triggers only on github tags, binds the package and refuses a bootstrap", () => {
    const wf = Bun.YAML.parse(read("npm-publish-github.yml")) as { on: { push: { tags: string[] } }; jobs: Record<string, { environment?: string }> };
    expect(wf.on.push.tags).toEqual(["github/v*"]);
    expect(wf.jobs.publish?.environment).toBe("npm-github");
    const text = read("npm-publish-github.yml");
    expect(text).toContain("--package @comforge/github");
    expect(text).toContain("releases/github:refs/remotes/origin/releases/github");
    expect(text).toContain("bootstrapRequired");
    expect(text).not.toMatch(/core\/v\(0/);
  });
});

describe("consumer update", () => {
  // Every registry package is adopted today, so the `not-consumed` refusal has no live input; the
  // decision for an adopted package is the same pure rule as for core.
  test("the adopted github package moves only to an exact version on the registry", () => {
    const published = ["0.0.0-stage", "0.1.0"];
    const decide = (target: string, rollback = false) => decideConsumerUpdate({ package: GITHUB.name, current: "0.1.0", target, published, rollback });
    expect(decide("0.1.0")).toEqual({ action: "current", version: "0.1.0" });
    expect(() => decide("0.1.1")).toThrow("not-published");
    expect(() => decide("0.0.0-stage")).toThrow("malformed-version");
    expect(GITHUB.consumedDownstream).toBe(true);
  });
});

// ── Owner authorization cannot cross packages ────────────────────────────────

describe("signed approval is bound to one package", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const trust = parseTrust({ schema: TRUST_SCHEMA, keys: [{ keyId: keyIdFor(pem), publicKeyPem: pem, login: "owner", label: "o" }], revoked: [] });
  const SOURCE = SHA("a");
  const plan = (pkg: "@comforge/core" | "@comforge/github") =>
    evaluatePlan(
      input({
        package: pkg,
        head: SOURCE,
        baseline: { version: "0.1.2", sourceCommit: SHA("0"), files: { "src/index.ts": "0" } },
        headVersion: "0.1.3",
        changelog: "",
        candidateFiles: { "src/index.ts": "1" },
        manifestChanged: false,
        exports: { before: ["a"], after: ["a"] },
        ...declared("release-intents/x.json", pkg, "patch"),
      }),
    );
  // Deliberately misleading: same source commit, same version, same release-record digest.
  const candidateOf = (pkg: "@comforge/core" | "@comforge/github"): ReturnType<typeof buildCandidateRecord> => {
    const p = profileOf(pkg);
    const rebuilt: CandidateInput = {
      package: pkg,
      version: "0.1.3",
      tag: `${p.tagPrefix}0.1.3`,
      sourceCommit: SOURCE,
      releaseRecordSha256: "e".repeat(64),
      tarball: { sha256: "f".repeat(64), integrity: "sha512-x" },
      fileCount: 40,
      workflowChanges: [],
      workflowApproval: null,
      plan: plan(pkg),
      ci: { ok: true, checks: [{ name: "Validate (test:verify)", conclusion: "success" }] },
    };
    return buildCandidateRecord(rebuilt);
  };
  const core = candidateOf("@comforge/core");
  const github = candidateOf("@comforge/github");
  const NOW = new Date();
  const sign = (candidate: typeof core) =>
    signAuthorization(
      buildAuthorization({
        candidate,
        workflowSha256: "9".repeat(64),
        repository: ENGINEERING_REPOSITORY_SLUG,
        issuer: "owner",
        authorizationId: randomUUID(),
        nonce: randomBytes(16).toString("hex"),
        candidateRun: 1,
        now: NOW,
      }),
      privateKey,
    );
  const verify = (envelope: unknown, candidate: typeof core) => {
    try {
      verifyReleaseAuthorization(envelope, {
        trust,
        repository: ENGINEERING_REPOSITORY_SLUG,
        candidate,
        workflowSha256: "9".repeat(64),
        triggeringActor: "owner",
        approveWorkflows: "",
        now: NOW,
      });
      return "authorized";
    } catch (error) {
      if (error instanceof AuthorizationRefusal) return `${error.code}: ${error.message}`;
      throw error;
    }
  };

  test("each package's approval verifies for that package only", () => {
    expect(verify(sign(core), core)).toBe("authorized");
    expect(verify(sign(github), github)).toBe("authorized");
    const crossed = verify(sign(core), github);
    expect(crossed).toStartWith("authorization-mismatch");
    for (const field of ["package", "tag", "candidateDigest"]) expect(crossed).toContain(field);
    expect(verify(sign(github), core)).toStartWith("authorization-mismatch");
  });

  test("a dispatch for one package cannot carry the other's approval", () => {
    const a = sign(core).authorization;
    const base = { authorization: a, authorizationIdInput: a.authorizationId, runAttempt: "1", sha: SOURCE, workflowSha: SOURCE };
    expect(() => verifyDispatch({ ...base, packageInput: "core" })).not.toThrow();
    expect(() => verifyDispatch({ ...base, packageInput: "github" })).toThrow(/publishes @comforge\/github; the owner authorized @comforge\/core/);
    expect(() => verifyDispatch({ ...base, packageInput: "agents" })).toThrow(/not a registry package/);
    expect(() => verifyDispatch({ ...base, packageInput: undefined })).toThrow(/not a registry package/);
  });
});

// The github pin is written by `npm-readback --commit <release> --write-pin` after a verified
// registry readback; until the first release it is absent. Once present it must stay bound to
// its Git release record and to the version committed in the package source.
test("the github pin, when present, is tied to its release record and never ahead of the committed version", () => {
  mkdirSync(path.join(REPO, "generated"), { recursive: true });
  const dir = path.join(REPO, GITHUB.pinDir);
  if (!existsSync(path.join(dir, "RELEASE.json"))) return;
  const pinRaw = readFileSync(path.join(dir, "npm-pin.json"), "utf8");
  const pin = JSON.parse(pinRaw) as {
    package: string;
    version: string;
    gitRelease: { tag: string; releaseRecordSha256: string };
  };
  const release = JSON.parse(readFileSync(path.join(dir, "RELEASE.json"), "utf8")) as {
    package: string;
    version: string;
    tag: string;
  };
  const recordDigest = new Bun.CryptoHasher("sha256").update(readFileSync(path.join(dir, "RELEASE.json"))).digest("hex");
  const committed = JSON.parse(readFileSync(path.join(REPO, GITHUB.dir, "package.json"), "utf8")) as { version: string };
  expect(recordDigest).toBe(pin.gitRelease.releaseRecordSha256);
  expect([pin.package, pin.gitRelease.tag]).toEqual([GITHUB.name, `${GITHUB.tagPrefix}${pin.version}`]);
  // A version PR raises the committed version before its release exists; the pin follows only
  // after publication and readback, so it may trail the committed version but never lead it.
  const parts = (v: string) => v.split(".").map(Number) as [number, number, number];
  const [c, p] = [parts(committed.version), parts(pin.version)];
  expect(c[0] - p[0] || c[1] - p[1] || c[2] - p[2]).toBeGreaterThanOrEqual(0);
  expect([release.package, release.version, release.tag]).toEqual([pin.package, pin.version, pin.gitRelease.tag]);
});
