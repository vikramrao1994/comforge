import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  assertChangelogEntry,
  assertReleaseVersion,
  assertReproducible,
  brokenRelativeLinks,
  buildCandidate,
  CANONICAL_LICENSE_TEXTS,
  type Candidate,
  checkoutReleaseBranch,
  dryRunRelease,
  exampleLinkBase,
  git,
  listFiles,
  MIRROR_REPOSITORY,
  normalizeRemote,
  OWNERSHIP_FILE,
  OWNERSHIP_SCHEMA,
  planSync,
  publicationBlockers,
  pushRelease,
  RELEASE_FILE,
  type ReleaseRecord,
  ReleaseRefusal,
  releaseMirror,
  scanForDisclosure,
  verifyCompiledExports,
  workflowApproval,
  workflowChanges,
} from "../../tooling/release/mirror";
import { CORE } from "../../tooling/release/packages";

const RELEASE_BRANCH = CORE.releaseBranch;

// The @comforge/core release publisher (ENGINEERING-FACTORY-DISTRIBUTION-001) against
// disposable local git repositories: a bare repository stands in for the Comforge
// repository, so every push, refusal and readback is real git, and nothing leaves the
// machine. Its `main` holds an owner-written file the publisher must never touch; releases
// go to RELEASE_BRANCH only.

const REPO = path.resolve(import.meta.dir, "..", "..");
const STAGING = path.join(REPO, "generated", "factory-core-release-test");
const SOURCE = git(REPO, ["rev-parse", "HEAD"]);
let work: string;
let candidate: Candidate;
let twin: Candidate;

function refusalOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof ReleaseRefusal) return error.code;
    throw error;
  }
  return "no refusal";
}

const COMMITTER = ["-c", "user.name=owner", "-c", "user.email=owner@example.invalid"];

/**
 * A bare "remote" whose `main` holds a file the owner wrote, and a clone of it switched to
 * the release branch (unless `prepare` is false).
 */
function mirror(name: string, prepare = true): { remote: string; dest: string } {
  const remote = path.join(work, `${name}.git`);
  const dest = path.join(work, name);
  git(work, ["init", "-q", "--bare", "-b", "main", remote]);
  git(work, ["clone", "-q", remote, dest]);
  writeFileSync(path.join(dest, "NOTES.md"), "Owner notes, not managed by the publisher.\n");
  git(dest, ["add", "NOTES.md"]);
  git(dest, [...COMMITTER, "commit", "-q", "-m", "owner notes"]);
  git(dest, ["push", "-q", "origin", "main"]);
  if (prepare) checkoutReleaseBranch(dest);
  return { remote, dest };
}

/** A copy of the built candidate whose release record is rewritten consistently. */
function variant(name: string, edit: (dir: string, release: ReleaseRecord) => void): string {
  const dir = path.join(work, `candidate-${name}`);
  cpSync(candidate.dir, dir, { recursive: true });
  const release = JSON.parse(readFileSync(path.join(dir, RELEASE_FILE), "utf8")) as ReleaseRecord;
  edit(dir, release);
  const hash = (file: string) => new Bun.CryptoHasher("sha256").update(readFileSync(path.join(dir, file))).digest("hex");
  release.files = {};
  for (const file of listFiles(dir).filter((f) => f !== RELEASE_FILE && f !== OWNERSHIP_FILE)) release.files[file] = hash(file);
  writeFileSync(path.join(dir, RELEASE_FILE), `${JSON.stringify(release, null, 2)}\n`);
  const files: Record<string, string> = {};
  for (const file of listFiles(dir).filter((f) => f !== OWNERSHIP_FILE)) files[file] = hash(file);
  writeFileSync(path.join(dir, OWNERSHIP_FILE), `${JSON.stringify({ schema: OWNERSHIP_SCHEMA, files }, null, 2)}\n`);
  return dir;
}

const approveWorkflows = (outcome: { plan: Parameters<typeof workflowChanges>[0] }, dir: string) => workflowApproval(workflowChanges(outcome.plan, dir));

function publish(candidateDir: string, dest: string, remote: string) {
  const release = JSON.parse(readFileSync(path.join(candidateDir, RELEASE_FILE), "utf8")) as ReleaseRecord;
  const outcome = releaseMirror(candidateDir, dest);
  return pushRelease({
    destDir: dest,
    outcome,
    release,
    trustedOrigin: remote,
    approval: `${release.version}@${release.source.commit}`,
    workflowApproval: approveWorkflows(outcome, dest),
  });
}

beforeAll(() => {
  work = mkdtempSync(path.join(tmpdir(), "factory-core-release-"));
  candidate = buildCandidate({ repo: REPO, sourceCommit: SOURCE, outDir: path.join(work, "a"), stagingRoot: STAGING });
  twin = buildCandidate({ repo: REPO, sourceCommit: SOURCE, outDir: path.join(work, "b"), stagingRoot: STAGING });
}, 180_000);

