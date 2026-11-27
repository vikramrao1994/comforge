/**
 * `bun run release:adopt [--package NAME [--version X.Y.Z]]… [--rollback] [--open]`
 *
 * After a `@comforge/core` version is public on npm, prepares the portfolio's consumer
 * update on its own branch (COMFORGE-RELEASE-AUTOMATION-001): the exact dependency,
 * bun.lock, and the consumer pin record written by `release:npm-readback --commit
 * <release commit> --expect-provenance --write-pin`, which verifies the registry tarball
 * file by file against the public Git release and its provenance. A version that is only
 * staged is not on the registry, so it is refused before anything changes. The factory-core
 * tests run against the fresh install; any failure restores the starting branch, files and
 * install, so the previous exact version stays in place. Several `--package` pairs move together
 * on one branch: an adoption group whose released versions require each other's new versions,
 * so no installed release keeps a nested copy of another (COMFORGE-RELEASE-001). A prepared
 * consumer migration (`release:adopt-migrate`) whose required entry points the new install
 * exposes is applied in the same commit, and undone by the same restore. `--open`
 * pushes the branch and opens a PR; nothing here merges or deploys.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { applyMigration, listMigrations, MIGRATION_DIR, statusOf } from "./consumerMigration";
import { git, MIRROR_REPOSITORY } from "./mirror";
import { allTests, CORE, type PackageProfile, profileOf } from "./packages";
import { publishedVersions, setDependencyVersion } from "./releasePlan";

export type ConsumerDecision =
  | { action: "current"; version: string }
  | { action: "update"; from: string; to: string; direction: "upgrade" | "rollback" };

export class ConsumerRefusal extends Error {
  constructor(
    readonly code:
      | "not-consumed"
      | "not-published"
      | "version-regression"
      | "malformed-version"
      | "dirty-checkout"
      | "not-on-main"
      | "consumer-pr-exists"
      | "release-missing"
      | "readback-failed"
      | "checks-failed",
    message: string,
  ) {
    super(`release:adopt refused (${code}): ${message}`);
  }
}

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const compare = (a: string, b: string) => {
  const [pa, pb] = [a, b].map((v) => v.split(".").map(Number)) as [number[], number[]];
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
};

/** Pure: whether and how to move the pin from `current` to `target`. */
export function decideConsumerUpdate(input: {
  /** Defaults to `@comforge/core`. */
  package?: string;
  current: string;
  target: string;
  published: string[];
  rollback: boolean;
}): ConsumerDecision {
  const { current, target } = input;
  if (!SEMVER.test(target))
    throw new ConsumerRefusal("malformed-version", `${target} is not an exact MAJOR.MINOR.PATCH`);
  // Staged versions are not on the registry; prereleases and placeholders never qualify.
  if (!input.published.includes(target))
    throw new ConsumerRefusal(
      "not-published",
      `${input.package ?? CORE.name}@${target} is not on the npm registry`,
    );
  const order = compare(target, current);
  if (order === 0) return { action: "current", version: current };
  if (order < 0 && !input.rollback)
    throw new ConsumerRefusal(
      "version-regression",
      `${target} is older than the pinned ${current}; pass --rollback to pin it deliberately`,
    );
  return {
    action: "update",
    from: current,
    to: target,
    direction: order > 0 ? "upgrade" : "rollback",
  };
}

export const consumerBranch = (version: string, profile: PackageProfile = CORE) =>
  `comforge-consumer/${profile.tagPrefix}${version}`;

/** One branch for an adoption group: `comforge-consumer/core/v0.2.0+github/v0.5.0`. */
export const groupBranch = (targets: readonly { profile: PackageProfile; version: string }[]) =>
  targets.length === 1
    ? consumerBranch(targets[0]?.version as string, targets[0]?.profile)
    : `comforge-consumer/${targets.map((t) => `${t.profile.tagPrefix}${t.version}`).join("+")}`;

/**
 * `--package A [--version X] [--package B --version Y …]`: each `--package` takes the
 * `--version` that follows it before the next `--package` (absent: the registry's latest).
 */
export function parseTargets(argv: string[]): { name: string; version: string | undefined }[] {
  const out: { name: string; version: string | undefined }[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--package") out.push({ name: argv[i + 1] ?? "", version: undefined });
    if (argv[i] === "--version") {
      const last = out.at(-1);
      if (last) last.version = argv[i + 1];
      else out.push({ name: CORE.name, version: argv[i + 1] });
    }
  }
  return out.length > 0 ? out : [{ name: CORE.name, version: undefined }];
}

