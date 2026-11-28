import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  checkProvenance,
  NpmReleaseRefusal,
  plan,
  provenanceStatement,
  readback,
  registryState,
  releaseExpectation,
  verifyOnReleaseBranch,
  verifyPlannedTarball,
  verifyRelease,
  WORKFLOW_PATH,
} from "../../tooling/release/assets/npm-release.mjs";

// npm distribution of a Comforge core release (,
// ). The fixture is a Git release rebuilt from the installed npm
// package (its real dist/, README, LICENSE, llms.txt): the manifest made private again without
// `repository`, plus a CHANGELOG, an unpacked source file and a RELEASE.json recording every
// digest, committed on releases/core in a disposable repository. The registry is a fake, so
// nothing is fetched or published.

const REPO = path.resolve(import.meta.dir, "..", "..");
// A published release, never the workspace candidate: the harness installs it from npm.
const INSTALLED = path.join(REPO, "harness", "node_modules", "@comforge", "core");
const REPOSITORY = "vikramrao1994/comforge";
let work: string;
let release: string;
let commit: string;

const git = (cwd: string, args: string[]) =>
  spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { cwd, encoding: "utf8" }).stdout.trim();

type Routes = Record<string, { status: number; body?: unknown; bytes?: Uint8Array }>;
const fakeRegistry =
  (routes: Routes) =>
  async (url: string): Promise<Response> => {
    const route = routes[url] ?? { status: 404, body: { error: "Not found" } };
    if (route.bytes) return new Response(Buffer.from(route.bytes), { status: route.status });
    return new Response(JSON.stringify(route.body ?? {}), { status: route.status });
  };
const ORG = "https://registry.npmjs.org/-/org/comforge/package";
const PACKUMENT = "https://registry.npmjs.org/@comforge%2fcore";
const unpublished = fakeRegistry({ [ORG]: { status: 200, body: {} } });

async function refusal(fn: () => unknown): Promise<string> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof NpmReleaseRefusal) return error.code;
    throw error;
  }
  return "no refusal";
}

/** A copy of the release with one edit, committed so it has its own commit. */
function variant(name: string, edit: (dir: string) => void): { dir: string; commit: string } {
  const dir = path.join(work, name);
  cpSync(release, dir, { recursive: true });
  edit(dir);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", name]);
  return { dir, commit: git(dir, ["rev-parse", "HEAD"]) };
}

const digest = (file: string) => new Bun.CryptoHasher("sha256").update(readFileSync(file)).digest("hex");

/** Writes RELEASE.json recording every file in `dir` (RELEASE.json itself excluded). */
function recordRelease(dir: string) {
  const files: Record<string, string> = {};
  const walk = (rel: string) => {
    for (const entry of readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (child === ".git" || child === "RELEASE.json") continue;
      if (entry.isDirectory()) walk(child);
      else files[child] = digest(path.join(dir, child));
    }
  };
  walk("");
  const record = {
    schema: "comforge-release/v1",
    package: "@comforge/core",
    version: "0.1.0",
    tag: "core/v0.1.0",
    source: { commit: "0".repeat(40) },
    files: Object.fromEntries(Object.entries(files).sort()),
  };
  writeFileSync(path.join(dir, "RELEASE.json"), `${JSON.stringify(record, null, 2)}\n`);
}

beforeAll(() => {
  work = mkdtempSync(path.join(tmpdir(), "npm-release-test-"));
  release = path.join(work, "release");
  cpSync(INSTALLED, release, { recursive: true, dereference: true });
  const manifest = JSON.parse(readFileSync(path.join(release, "package.json"), "utf8"));
  delete manifest.repository;
  // Labelled 0.1.0 whatever version is installed: the tests' registry fixtures name 0.1.0.
  writeFileSync(path.join(release, "package.json"), `${JSON.stringify({ ...manifest, version: "0.1.0", private: true }, null, 2)}\n`);
  writeFileSync(path.join(release, "CHANGELOG.md"), "# Changelog\n\n## 0.1.0\n\nFirst release.\n");
  mkdirSync(path.join(release, "src"));
  writeFileSync(path.join(release, "src", "index.ts"), "export {};\n");
  recordRelease(release);
  git(release, ["init", "-q", "-b", "releases/core"]);
  git(release, ["add", "-A"]);
  git(release, ["commit", "-qm", "release: @comforge/core core/v0.1.0"]);
  commit = git(release, ["rev-parse", "HEAD"]);
});
afterAll(() => rmSync(work, { recursive: true, force: true }));