afterAll(() => {
  rmSync(work, { recursive: true, force: true });
  rmSync(STAGING, { recursive: true, force: true });
});

describe("the candidate", () => {
  test("two builds of the same commit are byte-identical, tarball included", () => {
    expect(() => assertReproducible(candidate, twin)).not.toThrow();
    expect(candidate.release.tarball.sha256).toBe(twin.release.tarball.sha256);
  });

  test("records its source commit, trees, toolchain and every file digest", () => {
    const r = candidate.release;
    expect(r.source.commit).toBe(SOURCE);
    expect(r.source.packageTree).toBe(git(REPO, ["rev-parse", `${SOURCE}:packages/core`]));
    expect(r.package).toBe("@comforge/core");
    expect(r.tag).toBe(`core/v${r.version}`);
    expect(r.tarball.file).toBe(`comforge-core-${r.version}.tgz`);
    expect(r.tarball.integrity).toStartWith("sha512-");
    expect(Object.keys(r.files)).toContain("dist/index.js");
    expect(Object.keys(r.files)).toContain("examples/core-consumer/src/flows.ts");
  });

  test("ships compiled JavaScript, declarations, source, docs and the example, and nothing else", () => {
    const top = [...new Set(listFiles(candidate.dir).map((f) => f.split("/")[0]))].sort();
    expect(top).toEqual([
      OWNERSHIP_FILE,
      ".github",
      "CHANGELOG.md",
      "LICENSE",
      "README.md",
      RELEASE_FILE,
      "dist",
      "examples",
      "llms.txt",
      "package.json",
      "src",
    ]);
    expect(listFiles(path.join(candidate.dir, ".github"))).toEqual(["comforge/npm-release.mjs", "workflows/npm-publish.yml"]);
    const manifest = JSON.parse(readFileSync(path.join(candidate.dir, "package.json"), "utf8"));
    expect(manifest.private).toBe(true);
    expect(manifest.exports["."]).toEqual({ types: "./dist/index.d.ts", default: "./dist/index.js" });
  });

  test("passes the disclosure scan, and its relative links resolve inside the mirror", () => {
    expect(scanForDisclosure(candidate.dir)).toEqual([]);
    expect(brokenRelativeLinks(candidate.dir)).toEqual([]);
  });

  test("compiled dist exports exactly what the source exports", () => {
    expect(verifyCompiledExports(candidate.dir, STAGING)).toContain("evaluateLifecycleAction");
  }, 60_000);

  test("a regression in compiled output is detected (deliberate mutation)", () => {
    const dir = variant("regression", (d) => {
      const file = path.join(d, "dist", "index.js");
      writeFileSync(file, readFileSync(file, "utf8").replace(/evaluateLifecycleAction,?/g, ""));
    });
    expect(refusalOf(() => verifyCompiledExports(dir, STAGING))).toBe("validation-failed");
  }, 60_000);
});

describe("refusals before any destination", () => {
  test.each(["0.0.0", "1.0", "v1.0.0", "01.2.3", "1.2.3-beta", 1])("malformed version %p", (v) => {
    expect(refusalOf(() => assertReleaseVersion(v))).toBe("malformed-version");
  });

  test("a version without a changelog entry", () => {
    expect(refusalOf(() => assertChangelogEntry("# Changelog\n\n## 0.1.0\n", "0.2.0"))).toBe("changelog-missing");
    expect(refusalOf(() => assertChangelogEntry(null, "0.1.0"))).toBe("changelog-missing");
  });

  test("a source revision that does not exist", () => {
    expect(refusalOf(() => buildCandidate({ repo: REPO, sourceCommit: "0".repeat(40), outDir: path.join(work, "x"), stagingRoot: STAGING }))).toBe(
      "source-missing",
    );
  });

  test.each([
    ["private-key-block", "-----BEGIN PRIVATE KEY-----"],
    ["github-token", `token ghp_${"a".repeat(36)}`],
    ["email-address", "contact someone@gmail.com"],
    ["local-path", "see /Users/someone/project"],
    ["owner-identity", "portfolio-mcp:engineering-spec"],
    ["internal-ticket", "ENGINEERING-FACTORY-CORE-004"],
    ["portfolio-path", "docs/engineering/report.md"],
  ])("the disclosure scan finds %s", (rule, text) => {
    const dir = variant(`scan-${rule}`, (d) => writeFileSync(path.join(d, "src", "leak.ts"), `// ${text}\n`));
    expect(scanForDisclosure(dir).map((f) => f.rule)).toContain(rule);
  });

  test("a link that leaves the mirror is reported", () => {
    const dir = variant("link", (d) => writeFileSync(path.join(d, "README.md"), "See [the report](../../docs/engineering/report.md).\n"));
    expect(brokenRelativeLinks(dir)).toEqual(["README.md → ../../docs/engineering/report.md"]);
  });

  test("a candidate whose files no longer match RELEASE.json", () => {
    const dir = path.join(work, "candidate-tampered");
    cpSync(candidate.dir, dir, { recursive: true });
    writeFileSync(path.join(dir, "dist", "index.js"), "export {};\n");
    const { dest } = mirror("tampered");
    expect(refusalOf(() => planSync(dir, dest))).toBe("validation-failed");
  });
});