const REPO = path.resolve(import.meta.dir, "..", "..");

function sh(cmd: string, args: string[], options: { quiet?: boolean } = {}) {
  const r = spawnSync(cmd, args, {
    cwd: REPO,
    encoding: "utf8",
    stdio: options.quiet ? "pipe" : "inherit",
  });
  return r.status === 0;
}

async function main(argv: string[]): Promise<number> {
  const rollbackFlag = argv.includes("--rollback");
  const requested = parseTargets(argv);
  if (new Set(requested.map((r) => profileOf(r.name).name)).size !== requested.length)
    throw new ConsumerRefusal("malformed-version", "a package is named twice");
  const updates: { profile: PackageProfile; from: string; to: string; direction: string }[] = [];
  for (const r of requested) {
    const profile = profileOf(r.name);
    // The application installs only released packages it has chosen to consume; adopting a new
    // one (adding the dependency and its pin) is an owner decision, not an update.
    if (!profile.consumedByPortfolio)
      throw new ConsumerRefusal(
        "not-consumed",
        `the portfolio does not consume ${profile.name} from npm yet; adopting it is a reviewed change (packages.ts consumedByPortfolio, the dependency and its first pin)`,
      );
    const current = (
      JSON.parse(readFileSync(path.join(REPO, profile.pinDir, "npm-pin.json"), "utf8")) as {
        version: string;
      }
    ).version;
    const registry = (await (
      await fetch(`https://registry.npmjs.org/${profile.name.replace("/", "%2f")}`)
    ).json()) as { "dist-tags"?: { latest?: string } };
    const decision = decideConsumerUpdate({
      current,
      target: r.version ?? registry["dist-tags"]?.latest ?? "",
      package: profile.name,
      published: await publishedVersions(profile.name),
      rollback: rollbackFlag,
    });
    if (decision.action === "current")
      console.log(`the portfolio already pins ${profile.name}@${current}`);
    else
      updates.push({
        profile,
        from: decision.from,
        to: decision.to,
        direction: decision.direction,
      });
  }
  if (updates.length === 0) {
    console.log("nothing to do");
    return 0;
  }
  if (updates.length !== requested.length)
    throw new ConsumerRefusal(
      "version-regression",
      "every package of an adoption group must move; one is already at its target",
    );

  if (git(REPO, ["status", "--porcelain"]) !== "")
    throw new ConsumerRefusal("dirty-checkout", "commit or discard every change first");
  git(REPO, ["fetch", "-q", "origin", "main"]);
  if (git(REPO, ["rev-parse", "HEAD"]) !== git(REPO, ["rev-parse", "origin/main"]))
    throw new ConsumerRefusal("not-on-main", "start from an up-to-date origin/main");
  const branch = groupBranch(updates.map((u) => ({ profile: u.profile, version: u.to })));
  if (git(REPO, ["ls-remote", "origin", `refs/heads/${branch}`], true) !== "")
    throw new ConsumerRefusal("consumer-pr-exists", `origin already has ${branch}`);
  const releases = updates.map((u) => {
    const tag = `${u.profile.tagPrefix}${u.to}`;
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
      throw new ConsumerRefusal("release-missing", `${MIRROR_REPOSITORY} has no tag ${tag}`);
    return { ...u, tag, commit };
  });

  const startSha = git(REPO, ["rev-parse", "HEAD"]);
  // On a detached HEAD, --abbrev-ref prints "HEAD", which `git switch` refuses: detach instead.
  const startBranch = git(REPO, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const start = startBranch === "HEAD" ? startSha : startBranch;
  const restoreArgs =
    startBranch === "HEAD" ? ["switch", "-q", "--detach", startSha] : ["switch", "-q", startBranch];
  git(REPO, ["switch", "-q", "-c", branch]);
  const removeInstalled = () => {
    for (const u of releases)
      rmSync(path.join(REPO, "node_modules", ...u.profile.name.split("/")), {
        recursive: true,
        force: true,
      });
  };
  // Restores the starting branch, its files and its install: the previous exact versions.
  const rollback = (
    code: ConstructorParameters<typeof ConsumerRefusal>[0],
    message: string,
  ): never => {
    git(REPO, ["reset", "-q", "--hard", startSha]);
    for (const u of releases) git(REPO, ["clean", "-qfd", "--", u.profile.pinDir]);
    git(REPO, restoreArgs);
    git(REPO, ["branch", "-q", "-D", branch]);
    removeInstalled();
    // The failed install may have nested an older sibling inside another installed release
    // (github 0.4.0 → core 0.1.2). The lockfile does not list it, so a frozen install would
    // keep it and fail the pin guard later.
    const scope = path.join(REPO, "node_modules", "@comforge");
    if (existsSync(scope))
      for (const pkg of readdirSync(scope))
        rmSync(path.join(scope, pkg, "node_modules"), { recursive: true, force: true });
    sh("bun", ["install", "--frozen-lockfile"], { quiet: true });
    throw new ConsumerRefusal(
      code,
      `${message}; restored ${start} at ${startSha.slice(0, 12)} with ${releases.map((u) => `${u.profile.name}@${u.from}`).join(", ")}`,
    );
  };

  for (const u of releases)
    if (
      !sh("bun", [
        "tooling/release/npm-release.ts",
        "readback",
        "--package",
        u.profile.name,
        "--commit",
        u.commit,
        "--expect-provenance",
        "--write-pin",
        u.profile.pinDir,
      ])
    )
      return rollback(
        "readback-failed",
        `the registry artifact for ${u.profile.name}@${u.to} did not verify against ${u.tag}`,
      );

  const manifest = path.join(REPO, "package.json");
  let text = readFileSync(manifest, "utf8");
  for (const u of releases) text = setDependencyVersion(text, u.profile.name, u.from, u.to);
  writeFileSync(manifest, text);
  // Bun can keep a stale copy when only the version changes; reinstall the packages themselves.
  removeInstalled();
  if (!sh("bun", ["install"]) || !sh("bun", ["install", "--frozen-lockfile"]))
    return rollback("checks-failed", "bun install failed");
  // A dependent that still pins an unreleased sibling is tested against that sibling's
  // candidate; rewire them for the new install first.
  if (!sh("bun", ["tooling/release/candidates.ts", "ensure"]))
    return rollback("checks-failed", "the sibling candidates could not be rebuilt");
  // Prepared source switches that were waiting for exactly these releases land in the same
  // change, so the adoption is one reviewed step. One that is not ready is left untouched.
  const migrated: string[] = [];
  for (const migration of listMigrations(REPO)) {
    const status = statusOf(REPO, migration);
    if (status.missing.length > 0) continue;
    try {
      applyMigration(REPO, migration);
    } catch (error) {
      return rollback(
        "checks-failed",
        `the prepared consumer migration ${migration.id} could not be applied (${(error as Error).message})`,
      );
    }
    migrated.push(...status.files, MIGRATION_DIR);
    console.log(`applied consumer migration ${migration.id} (${status.files.length} files)`);
  }
  if (!sh("bun", ["test", "--isolate", ...allTests()]))
    return rollback("checks-failed", "the factory-core tests failed against the new versions");

  git(REPO, [
    "add",
    "-A",
    "--",
    "package.json",
    "bun.lock",
    ...releases.map((u) => u.profile.pinDir),
    ...new Set(migrated),
  ]);
  const names = releases.map((u) => `${u.profile.name} ${u.to}`).join(", ");
  const message = `build(architecture): consume ${names} from npm\n\n${releases.map((u) => `Comforge-Release: ${u.tag}@${u.commit}`).join("\n")}\n`;
  const committed = spawnSync("git", ["commit", "-q", "-F", "-"], {
    cwd: REPO,
    input: message,
    env: { ...process.env, SKIP_GIT_AI: "1" },
    stdio: ["pipe", "inherit", "inherit"],
  });
  if (committed.status !== 0) return rollback("checks-failed", "the commit hooks failed");
  for (const u of releases) console.log(`${u.direction} ${u.profile.name} ${u.from} → ${u.to}`);
  console.log(`committed on ${branch}`);
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
      `build(architecture): consume ${names} from npm`,
      "--body",
      `Generated by \`bun run release:adopt\`. ${releases.map((u) => `The registry artifact for ${u.profile.name}@${u.to} was read back file by file against \`${u.tag}\` (\`${u.commit}\`) with provenance.`).join(" ")} The packages move together so no installed release keeps a private copy of another. The factory-core tests passed on a fresh install. PR CI runs test:verify and the build. Nothing is merged or deployed automatically.`,
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
      process.exit(error instanceof ConsumerRefusal ? 1 : 2);
    });
}