const planOf = (dir: string, sha: string, out: string, fetchImpl = unpublished, tag = "core/v0.1.0") =>
  plan({ releaseDir: dir, commit: sha, tag, repository: REPOSITORY, outDir: path.join(work, out), fetchImpl });

describe("planning an npm version from a verified release", () => {
  test("the package is the release's files plus a manifest without private, with the repository", async () => {
    const p = await planOf(release, commit, "plan-a");
    expect(p.package).toBe("@comforge/core");
    expect(p.version).toBe("0.1.0");
    expect(p.registry.bootstrapRequired).toBe(true);
    expect(p.manifest.transforms).toEqual(["remove private", `add repository git+https://github.com/${REPOSITORY}.git`]);
    const record = JSON.parse(readFileSync(path.join(release, "RELEASE.json"), "utf8"));
    expect(Object.keys(p.files)).toContain("LICENSE");
    expect(Object.keys(p.files).some((f) => f.startsWith("src/") || f.startsWith(".github") || f === "RELEASE.json")).toBe(false);
    for (const [file, digest] of Object.entries(p.files)) if (file !== "package.json") expect(digest).toBe(record.files[file]);
    const manifest = JSON.parse(readFileSync(path.join(work, "plan-a", "npm-manifest.json"), "utf8"));
    expect(manifest.private).toBeUndefined();
    expect(manifest.scripts).toBeUndefined();
    expect(p.gitRelease).toMatchObject({ commit, tag: "core/v0.1.0", repository: REPOSITORY });
  });

  test("planning twice is idempotent: same tarball bytes, same plan", async () => {
    const a = await planOf(release, commit, "plan-b1");
    const b = await planOf(release, commit, "plan-b2");
    expect(b).toEqual(a);
  });

  test("a version already on the registry, or older than one there, is refused", async () => {
    const published = fakeRegistry({ [ORG]: { status: 200 }, [PACKUMENT]: { status: 200, body: { versions: { "0.1.0": {} } } } });
    expect(await refusal(() => planOf(release, commit, "dup", published))).toBe("version-published");
    const newer = fakeRegistry({ [ORG]: { status: 200 }, [PACKUMENT]: { status: 200, body: { versions: { "0.2.0": {} } } } });
    expect(await refusal(() => planOf(release, commit, "old", newer))).toBe("version-regression");
  });

  test("a missing npm scope or an unavailable registry is refused, not guessed", async () => {
    expect(await refusal(() => planOf(release, commit, "noscope", fakeRegistry({ [ORG]: { status: 404 } })))).toBe("scope-missing");
    const down = fakeRegistry({ [ORG]: { status: 200 }, [PACKUMENT]: { status: 503 } });
    expect(await refusal(() => planOf(release, commit, "down", down))).toBe("registry-unavailable");
  });

  test("a wrong commit or tag is refused", async () => {
    expect(await refusal(() => planOf(release, "0".repeat(40), "sha"))).toBe("commit-mismatch");
    expect(await refusal(() => planOf(release, commit.slice(0, 12), "short"))).toBe("commit-mismatch");
    expect(await refusal(() => planOf(release, commit, "tag", unpublished, "core/v0.1.1"))).toBe("tag-mismatch");
  });

  test("changed files, a changed manifest, lifecycle scripts or a foreign repository are refused", async () => {
    const changed = variant("changed", (d) => writeFileSync(path.join(d, "dist", "lifecycle.js"), "export {};\n"));
    expect(await refusal(() => planOf(changed.dir, changed.commit, "x1"))).toBe("release-files-changed");
    const edit = (name: string, change: (m: Record<string, unknown>) => void) =>
      variant(name, (d) => {
        const m = JSON.parse(readFileSync(path.join(d, "package.json"), "utf8"));
        change(m);
        writeFileSync(path.join(d, "package.json"), `${JSON.stringify(m, null, 2)}\n`);
      });
    const bumped = edit("bumped", (m) => {
      m.version = "0.1.1";
    });
    expect(await refusal(() => planOf(bumped.dir, bumped.commit, "x2"))).toBe("manifest-mismatch");
    const hooked = edit("hooked", (m) => {
      m.scripts = { postinstall: "node evil.js" };
    });
    expect(await refusal(() => planOf(hooked.dir, hooked.commit, "x3"))).toBe("lifecycle-script");
    const foreign = edit("foreign", (m) => {
      m.repository = { type: "git", url: "git+https://github.com/someone/else.git" };
    });
    // The record digest catches the edit first; with the record rewritten, the repository check does.
    expect(await refusal(() => planOf(foreign.dir, foreign.commit, "x4"))).toBe("release-files-changed");
    const record = JSON.parse(readFileSync(path.join(foreign.dir, "RELEASE.json"), "utf8"));
    record.files["package.json"] = digest(path.join(foreign.dir, "package.json"));
    writeFileSync(path.join(foreign.dir, "RELEASE.json"), `${JSON.stringify(record, null, 2)}\n`);
    git(foreign.dir, ["commit", "-qam", "record"]);
    expect(await refusal(() => planOf(foreign.dir, git(foreign.dir, ["rev-parse", "HEAD"]), "x5"))).toBe("repository-mismatch");
  });

  test("a release without its record or with another schema is refused", async () => {
    const bare = variant("bare", (d) => rmSync(path.join(d, "RELEASE.json")));
    expect(await refusal(() => verifyRelease({ releaseDir: bare.dir, commit: bare.commit }))).toBe("release-record-missing");
    const other = variant("schema", (d) => {
      const r = JSON.parse(readFileSync(path.join(d, "RELEASE.json"), "utf8"));
      writeFileSync(path.join(d, "RELEASE.json"), JSON.stringify({ ...r, schema: "other/v9" }));
    });
    expect(await refusal(() => verifyRelease({ releaseDir: other.dir, commit: other.commit }))).toBe("malformed-release");
  });

  /** A variant whose RELEASE.json is rewritten to record the edit, so only the new check can refuse it. */
  const recorded = (name: string, edit: (dir: string) => void) =>
    variant(name, (d) => {
      edit(d);
      recordRelease(d);
    });

  test("a release without a licence file or without a changelog entry for its version is refused", async () => {
    const unlicensed = recorded("unlicensed", (d) => rmSync(path.join(d, "LICENSE")));
    expect(await refusal(() => verifyRelease({ releaseDir: unlicensed.dir, commit: unlicensed.commit }))).toBe("license-missing");
    const undocumented = recorded("undocumented", (d) => writeFileSync(path.join(d, "CHANGELOG.md"), "# Changelog\n\n## 0.0.9\n"));
    expect(await refusal(() => verifyRelease({ releaseDir: undocumented.dir, commit: undocumented.commit }))).toBe("changelog-missing");
  });

  test("a tagged commit that is not on the release branch is refused", async () => {
    const side = path.join(work, "side");
    cpSync(release, side, { recursive: true });
    git(side, ["checkout", "-qb", "elsewhere"]);
    writeFileSync(path.join(side, "NOTE.md"), "not released\n");
    git(side, ["add", "-A"]);
    git(side, ["commit", "-qm", "side"]);
    const sideCommit = git(side, ["rev-parse", "HEAD"]);
    expect(await refusal(() => verifyOnReleaseBranch({ releaseDir: side, commit: sideCommit, branchRef: "refs/heads/releases/core" }))).toBe(
      "commit-not-released",
    );
    verifyOnReleaseBranch({ releaseDir: side, commit, branchRef: "refs/heads/releases/core" });
  });
});

