import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { releasedDir, releaseRecordOf, unreleasedDependencies } from "../../tooling/release/candidates";
import { groupBranch, parseTargets } from "../../tooling/release/consumerUpdate";
import { PACKAGES } from "../../tooling/release/packages";
import { parseCampaign } from "../../tooling/release/releaseCampaign";

// a sibling released ahead of its adoption group counts as
// released for planning only through a committed, verified record of exactly the declared
// version, built from the source still at the planned head.

const root = mkdtempSync(path.join(tmpdir(), "release-record-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const git = (...args: string[]) => {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
};
const write = (file: string, content: string) => {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  writeFileSync(path.join(root, file), content);
};
const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;

git("init", "-q", "-b", "main");
git("config", "user.email", "t@example.invalid");
git("config", "user.name", "t");
write("packages/core/package.json", json({ name: "@comforge/core", version: "0.2.0" }));
write("packages/core/src/index.ts", "export const a = 1;\n");
write("packages/github/package.json", json({ name: "@comforge/github", version: "0.5.0", dependencies: { "@comforge/core": "^0.1.2 || ^0.2.0" } }));
write("packages/cli/package.json", json({ name: "@comforge/cli", version: "0.3.0", dependencies: { "@comforge/core": "0.2.0", "@comforge/github": "0.5.0" } }));
// The installed (pinned) releases are the previous ones: both are candidate dependencies.
write("node_modules/@comforge/core/package.json", json({ version: "0.1.2" }));
write("node_modules/@comforge/github/package.json", json({ version: "0.4.0" }));
git("add", "packages");
git("commit", "-q", "-m", "packages");
const coreTree = git("rev-parse", "HEAD:packages/core");
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
/** The release's RELEASE.json: every shipped file, `src/` included, as the mirror tag records it. */
const releaseJson = (src: string) => json({ files: { "src/index.ts": sha(src), "README.md": sha("readme"), "dist/index.js": sha("x") } });
const record = (name: string, version: string, tree: string) =>
  json({
    schema: "comforge-npm-pin/v1",
    package: name,
    version,
    integrity: `sha512-${name}`,
    gitRelease: { commit: "c".repeat(40), tag: "x", source: { commit: "d".repeat(40), packageTree: tree } },
  });

describe("released sibling records", () => {
  test("without a record both exact siblings are unreleased", () => {
    expect(unreleasedDependencies("@comforge/cli", root, "HEAD")).toEqual([
      { name: "@comforge/core", reason: "unreleased" },
      { name: "@comforge/github", reason: "unreleased" },
    ]);
  });

  test("a committed record for the declared version built from the current tree releases it", () => {
    write(`${releasedDir("@comforge/core", "0.2.0")}/npm-pin.json`, record("@comforge/core", "0.2.0", coreTree));
    write(`${releasedDir("@comforge/core", "0.2.0")}/RELEASE.json`, releaseJson("export const a = 1;\n"));
    // Uncommitted does not count: the planner reads the head.
    expect(unreleasedDependencies("@comforge/cli", root, "HEAD").map((d) => d.name)).toContain("@comforge/core");
    git("add", "releases");
    git("commit", "-q", "-m", "record");
    expect(unreleasedDependencies("@comforge/cli", root, "HEAD")).toEqual([{ name: "@comforge/github", reason: "unreleased" }]);
    expect(releaseRecordOf("@comforge/core", "0.2.0", root, "HEAD")?.integrity).toBe("sha512-@comforge/core");
  });

  test("a document change keeps the record; a source change makes it stale (drifted)", () => {
    write("packages/core/README.md", "new docs\n");
    git("add", "packages");
    git("commit", "-q", "-m", "docs");
    expect(unreleasedDependencies("@comforge/cli", root, "HEAD").map((d) => d.name)).toEqual(["@comforge/github"]);
    write("packages/core/src/index.ts", "export const a = 2;\n");
    git("commit", "-qam", "change core");
    expect(unreleasedDependencies("@comforge/cli", root, "HEAD")[0]).toEqual({
      name: "@comforge/core",
      reason: "drifted",
    });
  });

  test("a record for another version or another package releases nothing", () => {
    expect(releaseRecordOf("@comforge/core", "0.2.1", root, "HEAD")).toBeNull();
    write(`${releasedDir("@comforge/github", "0.5.0")}/npm-pin.json`, record("@comforge/core", "0.5.0", coreTree));
    git("add", "releases");
    git("commit", "-q", "-m", "wrong record");
    expect(releaseRecordOf("@comforge/github", "0.5.0", root, "HEAD")).toBeNull();
  });
});

describe("adoption groups", () => {
  test("consumer:update pairs each --package with the --version after it, and names one branch", () => {
    expect(parseTargets(["--package", "@comforge/core", "--version", "0.2.0", "--package", "github", "--version", "0.5.0", "--open"])).toEqual([
      { name: "@comforge/core", version: "0.2.0" },
      { name: "github", version: "0.5.0" },
    ]);
    expect(parseTargets(["--version", "0.1.3"])).toEqual([{ name: "@comforge/core", version: "0.1.3" }]);
    expect(parseTargets([])).toEqual([{ name: "@comforge/core", version: undefined }]);
    expect(
      groupBranch([
        { profile: PACKAGES["@comforge/core"], version: "0.2.0" },
        { profile: PACKAGES["@comforge/github"], version: "0.5.0" },
      ]),
    ).toBe("comforge-consumer/core/v0.2.0+github/v0.5.0");
    expect(groupBranch([{ profile: PACKAGES["@comforge/core"], version: "0.2.0" }])).toBe("comforge-consumer/core/v0.2.0");
  });

  test("a campaign refuses a group member it does not release, or a package in two groups", () => {
    const base = {
      schema: "comforge-release-campaign/v1",
      id: "group-campaign",
      packages: [
        { package: "@comforge/core", version: "0.2.0" },
        { package: "@comforge/github", version: "0.5.0" },
      ],
    };
    expect(() => parseCampaign({ ...base, adopt: [["@comforge/core", "@comforge/cli"]] })).toThrow(/not a campaign package/);
    expect(() =>
      parseCampaign({
        ...base,
        adopt: [
          ["@comforge/core", "@comforge/github"],
          ["@comforge/github", "@comforge/core"],
        ],
      }),
    ).toThrow(/two adoption groups/);
    expect(parseCampaign({ ...base, adopt: [["@comforge/core", "@comforge/github"]] }).adopt).toHaveLength(1);
  });
});