describe("dry run", () => {
  test("plans every owned file, preserves unrelated files and changes neither checkout nor remote", () => {
    const { remote, dest } = mirror("dry", false);
    const before = git(remote, ["rev-parse", "main"]);
    const { outcome, patch } = dryRunRelease(candidate.dir, dest, work);
    expect(outcome.changed).toBe(true);
    expect(outcome.tagCreated).toBe(true);
    expect(outcome.plan.write.length).toBe(listFiles(candidate.dir).length);
    expect(outcome.plan.remove).toEqual([]);
    expect(patch).toContain(`release: @comforge/core ${candidate.release.tag}`);
    expect(git(remote, ["rev-parse", "main"])).toBe(before);
    expect(git(remote, ["tag", "-l"])).toBe("");
    expect(git(remote, ["branch", "--list", RELEASE_BRANCH])).toBe("");
    expect(git(dest, ["status", "--porcelain"])).toBe("");
    expect(git(dest, ["symbolic-ref", "--short", "HEAD"])).toBe("main");
    expect(existsSync(path.join(dest, "package.json"))).toBe(false);
  });
});

describe("publish to a disposable remote", () => {
  test("first release: one commit on the release branch and its tag; main is never written", () => {
    const { remote, dest } = mirror("first");
    const mainBefore = git(remote, ["rev-parse", "main"]);
    const result = publish(candidate.dir, dest, remote);
    const tagged = git(remote, ["rev-parse", `${candidate.release.tag}^{commit}`]);
    expect(result.remoteBranch).toBe(tagged);
    expect(result.remoteTag).toBe(tagged);
    expect(git(remote, ["rev-parse", RELEASE_BRANCH])).toBe(tagged);
    expect(git(remote, ["rev-parse", "main"])).toBe(mainBefore);
    expect(result.pushed.join(" ")).not.toContain("refs/heads/main");
    // The release branch is an orphan: the package at its root, none of main's files.
    expect(git(remote, ["rev-list", "--count", tagged])).toBe("1");
    expect(git(remote, ["ls-tree", "--name-only", tagged])).not.toContain("NOTES.md");
    const published = JSON.parse(git(remote, ["show", `${tagged}:${RELEASE_FILE}`])) as ReleaseRecord;
    expect(published.source.commit).toBe(SOURCE);
    expect(published.tarball.sha256).toBe(candidate.release.tarball.sha256);
  });

  test("an owner file on the release branch outside the owned paths is kept", () => {
    const { remote, dest } = mirror("owner-file");
    writeFileSync(path.join(dest, "SECURITY.md"), "Owner policy.\n");
    git(dest, ["add", "SECURITY.md"]);
    git(dest, [...COMMITTER, "commit", "-q", "-m", "owner policy"]);
    git(dest, ["push", "-q", "origin", RELEASE_BRANCH]);
    publish(candidate.dir, dest, remote);
    expect(git(remote, ["show", `${RELEASE_BRANCH}:SECURITY.md`])).toBe("Owner policy.");
  });

  test("a fresh clone continues the existing release branch", () => {
    const { remote, dest } = mirror("continue");
    publish(candidate.dir, dest, remote);
    const clone = path.join(work, "continue-clone");
    git(work, ["clone", "-q", remote, clone]);
    checkoutReleaseBranch(clone);
    expect(git(clone, ["rev-parse", "HEAD"])).toBe(git(remote, ["rev-parse", RELEASE_BRANCH]));
    expect(releaseMirror(candidate.dir, clone).changed).toBe(false);
  });

  test("identical input is a no-op: no commit, no push", () => {
    const { remote, dest } = mirror("noop");
    publish(candidate.dir, dest, remote);
    const head = git(remote, ["rev-parse", RELEASE_BRANCH]);
    const again = releaseMirror(candidate.dir, dest);
    expect(again.changed).toBe(false);
    expect(again.tagCreated).toBe(false);
    const result = publish(candidate.dir, dest, remote);
    expect(result.pushed).toEqual([]);
    expect(git(remote, ["rev-parse", RELEASE_BRANCH])).toBe(head);
  });

  test("a new version supersedes the previous one; old files are removed and the old tag stays", () => {
    const { remote, dest } = mirror("next");
    publish(candidate.dir, dest, remote);
    const old = git(remote, ["rev-parse", `${candidate.release.tag}^{commit}`]);
    const next = variant("next", (d, r) => {
      r.version = "9.9.9";
      r.tag = "core/v9.9.9";
      rmSync(path.join(d, "llms.txt"));
    });
    publish(next, dest, remote);
    expect(git(remote, ["rev-parse", "core/v9.9.9^{commit}"])).toBe(git(remote, ["rev-parse", RELEASE_BRANCH]));
    expect(git(remote, ["rev-parse", `${candidate.release.tag}^{commit}`])).toBe(old);
    expect(git(remote, ["ls-tree", "--name-only", RELEASE_BRANCH])).not.toContain("llms.txt");
  });

  test("the same version with different content is refused", () => {
    const { remote, dest } = mirror("reuse");
    publish(candidate.dir, dest, remote);
    const changed = variant("reuse", (d) => writeFileSync(path.join(d, "CHANGELOG.md"), "# changed\n"));
    expect(refusalOf(() => releaseMirror(changed, dest))).toBe("version-reused");
  });

  test("a lower version is refused", () => {
    const { remote, dest } = mirror("lower");
    publish(candidate.dir, dest, remote);
    const lower = variant("lower", (_d, r) => {
      r.version = "0.0.1";
      r.tag = "core/v0.0.1";
    });
    expect(refusalOf(() => releaseMirror(lower, dest))).toBe("version-regression");
  });

  test("an existing tag for other content is never moved", () => {
    const { remote, dest } = mirror("tag");
    git(dest, [...COMMITTER, "tag", candidate.release.tag, "main"]);
    expect(refusalOf(() => releaseMirror(candidate.dir, dest))).toBe("tag-changed");
    expect(git(remote, ["tag", "-l"])).toBe("");
  });

  test("a remote tag that differs from the local release is refused", () => {
    const { remote, dest } = mirror("remote-tag");
    const other = path.join(work, "remote-tag-other");
    git(work, ["clone", "-q", remote, other]);
    git(other, [...COMMITTER, "tag", candidate.release.tag]);
    git(other, ["push", "-q", "origin", `refs/tags/${candidate.release.tag}`]);
    const outcome = releaseMirror(candidate.dir, dest);
    expect(
      refusalOf(() =>
        pushRelease({
          destDir: dest,
          outcome,
          release: candidate.release,
          trustedOrigin: remote,
          approval: `${candidate.release.version}@${SOURCE}`,
          workflowApproval: approveWorkflows(outcome, dest),
        }),
      ),
    ).toBe("tag-changed");
  });
});