describe("publishing and reading back", () => {
  let planned: Awaited<ReturnType<typeof planOf>>;
  let planFile: string;
  let tarball: string;
  beforeAll(async () => {
    planned = await planOf(release, commit, "plan-pub");
    planFile = path.join(work, "plan-pub", "npm-plan.json");
    tarball = path.join(work, "plan-pub", planned.tarball.file);
  });

  test("only the planned bytes pass the pre-publish check, and only while the version is unpublished", async () => {
    expect((await verifyPlannedTarball({ planFile, tarball, fetchImpl: unpublished })).version).toBe("0.1.0");
    const other = path.join(work, "other.tgz");
    writeFileSync(other, "not the tarball");
    expect(await refusal(() => verifyPlannedTarball({ planFile, tarball: other, fetchImpl: unpublished }))).toBe("tarball-content-mismatch");
    const raced = fakeRegistry({ [ORG]: { status: 200 }, [PACKUMENT]: { status: 200, body: { versions: { "0.1.0": {} } } } });
    expect(await refusal(() => verifyPlannedTarball({ planFile, tarball, fetchImpl: raced }))).toBe("version-published");
  });

  const TARBALL_URL = "https://registry.npmjs.org/@comforge/core/-/core-0.1.0.tgz";
  const ATTESTATIONS = "https://registry.npmjs.org/-/npm/v1/attestations/@comforge%2fcore@0.1.0";
  const served = (bytes: Uint8Array, integrity: string, attestations?: unknown) =>
    fakeRegistry({
      [PACKUMENT]: {
        status: 200,
        body: { versions: { "0.1.0": { dist: { integrity, tarball: TARBALL_URL, ...(attestations ? { attestations: { url: ATTESTATIONS } } : {}) } } } },
      },
      [TARBALL_URL]: { status: 200, bytes },
      ...(attestations ? { [ATTESTATIONS]: { status: 200, body: attestations } } : {}),
    });
  const statement = (overrides: { commit?: string; ref?: string; digest?: string } = {}) => ({
    subject: [
      {
        name: "pkg:npm/%40comforge/core@0.1.0",
        digest: { sha512: overrides.digest ?? Buffer.from(planned.tarball.integrity.slice(7), "base64").toString("hex") },
      },
    ],
    predicate: {
      buildDefinition: {
        externalParameters: {
          workflow: { repository: `https://github.com/${REPOSITORY}`, path: WORKFLOW_PATH, ref: overrides.ref ?? "refs/tags/core/v0.1.0" },
        },
        resolvedDependencies: [{ digest: { gitCommit: overrides.commit ?? commit } }],
      },
    },
  });
  const attestationsOf = (s: unknown) => ({
    attestations: [
      { predicateType: "https://slsa.dev/provenance/v1", bundle: { dsseEnvelope: { payload: Buffer.from(JSON.stringify(s)).toString("base64") } } },
    ],
  });

  test("a published version matching the plan reads back; other bytes do not", async () => {
    const bytes = readFileSync(tarball);
    const ok = await readback({ planFile, fetchImpl: served(bytes, planned.tarball.integrity) });
    expect(ok.pass).toBe(true);
    const bad = await readback({ planFile, fetchImpl: served(new Uint8Array(bytes).reverse(), planned.tarball.integrity) });
    expect(bad.pass).toBe(false);
    expect(await refusal(() => readback({ planFile, fetchImpl: fakeRegistry({}) }))).toBe("readback-failed");
  });

  test("provenance must bind the tarball to this repository, workflow, tag and release commit", async () => {
    const bytes = readFileSync(tarball);
    const good = await readback({ planFile, expectProvenance: true, fetchImpl: served(bytes, planned.tarball.integrity, attestationsOf(statement())) });
    expect(good.checks.find((c) => c.check === "provenance")).toMatchObject({ pass: true });
    const missing = await readback({ planFile, expectProvenance: true, fetchImpl: served(bytes, planned.tarball.integrity) });
    expect(missing.pass).toBe(false);
    const ctx = { name: "@comforge/core", version: "0.1.0", integrity: planned.tarball.integrity, repository: REPOSITORY, tag: "core/v0.1.0", commit };
    expect(checkProvenance(provenanceStatement(attestationsOf(statement())), ctx)).toEqual([]);
    expect(checkProvenance(statement({ commit: "f".repeat(40) }), ctx)).toEqual(["source commit"]);
    expect(checkProvenance(statement({ ref: "refs/heads/main" }), ctx)).toEqual(["workflow ref"]);
    expect(checkProvenance(statement({ digest: "00" }), ctx)).toEqual(["subject digest"]);
  });

  test("a release expectation reads back the registry's tarball without a plan, file by file", async () => {
    const { expectation } = releaseExpectation({ releaseDir: release, commit, tag: "core/v0.1.0", repository: REPOSITORY });
    expect(expectation.tarball.integrity).toBeNull();
    expect(expectation.files).toEqual(planned.files);
    const bytes = readFileSync(tarball);
    const ok = await readback({ plan: expectation, fetchImpl: served(bytes, planned.tarball.integrity) });
    expect(ok.pass).toBe(true);
    // Bytes that do not match the registry's own integrity fail before any file is trusted.
    const swapped = await readback({ plan: expectation, fetchImpl: served(new Uint8Array(bytes).reverse(), planned.tarball.integrity) });
    expect(swapped.checks.find((c) => c.check === "tarball-integrity")?.pass).toBe(false);
    // A tarball consistent with its integrity but holding other content fails the file check.
    const repack = path.join(work, "repack");
    mkdirSync(repack);
    spawnSync("tar", ["-xzf", tarball, "-C", repack]);
    writeFileSync(path.join(repack, "package", "README.md"), "other\n");
    spawnSync("tar", ["-czf", path.join(work, "repacked.tgz"), "-C", repack, "package"]);
    const fake = readFileSync(path.join(work, "repacked.tgz"));
    const fakeIntegrity = `sha512-${new Bun.CryptoHasher("sha512").update(fake).digest("base64")}`;
    const corrupt = await readback({ plan: expectation, fetchImpl: served(fake, fakeIntegrity) });
    expect(corrupt.checks.find((c) => c.check === "tarball-integrity")?.pass).toBe(true);
    expect(corrupt.checks.find((c) => c.check === "files-match-release")).toMatchObject({ pass: false, detail: "26 files, 1 differ: README.md" });
    expect(await refusal(() => readback({ plan: { ...expectation, schema: "other/v1" }, fetchImpl: served(bytes, planned.tarball.integrity) }))).toBe(
      "malformed-plan",
    );
  });

  test("with an expectation, provenance must name the registry's integrity", async () => {
    const { expectation } = releaseExpectation({ releaseDir: release, commit, tag: "core/v0.1.0", repository: REPOSITORY });
    const bytes = readFileSync(tarball);
    const good = await readback({
      plan: expectation,
      expectProvenance: true,
      fetchImpl: served(bytes, planned.tarball.integrity, attestationsOf(statement())),
    });
    expect(good.pass).toBe(true);
    const wrong = await readback({
      plan: expectation,
      expectProvenance: true,
      fetchImpl: served(bytes, planned.tarball.integrity, attestationsOf(statement({ digest: "00" }))),
    });
    expect(wrong.checks.find((c) => c.check === "provenance")).toMatchObject({ pass: false, detail: "subject digest" });
  });

  test("registry state reports a bootstrap for a package that does not exist yet", async () => {
    expect(await registryState({ name: "@comforge/core", version: "0.1.0", fetchImpl: unpublished })).toEqual({
      exists: false,
      versions: [],
      bootstrapRequired: true,
    });
  });
});

