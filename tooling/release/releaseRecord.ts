/**
 * `bun run release:record --package NAME --version X.Y.Z [--open]`
 *
 * Commits the verified readback of a published version that is adopted later, together with
 * its adoption group (COMFORGE-RELEASE-001). It runs the same check as a consumer update,
 * `release:npm-readback --commit <release commit> --expect-provenance --write-pin`: the
 * registry tarball file by file against the public Git release, and the provenance against
 * its tag and commit. It writes the result to `releases/records/<id>/<version>/`
 * on its own branch. It changes no dependency and installs nothing. The planner counts an
 * exact sibling pin as released only with this record (tooling/release/candidates.ts).
 * `--open` pushes the branch and opens a PR; nothing here merges.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { releasedDir } from "./candidates";
import { git, MIRROR_REPOSITORY } from "./mirror";
import { profileOf } from "./packages";

export class RecordRefusal extends Error {
  constructor(
    readonly code:
      | "malformed-version"
      | "not-published"
      | "already-recorded"
      | "dirty-checkout"
      | "not-on-main"
      | "record-pr-exists"
      | "release-missing"
      | "readback-failed"
      | "integrity-mismatch",
    message: string,
  ) {
    super(`release:record refused (${code}): ${message}`);
  }
}

export const recordBranch = (name: string, version: string) =>
  `comforge-released/${profileOf(name).tagPrefix}${version}`;

const REPO = path.resolve(import.meta.dir, "..", "..");

async function main(argv: string[]): Promise<number> {
  const arg = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const profile = profileOf(arg("--package"));
  const version = arg("--version") ?? "";
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version))
    throw new RecordRefusal("malformed-version", `${version} is not an exact MAJOR.MINOR.PATCH`);
  const res = await fetch(`https://registry.npmjs.org/${profile.name.replace("/", "%2f")}`);
  const doc = (res.ok ? await res.json() : {}) as {
    versions?: Record<string, { dist?: { integrity?: string } }>;
  };
  const integrity = doc.versions?.[version]?.dist?.integrity;
  if (!integrity)
    throw new RecordRefusal(
      "not-published",
      `${profile.name}@${version} is not on the npm registry`,
    );
  const dir = releasedDir(profile.name, version);
  if (existsSync(path.join(REPO, dir)))
    throw new RecordRefusal("already-recorded", `${dir} already exists`);
  if (git(REPO, ["status", "--porcelain", "--untracked-files=no"]) !== "")
    throw new RecordRefusal("dirty-checkout", "commit or discard tracked changes first");
  git(REPO, ["fetch", "-q", "origin", "main"]);
  const startSha = git(REPO, ["rev-parse", "HEAD"]);
  if (startSha !== git(REPO, ["rev-parse", "origin/main"]))
    throw new RecordRefusal("not-on-main", "start from an up-to-date origin/main");
  const branch = recordBranch(profile.name, version);
  if (git(REPO, ["ls-remote", "origin", `refs/heads/${branch}`], true) !== "")
    throw new RecordRefusal("record-pr-exists", `origin already has ${branch}`);
  const tag = `${profile.tagPrefix}${version}`;
  const refs = git(REPO, [
    "ls-remote",
    `https://github.com/${MIRROR_REPOSITORY}.git`,
    `refs/tags/${tag}`,
    `refs/tags/${tag}^{}`,
  ]);
  const commit =
    (refs.split("\n").find((l) => l.endsWith("^{}")) ?? refs.split("\n")[0] ?? "").split(
      /\s+/,
    )[0] ?? "";
  if (!/^[0-9a-f]{40}$/.test(commit))
    throw new RecordRefusal("release-missing", `${MIRROR_REPOSITORY} has no tag ${tag}`);

  const startBranch = git(REPO, ["rev-parse", "--abbrev-ref", "HEAD"]);
  git(REPO, ["switch", "-q", "-c", branch]);
  const restore = (code: RecordRefusal["code"], message: string): never => {
    rmSync(path.join(REPO, dir), { recursive: true, force: true });
    git(REPO, ["reset", "-q", "--hard", startSha]);
    git(
      REPO,
      startBranch === "HEAD"
        ? ["switch", "-q", "--detach", startSha]
        : ["switch", "-q", startBranch],
    );
    git(REPO, ["branch", "-q", "-D", branch]);
    throw new RecordRefusal(
      code,
      `${message}; restored ${startBranch} at ${startSha.slice(0, 12)}`,
    );
  };
  const readback = spawnSync(
    "bun",
    [
      "tooling/release/npm-release.ts",
      "readback",
      "--package",
      profile.name,
      "--commit",
      commit,
      "--expect-provenance",
      "--write-pin",
      dir,
    ],
    { cwd: REPO, stdio: "inherit" },
  );
  if (readback.status !== 0)
    return restore("readback-failed", `${profile.name}@${version} did not verify against ${tag}`);
  const pin = JSON.parse(readFileSync(path.join(REPO, dir, "npm-pin.json"), "utf8")) as {
    integrity: string;
  };
  if (pin.integrity !== integrity)
    return restore("integrity-mismatch", "the recorded integrity is not the registry's");

  git(REPO, ["add", "--", dir]);
  const message = `build(architecture): record released ${profile.name} ${version}\n\nComforge-Release: ${tag}@${commit}\n`;
  const committed = spawnSync("git", ["commit", "-q", "-F", "-"], {
    cwd: REPO,
    input: message,
    env: { ...process.env, SKIP_GIT_AI: "1" },
    stdio: ["pipe", "inherit", "inherit"],
  });
  if (committed.status !== 0) return restore("readback-failed", "the commit hooks failed");
  console.log(`release record for ${profile.name}@${version} committed on ${branch}`);
  if (!argv.includes("--open")) {
    console.log(`review it, then: git push -u origin ${branch} && gh pr create --head ${branch}`);
    return 0;
  }
  git(REPO, ["push", "-q", "-u", "origin", branch]);
  const pr = spawnSync(
    "gh",
    [
      "pr",
      "create",
      "--head",
      branch,
      "--base",
      "main",
      "--title",
      `build(architecture): record released ${profile.name} ${version}`,
      "--body",
      `Generated by \`bun run release:record\`. The registry artifact for ${profile.name}@${version} was read back file by file against \`${tag}\` (\`${commit}\`) with provenance; integrity \`${integrity}\`. This records the release so dependents can be planned; it installs nothing. The portfolio adopts the version with its adoption group in a separate consumer update. Nothing is merged or deployed automatically.`,
    ],
    { cwd: REPO, stdio: "inherit" },
  );
  return pr.status === 0 ? 0 : 1;
}

if (import.meta.main) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error((error as Error).message);
      process.exit(error instanceof RecordRefusal ? 1 : 2);
    });
}