describe("destination protection", () => {
  test("an owned file edited by hand is refused, not overwritten", () => {
    const { remote, dest } = mirror("edited");
    publish(candidate.dir, dest, remote);
    writeFileSync(path.join(dest, "README.md"), "hand edit\n");
    git(dest, [...COMMITTER, "commit", "-q", "-am", "hand edit"]);
    expect(refusalOf(() => planSync(candidate.dir, dest))).toBe("modified-outside-publisher");
  });

  test("an unexpected file inside an owned path is refused", () => {
    const { dest } = mirror("unexpected");
    mkdirSync(path.join(dest, "dist"));
    writeFileSync(path.join(dest, "dist", "extra.js"), "export {};\n");
    git(dest, ["add", "dist"]);
    git(dest, [...COMMITTER, "commit", "-q", "-m", "extra"]);
    expect(refusalOf(() => planSync(candidate.dir, dest))).toBe("unexpected-file");
  });

  test("a checkout on any branch but the release branch is refused", () => {
    const { dest } = mirror("on-main", false);
    expect(refusalOf(() => planSync(candidate.dir, dest))).toBe("destination-branch");
    expect(refusalOf(() => releaseMirror(candidate.dir, dest))).toBe("destination-branch");
  });

  test("a dirty checkout is refused", () => {
    const { dest } = mirror("dirty");
    writeFileSync(path.join(dest, "scratch.txt"), "x\n");
    expect(refusalOf(() => planSync(candidate.dir, dest))).toBe("destination-dirty");
  });

  test("a directory that is not a git checkout is refused", () => {
    const dir = mkdtempSync(path.join(work, "plain-"));
    expect(refusalOf(() => planSync(candidate.dir, dir))).toBe("destination-not-git");
  });
});