describe("the release workflow", () => {
  const workflow = readFileSync(path.join(REPO, "tooling", "release", "assets", "npm-publish.yml"), "utf8");
  const job = (name: string) =>
    workflow.slice(
      workflow.indexOf(`  ${name}:\n`),
      workflow.indexOf("\n  publish:\n") > workflow.indexOf(`  ${name}:\n`) ? workflow.indexOf("\n  publish:\n") : undefined,
    );

  test("runs only for a core/v* tag, with no default permissions and no stored secret", () => {
    expect(workflow).toContain('on:\n  push:\n    tags: ["core/v*"]\n');
    expect(workflow).not.toContain("workflow_dispatch");
    expect(workflow).toContain("\npermissions: {}\n");
    expect(workflow).not.toMatch(/secrets\.|NODE_AUTH_TOKEN|NPM_TOKEN/);
    for (const use of workflow.match(/uses: \S+/g) ?? []) expect(use).toMatch(/@[0-9a-f]{40}$/);
  });

  test("only the npm-environment publish job can mint an OIDC token, and it publishes the re-verified tarball", () => {
    const plan = job("plan");
    const publish = workflow.slice(workflow.indexOf("\n  publish:\n"));
    expect(plan).not.toContain("id-token");
    expect(publish).toContain("environment: npm");
    expect(publish).toContain("id-token: write");
    expect(publish.indexOf("verify-tarball")).toBeLessThan(publish.indexOf('npm publish "$tarball"'));
    // Exactly one publication, of exactly the planned tarball.
    expect(workflow.match(/npm publish\b/g)).toHaveLength(1);
    expect(workflow).not.toContain("npm stage");
  });

  test("both jobs check the exact tag ref, and the plan requires the commit to be on releases/core", () => {
    const exact = String.raw`[[ "$GITHUB_REF" =~ ^refs/tags/core/v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]`;
    const plan = job("plan");
    const publish = workflow.slice(workflow.indexOf("\n  publish:\n"));
    for (const j of [plan, publish]) {
      expect(j).toContain(exact);
      expect(j.indexOf(exact)).toBeLessThan(j.indexOf("actions/checkout"));
    }
    expect(plan).toContain("+refs/heads/releases/core:refs/remotes/origin/releases/core");
    expect(plan).toContain("--release-branch-ref refs/remotes/origin/releases/core");
  });

  test("there is no token fallback: a missing Trusted Publisher fails the publish step", () => {
    const publish = workflow.slice(workflow.indexOf("\n  publish:\n"));
    expect(publish.indexOf("ACTIONS_ID_TOKEN_REQUEST_URL")).toBeLessThan(publish.indexOf('npm publish "$tarball"'));
    expect(workflow).not.toMatch(/_authToken|npm (login|adduser|token)|--allow-publish/);
    expect(publish).toContain('npm publish "$tarball" --access public --provenance --ignore-scripts');
  });
});