describe("publish gates", () => {
  test("an origin other than the approved mirror is refused", () => {
    const { dest } = mirror("untrusted");
    const outcome = releaseMirror(candidate.dir, dest);
    expect(
      refusalOf(() =>
        pushRelease({
          destDir: dest,
          outcome,
          release: candidate.release,
          trustedOrigin: "https://github.com/someone/comforge.git",
          approval: `${candidate.release.version}@${SOURCE}`,
          workflowApproval: approveWorkflows(outcome, dest),
        }),
      ),
    ).toBe("untrusted-destination");
  });

  test.each([undefined, "", "0.1.0", `9.9.9@${SOURCE}`, `0.1.0@${"0".repeat(40)}`])("a missing or mismatched approval (%p) is refused", (approval) => {
    const { remote, dest } = mirror(`approval-${String(approval).length}-${Math.random().toString(36).slice(2, 7)}`);
    const outcome = releaseMirror(candidate.dir, dest);
    expect(refusalOf(() => pushRelease({ destDir: dest, outcome, release: candidate.release, trustedOrigin: remote, approval }))).toBe("approval-missing");
    expect(git(remote, ["tag", "-l"])).toBe("");
  });

  test("a concurrent writer is detected, and nothing is force-pushed", () => {
    const { remote, dest } = mirror("concurrent");
    const outcome = releaseMirror(candidate.dir, dest);
    const other = path.join(work, "concurrent-other");
    git(work, ["clone", "-q", remote, other]);
    checkoutReleaseBranch(other);
    writeFileSync(path.join(other, "OTHER.md"), "someone else\n");
    git(other, ["add", "OTHER.md"]);
    git(other, [...COMMITTER, "commit", "-q", "-m", "concurrent"]);
    git(other, ["push", "-q", "origin", RELEASE_BRANCH]);
    const theirs = git(remote, ["rev-parse", RELEASE_BRANCH]);
    expect(
      refusalOf(() =>
        pushRelease({
          destDir: dest,
          outcome,
          release: candidate.release,
          trustedOrigin: remote,
          approval: `${candidate.release.version}@${SOURCE}`,
          workflowApproval: approveWorkflows(outcome, dest),
        }),
      ),
    ).toBe("destination-moved");
    expect(git(remote, ["rev-parse", RELEASE_BRANCH])).toBe(theirs);
  });

  test("a push the remote rejects is reported, not retried with force", () => {
    const { remote, dest } = mirror("rejected");
    const hook = path.join(remote, "hooks", "pre-receive");
    writeFileSync(hook, "#!/bin/sh\necho 'protected branch' >&2\nexit 1\n", { mode: 0o755 });
    const outcome = releaseMirror(candidate.dir, dest);
    expect(
      refusalOf(() =>
        pushRelease({
          destDir: dest,
          outcome,
          release: candidate.release,
          trustedOrigin: remote,
          approval: `${candidate.release.version}@${SOURCE}`,
          workflowApproval: approveWorkflows(outcome, dest),
        }),
      ),
    ).toBe("push-rejected");
    expect(git(remote, ["tag", "-l"])).toBe("");
    // The per-ref reason (stdout under --porcelain) is reported, not only "failed to push".
    let message = "";
    try {
      pushRelease({
        destDir: dest,
        outcome,
        release: candidate.release,
        trustedOrigin: remote,
        approval: `${candidate.release.version}@${SOURCE}`,
        workflowApproval: approveWorkflows(outcome, dest),
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("pre-receive hook declined");
  });

  test("remote URLs normalize across https, token-bearing and ssh forms", () => {
    for (const url of [
      "https://github.com/Owner/factory-core.git",
      "https://x-access-token:abc@github.com/owner/factory-core",
      "git@github.com:owner/factory-core.git",
      "ssh://git@github.com/owner/factory-core.git",
    ])
      expect(normalizeRemote(url)).toBe("github.com/owner/factory-core");
    expect(normalizeRemote("https://github.com/owner/factory-core-evil.git")).not.toBe("github.com/owner/factory-core");
  });
});

describe("workflow changes (COMFORGE-NPM-AUTOMATION-001)", () => {
  test("a release that adds the npm workflow needs its own approval naming the file and digest", () => {
    const { remote, dest } = mirror("workflow-unapproved");
    const outcome = releaseMirror(candidate.dir, dest);
    const changes = workflowChanges(outcome.plan, dest);
    expect(changes.map((c) => c.file)).toEqual([".github/workflows/npm-publish.yml"]);
    expect(changes[0]?.sha256).toBe(
      new Bun.CryptoHasher("sha256").update(readFileSync(path.join(candidate.dir, ".github", "workflows", "npm-publish.yml"))).digest("hex"),
    );
    for (const workflowApproval of [undefined, "", ".github/workflows/npm-publish.yml@" + "0".repeat(64)])
      expect(
        refusalOf(() =>
          pushRelease({
            destDir: dest,
            outcome,
            release: candidate.release,
            trustedOrigin: remote,
            approval: `${candidate.release.version}@${SOURCE}`,
            workflowApproval,
          }),
        ),
      ).toBe("workflow-change-unapproved");
    expect(git(remote, ["for-each-ref", "refs/tags"])).toBe("");
  });

  test("a later release that leaves the workflow unchanged needs no workflow approval", () => {
    const { remote, dest } = mirror("workflow-unchanged");
    publish(candidate.dir, dest, remote);
    const [major, minor, patch] = candidate.release.version.split(".").map(Number);
    const nextVersion = `${major}.${minor}.${(patch ?? 0) + 1}`;
    const next = variant("workflow-next", (_d, r) => {
      r.version = nextVersion;
      r.tag = `core/v${nextVersion}`;
    });
    const outcome = releaseMirror(next, dest);
    expect(workflowChanges(outcome.plan, dest)).toEqual([]);
    const release = JSON.parse(readFileSync(path.join(next, RELEASE_FILE), "utf8")) as ReleaseRecord;
    pushRelease({ destDir: dest, outcome, release, trustedOrigin: remote, approval: `${nextVersion}@${SOURCE}` });
    expect(git(remote, ["rev-parse", `refs/tags/core/v${nextVersion}`])).toBe(outcome.commit);
  });

  test("GitHub's refusal to let the credential write a workflow is reported as a permission gap", () => {
    const { remote, dest } = mirror("workflow-permission");
    writeFileSync(
      path.join(remote, "hooks", "pre-receive"),
      "#!/bin/sh\necho '! [remote rejected] refusing to allow a Personal Access Token to create or update workflow `.github/workflows/npm-publish.yml` without `workflow` scope' >&2\nexit 1\n",
      { mode: 0o755 },
    );
    const outcome = releaseMirror(candidate.dir, dest);
    expect(
      refusalOf(() =>
        pushRelease({
          destDir: dest,
          outcome,
          release: candidate.release,
          trustedOrigin: remote,
          approval: `${candidate.release.version}@${SOURCE}`,
          workflowApproval: approveWorkflows(outcome, dest),
        }),
      ),
    ).toBe("workflow-permission");
    expect(git(remote, ["for-each-ref", "refs/tags"])).toBe("");
  });
});

describe("public release gates (COMFORGE-PUBLIC-RELEASE-001)", () => {
  test("example links point at the release tag (they resolve from npm too), and other links are checked", () => {
    const base = exampleLinkBase(candidate.release.version);
    expect(base).toBe(`https://github.com/${MIRROR_REPOSITORY}/tree/core/v${candidate.release.version}/examples/`);
    for (const doc of ["llms.txt", "README.md"]) {
      const text = readFileSync(path.join(candidate.dir, doc), "utf8");
      expect(text).not.toContain("../../");
      expect(text).not.toContain("](examples/");
      // Every rewritten link names a file or directory the release itself ships.
      for (const [, target] of text.matchAll(/\]\(https:\/\/github\.com\/[^/]+\/[^/]+\/tree\/core\/v[^/]+\/([^)#]+)\)/g))
        expect(existsSync(path.join(candidate.dir, target as string))).toBe(true);
    }
    expect(readFileSync(path.join(candidate.dir, "llms.txt"), "utf8")).toContain(`](${base}core-consumer/src/flows.ts)`);
    const dir = variant("llms-link", (d) => writeFileSync(path.join(d, "llms.txt"), "- [x](../../docs/engineering/report.md)\n"));
    expect(brokenRelativeLinks(dir)).toEqual(["llms.txt → ../../docs/engineering/report.md"]);
  });

  test("the release's own public URL is allowed; any other owner reference is not", () => {
    const dir = variant("own-url", (d) => writeFileSync(path.join(d, "src", "where.ts"), `// git+https://github.com/${MIRROR_REPOSITORY}.git#abc\n`));
    expect(scanForDisclosure(dir)).toEqual([]);
    const other = variant("other-url", (d) => writeFileSync(path.join(d, "src", "where.ts"), `// github.com/${MIRROR_REPOSITORY.split("/")[0]}/portfolio\n`));
    expect(scanForDisclosure(other).map((f) => f.rule)).toContain("owner-identity");
  });

  test("the release ships the owner's Apache-2.0 licence, in the tree and in the tarball", () => {
    const manifest = JSON.parse(readFileSync(path.join(candidate.dir, "package.json"), "utf8"));
    expect(manifest.license).toBe("Apache-2.0");
    const text = readFileSync(path.join(candidate.dir, "LICENSE"));
    expect(new Bun.CryptoHasher("sha256").update(text).digest("hex")).toBe(CANONICAL_LICENSE_TEXTS["Apache-2.0"]);
    expect(candidate.release.files.LICENSE).toBe(CANONICAL_LICENSE_TEXTS["Apache-2.0"]);
    const listing = spawnSync("tar", ["-tzf", candidate.tarball], { encoding: "utf8" });
    expect(listing.stdout.split("\n")).toContain("package/LICENSE");
    expect(publicationBlockers(candidate.dir, "a".repeat(40))).toEqual([]);
  });

  test("a missing, partial, altered or unrecognized licence blocks a release; the publisher never picks one", () => {
    const relicense = (name: string, license: string | undefined, text: string | null) =>
      variant(name, (d) => {
        if (text === null) rmSync(path.join(d, "LICENSE"));
        else writeFileSync(path.join(d, "LICENSE"), text);
        const { license: _, ...manifest } = JSON.parse(readFileSync(path.join(d, "package.json"), "utf8"));
        writeFileSync(path.join(d, "package.json"), `${JSON.stringify(license ? { ...manifest, license } : manifest, null, 2)}\n`);
      });
    const canonical = readFileSync(path.join(candidate.dir, "LICENSE"), "utf8");
    expect(publicationBlockers(relicense("none", undefined, null), null)).toEqual([
      "license-missing: no licence chosen; the owner decides (manifest license + LICENSE)",
    ]);
    expect(publicationBlockers(relicense("file-only", undefined, canonical), null)[0]).toStartWith("license-inconsistent");
    expect(publicationBlockers(relicense("id-only", "Apache-2.0", null), null)[0]).toStartWith("license-inconsistent");
    expect(publicationBlockers(relicense("unlicensed", "UNLICENSED", canonical), null)[0]).toStartWith("license-unlicensed");
    expect(publicationBlockers(relicense("mit", "MIT", canonical), null)[0]).toStartWith("license-unrecognized");
    const trimmed = relicense("trimmed", "Apache-2.0", canonical.replace(/\n\s*APPENDIX[\s\S]*$/, "\n"));
    expect(publicationBlockers(trimmed, null)[0]).toStartWith("license-text-mismatch");
    const crlf = relicense("crlf", "Apache-2.0", canonical.replaceAll("\n", "\r\n"));
    expect(publicationBlockers(crlf, null)[0]).toStartWith("license-text-mismatch");
  });

  test("a repository without main is blocked, and a push into it is refused", () => {
    expect(publicationBlockers(candidate.dir, "").at(-1)).toStartWith("destination-uninitialized");
    const remote = path.join(work, "empty.git");
    const dest = path.join(work, "empty");
    git(work, ["init", "-q", "--bare", "-b", "main", remote]);
    git(work, ["clone", "-q", remote, dest]);
    checkoutReleaseBranch(dest);
    const outcome = releaseMirror(candidate.dir, dest);
    expect(
      refusalOf(() =>
        pushRelease({
          destDir: dest,
          outcome,
          release: candidate.release,
          trustedOrigin: remote,
          approval: `${candidate.release.version}@${SOURCE}`,
          workflowApproval: approveWorkflows(outcome, dest),
        }),
      ),
    ).toBe("destination-uninitialized");
    expect(git(remote, ["for-each-ref"])).toBe("");
  });

  test("a push URL rewritten away from the approved mirror is refused (COMFORGE-GITHUB-001)", () => {
    const { remote, dest } = mirror("push-redirect");
    const outcome = releaseMirror(candidate.dir, dest);
    const elsewhere = path.join(work, "push-redirect-elsewhere.git");
    git(work, ["init", "-q", "--bare", elsewhere]);
    // The fetch URL still names the approved mirror; only pushes are redirected.
    git(dest, ["config", `url.${elsewhere}.pushInsteadOf`, remote]);
    expect(git(dest, ["remote", "get-url", "origin"])).toBe(remote);
    expect(
      refusalOf(() =>
        pushRelease({
          destDir: dest,
          outcome,
          release: candidate.release,
          trustedOrigin: remote,
          approval: `${candidate.release.version}@${SOURCE}`,
          workflowApproval: approveWorkflows(outcome, dest),
        }),
      ),
    ).toBe("untrusted-destination");
    expect(git(elsewhere, ["for-each-ref"])).toBe("");
  });

  test("the workflow mints and uses the write credential only for an authorized publish run", () => {
    // COMFORGE-RELEASE-APPROVAL-001: the credential lives only in job `release`, which needs the
    // credential-free `authorize` job and verifies the owner's signed authorization again
    // before the credential step; the candidate job reads anonymously.
    const workflow = Bun.YAML.parse(readFileSync(path.join(REPO, ".github", "workflows", "release.yml"), "utf8")) as {
      "run-name": string;
      jobs: Record<string, { if?: string; environment?: string; needs?: string | string[]; steps: { name?: string; run?: string }[] }>;
    };
    const text = (job: string) => JSON.stringify(workflow.jobs[job]);
    expect(text("candidate")).not.toContain("secrets.");
    expect(text("authorize")).not.toContain("secrets.");
    expect(workflow.jobs.authorize?.environment).toBeUndefined();
    // The anonymous read goes through git (prepareMirrorCheckout.sh), not the REST API.
    expect(text("candidate")).toContain('tooling/release/prepareMirrorCheckout.sh \\"https://github.com/$MIRROR_REPOSITORY.git\\" mirror-repo');
    // The repository-level secret is readable by a workflow on any branch; only the
    // environment secret is restricted to main.
    expect(text("release")).toContain("secrets.COMFORGE_RELEASE_TOKEN");
    expect(text("release")).not.toContain("COMFORGE_REPO_TOKEN");
    expect(text("release")).not.toContain("required_reviewers");
    expect(workflow.jobs.release?.needs).toEqual(["candidate", "authorize"]);
    for (const job of ["authorize", "release"]) expect(workflow.jobs[job]?.if).toContain("inputs.publish == true");
    expect(workflow.jobs.release?.environment).toBe("comforge-release");
    const steps = workflow.jobs.release?.steps ?? [];
    const verify = steps.findIndex((s) => s.run?.includes("releaseAuthorization.ts verify"));
    const credential = steps.findIndex((s) => JSON.stringify(s).includes("secrets."));
    expect(verify).toBeGreaterThan(0);
    expect(verify).toBeLessThan(credential);
    expect(text("release")).toContain("--authorization approved/authorization.json");
    expect(workflow["run-name"]).toContain("Comforge release {0}");
  });
});

describe("the CLI", () => {
  test("a dry run with nothing due reports the plan and succeeds, even when the mirror already holds the version", () => {
    // The mirror holds this version with other content (a release from an older source
    // commit). Syncing would refuse version-reused; a dry run with no release due must stop
    // at the planner's verdict instead of failing.
    const { remote, dest } = mirror("cli-nothing-due");
    publish(
      variant("cli-nothing-due", (d) => writeFileSync(path.join(d, "CHANGELOG.md"), "# older\n")),
      dest,
      remote,
    );
    const out = path.join(work, "cli-nothing-due-out");
    const dry = spawnSync("bun", ["tooling/release/release.ts", "--dest", dest, "--out", out], { cwd: REPO, encoding: "utf8" });
    if (git(REPO, ["status", "--porcelain", "--", "packages/core", "examples/core-consumer", "tooling/release"]) !== "") {
      expect(dry.stderr).toContain("refused (source-dirty)");
      return;
    }
    // Only meaningful when the planner reaches a verdict that is not release-ready. In a
    // shallow CI checkout it refuses (baseline-unrelated: the pinned release commit is not
    // in the history), and a release-ready HEAD takes the full path.
    const verdict = /^release plan: (\S+)/m.exec(dry.stdout)?.[1];
    if (verdict !== "no-release" && verdict !== "version-pr-due") return;
    const plan = JSON.parse(readFileSync(path.join(out, "plan.json"), "utf8"));
    expect(dry.stderr).not.toContain("version-reused");
    expect(dry.status).toBe(0);
    expect(dry.stdout).toContain("nothing to approve");
    expect(plan.candidate).toBeNull();
    expect(existsSync(path.join(out, "candidate.json"))).toBe(false);
  }, 180_000);

  test("a dry run against a local checkout changes nothing and refuses to publish to it", () => {
    const { remote, dest } = mirror("cli", false);
    const out = path.join(work, "cli-out");
    const dry = spawnSync("bun", ["tooling/release/release.ts", "--dest", dest, "--out", out], {
      cwd: REPO,
      encoding: "utf8",
    });
    // The CLI builds only committed source; with uncommitted package edits it must refuse.
    if (git(REPO, ["status", "--porcelain", "--", "packages/core", "examples/core-consumer", "tooling/release"]) !== "") {
      expect(dry.stderr).toContain("refused (source-dirty)");
      return;
    }
    expect(dry.stderr).toBe("");
    expect(dry.status).toBe(0);
    const plan = JSON.parse(readFileSync(path.join(out, "plan.json"), "utf8"));
    expect(plan.mode).toBe("dry-run");
    expect(plan.pushed).toBeNull();
    expect(plan.blockers).toEqual([]);
    expect(plan.release.tag).toBe(`core/v${candidate.release.version}`);
    expect(git(remote, ["tag", "-l"])).toBe("");
    expect(git(dest, ["symbolic-ref", "--short", "HEAD"])).toBe("main");
  }, 180_000);
});
