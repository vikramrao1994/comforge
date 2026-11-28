/**
 * The deterministic release planner for Comforge packages.
 *
 *  bun run release:plan [--head REF] [--json] [--registry]
 *  bun run release:version-pr [--head REF] [--open]
 *
 * Inputs, all read from Git at one commit (never the working tree): the consumer pin's
 * RELEASE.json (the last release whose npm artifact was independently read back), the
 * committed release intents added since that release's source commit, every non-merge
 * commit in between, and two candidate builds — the pinned source and HEAD — compared file
 * by file. No model, no provider, no network (except `--registry`, which only reads the
 * published version list), so a provider outage can never produce a guessed bump.
 *
 * The planner is the only writer of the version fields (package version, example
 * dependency, CHANGELOG section); the existing publisher (`release:build`) stays the
 * only writer of tags and the release branch. `version-pr` puts the planner's edit on its
 * own branch for review; it never writes main.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { releasedDir, unreleasedDependencies } from "./candidates";
import { buildCandidate, git, verifyCompiledExports } from "./mirror";
import { dependentsOf, PACKAGE_NAMES, pinFile, profileOf } from "./packages";
import {
  type Bump,
  bumpRank,
  INTENT_DIR,
  IntentError,
  intentTargets,
  isIntentFile,
  parseIntent,
  type ReleaseIntent,
  type ReleasePackage,
} from "./releaseIntent";

export const PLAN_SCHEMA = "comforge-release-plan/v1";
/** The version a package has before its first release (the publisher refuses to release it). */
export const UNRELEASED = "0.0.0";

export type PlanRefusalCode =
  | "baseline-unrelated"
  | "intent-invalid"
  | "intent-edited"
  | "intent-covers-unknown"
  | "uncovered-change"
  | "unclassified-change"
  | "breaking-unclassified"
  | "feature-unclassified"
  | "version-state-ambiguous"
  | "version-published"
  | "version-pr-exists"
  | "dirty-checkout"
  | "dependency-unreleased"
  | "dependency-drifted";

export class PlanRefusal extends Error {
  constructor(
    readonly code: PlanRefusalCode,
    message: string,
  ) {
    super(`release:plan refused (${code}): ${message}`);
  }
}
const refuse = (code: PlanRefusalCode, message: string): never => {
  throw new PlanRefusal(code, message);
};

export type CommitInfo = {
  sha: string;
  subject: string;
  /** Changes the package's source or its manifest other than `version`. */
  libraryChange: boolean;
  /** Intent files (paths) this commit added. */
  intentsAdded: string[];
};
export type IntentRecord = { file: string; intent: ReleaseIntent; addedIn: string };

export type PlanInput = {
  package: ReleasePackage;
  head: string;
  baseline: { version: string; sourceCommit: string; files: Record<string, string> };
  headVersion: string;
  changelog: string;
  /** File digests of a candidate built at HEAD, keyed like RELEASE.json `files`. */
  candidateFiles: Record<string, string>;
  /** Source manifest other than `version` changed since the baseline. */
  manifestChanged: boolean;
  exports: { before: string[]; after: string[] };
  commits: CommitInfo[];
  intents: IntentRecord[];
  editedIntents: string[];
  invalidIntents: { file: string; message: string }[];
  publishedVersions?: string[] | null;
  /** Versions with a committed release record (released/<id>/<version>) at `head`. */
  releasedVersions?: string[];
};

export type PlanStatus = "no-release" | "version-pr-due" | "release-ready";

export type ReleasePlan = {
  schema: typeof PLAN_SCHEMA;
  package: ReleasePackage;
  head: string;
  baseline: { version: string; sourceCommit: string };
  status: PlanStatus;
  reason: string;
  bump: Bump;
  currentVersion: string;
  nextVersion: string | null;
  intents: {
    file: string;
    bump: Bump;
    summary: string;
    breaking: string | null;
    addedIn: string;
  }[];
  changes: { library: string[]; distribution: string[] };
  api: { added: string[]; removed: string[] };
  commits: { total: number; library: number; coveredBy: Record<string, string> };
  changelogSection: string | null;
  digest: string;
};

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/**
 * SemVer with the documented pre-1.0 policy: below 1.0.0 the minor number is the
 * compatibility boundary, so a breaking change and a new feature both raise the minor
 * (0.1.2 → 0.2.0) and a patch stays a patch. 1.0.0 is a deliberate owner decision, never
 * the side effect of a major intent.
 */
export function applyBump(version: string, bump: Bump): string {
  const m = SEMVER.exec(version);
  if (!m) throw new Error(`${version} is not MAJOR.MINOR.PATCH`);
  const [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (bump === "none") return version;
  if (major === 0) return bump === "patch" ? `0.${minor}.${patch + 1}` : `0.${minor + 1}.0`;
  if (bump === "major") return `${major + 1}.0.0`;
  if (bump === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

const order = (a: IntentRecord, b: IntentRecord) =>
  bumpRank(b.intent.bump) - bumpRank(a.intent.bump) || a.file.localeCompare(b.file);

export function changelogSection(version: string, intents: IntentRecord[]): string {
  const lines = intents
    .filter((r) => r.intent.bump !== "none")
    .sort(order)
    .map((r) =>
      r.intent.breaking
        ? `- **Breaking:** ${r.intent.summary} ${r.intent.breaking}`
        : `- ${r.intent.summary}`,
    );
  return `## ${version}\n\n${lines.join("\n")}\n`;
}

/** The text of the `## version` section, without its heading, or null. */
export function changelogSectionOf(changelog: string, version: string): string | null {
  const lines = changelog.split("\n");
  const start = lines.findIndex((l) => l.trim() === `## ${version}`);
  if (start < 0) return null;
  const end = lines.findIndex((l, i) => i > start && l.startsWith("## "));
  return lines
    .slice(start, end < 0 ? undefined : end)
    .join("\n")
    .trimEnd();
}

/** Inserts the section above the newest entry, replacing an existing one for the same version. */
export function writeChangelogSection(changelog: string, section: string, version: string): string {
  const existing = changelogSectionOf(changelog, version);
  if (existing !== null) return changelog.replace(existing, section.trimEnd());
  const lines = changelog.split("\n");
  const first = lines.findIndex((l) => l.startsWith("## "));
  if (first < 0) return `${changelog.trimEnd()}\n\n${section}`;
  return [...lines.slice(0, first), section.trimEnd(), "", ...lines.slice(first)].join("\n");
}

/** Replaces only the top-level `"version"` value, keeping the file's formatting. */
export function setManifestVersion(text: string, from: string, to: string): string {
  const pattern = new RegExp(`^(  "version": )"${from.replaceAll(".", "\\.")}"`, "m");
  if (!pattern.test(text)) throw new Error(`manifest has no top-level "version": "${from}"`);
  return text.replace(pattern, `$1"${to}"`);
}

export function setDependencyVersion(text: string, name: string, from: string, to: string): string {
  const pattern = new RegExp(`("${name.replace("/", "\\/")}": )"${from.replaceAll(".", "\\.")}"`);
  if (!pattern.test(text)) throw new Error(`manifest does not depend on ${name} ${from} exactly`);
  return text.replace(pattern, `$1"${to}"`);
}

const canonical = (value: unknown): string =>
  JSON.stringify(value, (_k, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );
export const digestOf = (value: unknown) =>
  `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`;

const isLibraryFile = (file: string) => file.startsWith("src/") || file.startsWith("dist/");
const VERSION_DEPENDENT = new Set(["RELEASE.json", ".comforge-release.json"]);

/** Pure: decides the plan from collected evidence, or refuses. */
export function evaluatePlan(input: PlanInput): ReleasePlan {
  if (input.invalidIntents.length > 0)
    refuse("intent-invalid", input.invalidIntents.map((i) => `${i.file}: ${i.message}`).join("; "));
  if (input.editedIntents.length > 0)
    refuse(
      "intent-edited",
      `${input.editedIntents.join(", ")} changed after it was committed; an intent is immutable — add a new one instead`,
    );

  const intents = input.intents.filter((r) => intentTargets(r.intent, input.package));
  const inWindow = new Set(input.commits.map((c) => c.sha));
  const coveredBy: Record<string, string> = {};
  for (const record of intents)
    for (const sha of record.intent.covers) {
      if (!inWindow.has(sha))
        refuse(
          "intent-covers-unknown",
          `${record.file} covers ${sha}, which is not a commit since the ${input.baseline.version} release`,
        );
      coveredBy[sha] = record.file;
    }
  const own = new Set(intents.map((r) => r.file));
  const library = input.commits.filter((c) => c.libraryChange);
  for (const commit of library) {
    const added = commit.intentsAdded.find((f) => own.has(f));
    if (added) coveredBy[commit.sha] ??= added;
  }
  const uncovered = library.filter((c) => !coveredBy[c.sha]);
  if (uncovered.length > 0)
    refuse(
      "uncovered-change",
      `${uncovered.map((c) => `${c.sha.slice(0, 12)} "${c.subject}"`).join(", ")} changed ${input.package} without a release intent; add one in a new commit with "covers": [<sha>]`,
    );

  const changed = Object.keys({ ...input.baseline.files, ...input.candidateFiles })
    .filter((f) => !VERSION_DEPENDENT.has(f))
    .filter((f) => input.baseline.files[f] !== input.candidateFiles[f])
    .sort();
  const changes = {
    library: [
      ...changed.filter(isLibraryFile),
      ...(input.manifestChanged ? ["package.json (other than version)"] : []),
    ],
    distribution: changed.filter((f) => !isLibraryFile(f)),
  };
  const before = new Set(input.exports.before);
  const after = new Set(input.exports.after);
  const api = {
    added: [...after].filter((e) => !before.has(e)).sort(),
    removed: [...before].filter((e) => !after.has(e)).sort(),
  };

  const bump = intents.reduce<Bump>(
    (max, r) => (bumpRank(r.intent.bump) > bumpRank(max) ? r.intent.bump : max),
    "none",
  );
  if (api.removed.length > 0 && bump !== "major")
    refuse(
      "breaking-unclassified",
      `exports ${api.removed.join(", ")} were removed but no intent declares a major (breaking) change`,
    );
  if (api.added.length > 0 && bumpRank(bump) < bumpRank("minor"))
    refuse(
      "feature-unclassified",
      `exports ${api.added.join(", ")} were added but no intent declares at least a minor change`,
    );
  if (changes.library.length > 0 && bump === "none")
    refuse(
      "unclassified-change",
      `${changes.library.join(", ")} differ from the ${input.baseline.version} release, and no intent classifies them`,
    );

  const current = input.headVersion;
  const base = input.baseline.version;
  let status: PlanStatus;
  let reason: string;
  let nextVersion: string | null = null;
  let section: string | null = null;
  if (bump === "none") {
    if (current !== base)
      refuse(
        "version-state-ambiguous",
        `the package is ${current} but the last release is ${base} and no intent asks for a release`,
      );
    status = "no-release";
    reason =
      changes.distribution.length > 0
        ? `${changes.distribution.length} shipped file(s) differ, but no intent asks for a release; they wait for the next one`
        : "nothing shipped differs from the last release";
  } else {
    nextVersion = applyBump(base, bump);
    if (input.publishedVersions?.includes(nextVersion))
      refuse("version-published", `${input.package}@${nextVersion} is already on the registry`);
    if (input.releasedVersions?.includes(nextVersion))
      refuse(
        "version-published",
        `${input.package}@${nextVersion} is already released (its release record is committed); adopt it instead`,
      );
    section = changelogSection(nextVersion, intents);
    if (current === base) {
      status = "version-pr-due";
      reason = `${intents.length} intent(s) ask for a ${bump} release; version ${base} → ${nextVersion} needs its version PR`;
    } else if (current === nextVersion) {
      const written = changelogSectionOf(input.changelog, nextVersion);
      if (written === section.trimEnd()) {
        status = "release-ready";
        reason = `version ${nextVersion} and its changelog match the accepted intents`;
      } else {
        status = "version-pr-due";
        reason = `the ## ${nextVersion} changelog section does not match the accepted intents; refresh the version PR`;
      }
    } else {
      return refuse(
        "version-state-ambiguous",
        `the package is ${current}; the accepted intents give ${base} → ${nextVersion}`,
      );
    }
  }

  const body = {
    schema: PLAN_SCHEMA,
    package: input.package,
    head: input.head,
    baseline: { version: base, sourceCommit: input.baseline.sourceCommit },
    status,
    reason,
    bump,
    currentVersion: current,
    nextVersion,
    intents: intents.sort(order).map((r) => ({
      file: r.file,
      bump: r.intent.bump,
      summary: r.intent.summary,
      breaking: r.intent.breaking,
      addedIn: r.addedIn,
    })),
    changes,
    api,
    commits: { total: input.commits.length, library: library.length, coveredBy },
    changelogSection: section,
  } satisfies Omit<ReleasePlan, "digest">;
  return { ...body, digest: digestOf(body) };
}

// ── Collection from Git ──────────────────────────────────────────────────────

const show = (repo: string, rev: string, file: string) =>
  git(repo, ["show", `${rev}:${file}`], true);

const withoutVersion = (text: string) => {
  try {
    const { version: _v, ...rest } = JSON.parse(text) as Record<string, unknown>;
    return canonical(rest);
  } catch {
    return text;
  }
};

/**
 * A source file with the package's version constant set to a placeholder: a commit that changes
 * only that literal (the version step's own edit) is not a library change.
 */
export const withoutVersionConstant = (text: string, name: string) =>
  text.replace(new RegExp(`^export const ${name} = "[^"]*";$`, "m"), `export const ${name} = "";`);

/** Intents committed since `baseline` at `head`, with the commit that added each. */
export function collectIntents(repo: string, baseline: string, head: string) {
  const intents: IntentRecord[] = [];
  const invalidIntents: { file: string; message: string }[] = [];
  const editedIntents: string[] = [];
  const status = git(repo, [
    "diff",
    "--name-status",
    "--no-renames",
    baseline,
    head,
    "--",
    INTENT_DIR,
  ]);
  for (const line of status.split("\n").filter(Boolean)) {
    const [code, file] = line.split("\t") as [string, string];
    if (file === `${INTENT_DIR}/README.md`) continue;
    if (!isIntentFile(file)) {
      if (code !== "D")
        invalidIntents.push({ file, message: `not a ${INTENT_DIR}/<name>.json file` });
      continue;
    }
    if (code === "M") {
      editedIntents.push(file);
      continue;
    }
    if (code !== "A") continue;
    const log = git(repo, [
      "log",
      "--format=%H",
      "--diff-filter=AM",
      "--no-renames",
      `${baseline}..${head}`,
      "--",
      file,
    ]).split("\n");
    if (log.length > 1) editedIntents.push(file);
    try {
      intents.push({
        file,
        intent: parseIntent(file, show(repo, head, file)),
        addedIn: log.at(-1) ?? "",
      });
    } catch (error) {
      invalidIntents.push({
        file,
        message:
          error instanceof IntentError ? error.message.slice(file.length + 2) : String(error),
      });
    }
  }
  return { intents, invalidIntents, editedIntents };
}

export function collectCommits(
  repo: string,
  pkg: ReleasePackage,
  baseline: string,
  head: string,
): CommitInfo[] {
  const { dir, versionConstant } = profileOf(pkg);
  const constantFile = versionConstant ? `${dir}/${versionConstant.file}` : null;
  const shas = git(repo, ["rev-list", "--reverse", "--no-merges", `${baseline}..${head}`])
    .split("\n")
    .filter(Boolean);
  return shas.map((sha) => {
    const lines = git(repo, [
      "diff-tree",
      "--no-commit-id",
      "-r",
      "--name-status",
      "--no-renames",
      "--root",
      sha,
    ])
      .split("\n")
      .filter(Boolean)
      .map((l) => l.split("\t") as [string, string]);
    const files = lines.map(([, f]) => f);
    const manifest = `${dir}/package.json`;
    const manifestChange =
      files.includes(manifest) &&
      withoutVersion(show(repo, `${sha}^`, manifest)) !== withoutVersion(show(repo, sha, manifest));
    const onlyConstant = (f: string) =>
      f === constantFile &&
      versionConstant !== undefined &&
      withoutVersionConstant(show(repo, `${sha}^`, f), versionConstant.name) ===
        withoutVersionConstant(show(repo, sha, f), versionConstant.name);
    return {
      sha,
      subject: git(repo, ["log", "-1", "--format=%s", sha]),
      libraryChange:
        manifestChange || files.some((f) => f.startsWith(`${dir}/src/`) && !onlyConstant(f)),
      intentsAdded: lines.filter(([code, f]) => code === "A" && isIntentFile(f)).map(([, f]) => f),
    };
  });
}

type Pin = { version: string; source: { commit: string }; files: Record<string, string> };

/**
 * A package's planning baseline: its pinned, independently read-back release; or, before its
 * first release, the placeholder 0.0.0 with no shipped files at the parent of the commit that
 * introduced the package, so every commit of the package is in the window and needs an intent.
 */
export const ANCHOR_FILE = "releases/baseline/anchor.json";

/**
 * A baseline built before the packages moved to this repository names a source commit that
 * does not exist here. The reviewed anchor file maps it to the import commit that brought the
 * same sources; without an entry the commit stays foreign and the plan refuses
 * (`baseline-unrelated`), as before.
 */
export function anchoredCommit(repo: string, head: string, commit: string): string {
  if (spawnSync("git", ["cat-file", "-e", `${commit}^{commit}`], { cwd: repo }).status === 0)
    return commit;
  const text = show(repo, head, ANCHOR_FILE);
  if (!text) return commit;
  const anchors = (JSON.parse(text) as { anchors?: Record<string, string> }).anchors ?? {};
  return anchors[commit] ?? commit;
}

export function baselineOf(repo: string, head: string, pkg: ReleasePackage) {
  const profile = profileOf(pkg);
  const pinned = show(repo, head, pinFile(profile));
  if (pinned) {
    const pin = JSON.parse(pinned) as Pin;
    return {
      version: pin.version,
      sourceCommit: anchoredCommit(repo, head, pin.source.commit),
      files: pin.files,
      firstRelease: false,
    };
  }
  const intro = git(repo, [
    "log",
    "--format=%H",
    "--diff-filter=A",
    head,
    "--",
    `${profile.dir}/package.json`,
  ])
    .split("\n")
    .filter(Boolean)
    .at(-1);
  if (!intro)
    return refuse(
      "baseline-unrelated",
      `${profile.dir}/package.json is not in the history of ${head}`,
    );
  const parent = git(repo, ["rev-parse", "-q", "--verify", `${intro}^`], true);
  if (!parent)
    return refuse("baseline-unrelated", `${pkg} was introduced by a root commit; no baseline`);
  return {
    version: UNRELEASED,
    sourceCommit: parent,
    files: {} as Record<string, string>,
    firstRelease: true,
  };
}

/** Builds both candidates and collects every planner input at `head`. */
export function collectPlanInput(
  repo: string,
  head: string,
  pkg: ReleasePackage = "@comforge/core",
  /**
   * A release group versioned together (one version PR): a sibling that is in the group and
   * unreleased is versioned in the same PR, ahead of `pkg`, so it does not refuse the plan. It
   * must still be released, read back and recorded before `pkg` is approved (approve plans
   * without a group). Drift is refused as always.
   */
  group: readonly ReleasePackage[] = [],
): PlanInput {
  const profile = profileOf(pkg);
  const base = baselineOf(repo, head, pkg);
  const baseline = base.sourceCommit;
  if (spawnSync("git", ["merge-base", "--is-ancestor", baseline, head], { cwd: repo }).status !== 0)
    refuse(
      "baseline-unrelated",
      `the pinned release source ${baseline} is not an ancestor of ${head}`,
    );
  // Dependency order: a package that pins an unreleased sibling candidate is planned only
  // after that sibling is published, read back and pinned here (tooling/release/candidates.ts).
  // A sibling counts as released once its verified readback is committed (released/<id>/<v>)
  // and its source is still the tree that release was built from; adoption may follow later,
  // together with its adoption group.
  const pending = unreleasedDependencies(pkg, repo, head);
  const drifted = pending.filter((d) => d.reason === "drifted").map((d) => d.name);
  if (drifted.length > 0)
    refuse(
      "dependency-drifted",
      `${pkg} pins ${drifted.join(", ")}, whose source changed after the released version was built; release the change first`,
    );
  const unreleased = pending.map((d) => d.name).filter((name) => !group.includes(name));
  if (unreleased.length > 0)
    refuse(
      "dependency-unreleased",
      `${pkg} pins unreleased candidate(s) ${unreleased.join(", ")}; release them and commit their release record (or pin them) first`,
    );
  const { dir } = profile;
  const staging = path.join(repo, "generated", "release-plan-staging");
  mkdirSync(path.join(repo, "generated"), { recursive: true });
  const out = mkdtempSync(path.join(repo, "generated", "release-plan-"));
  try {
    const built = (commit: string, name: string) => {
      const c = buildCandidate({
        repo,
        sourceCommit: commit,
        outDir: path.join(out, name),
        stagingRoot: staging,
        profile,
        planning: true,
      });
      try {
        return { candidate: c, exports: verifyCompiledExports(c.dir, staging, c.siblingModules) };
      } finally {
        if (c.siblingModules) rmSync(c.siblingModules, { recursive: true, force: true });
      }
    };
    const before = base.firstRelease ? null : built(baseline, "baseline");
    const after = built(head, "head");
    const subpaths = (rev: string) =>
      Object.keys(
        (JSON.parse(show(repo, rev, `${dir}/package.json`)) as { exports: object }).exports,
      ).map((k) => `subpath ${k}`);
    return {
      package: pkg,
      head,
      baseline: { version: base.version, sourceCommit: baseline, files: base.files },
      headVersion: (JSON.parse(show(repo, head, `${dir}/package.json`)) as { version: string })
        .version,
      changelog: show(repo, head, `${dir}/CHANGELOG.md`),
      candidateFiles: after.candidate.release.files,
      manifestChanged: base.firstRelease
        ? true
        : withoutVersion(show(repo, baseline, `${dir}/package.json`)) !==
          withoutVersion(show(repo, head, `${dir}/package.json`)),
      exports: {
        before: before ? [...before.exports, ...subpaths(baseline)] : [],
        after: [...after.exports, ...subpaths(head)],
      },
      commits: collectCommits(repo, pkg, baseline, head),
      releasedVersions: git(repo, [
        "ls-tree",
        "--name-only",
        head,
        `${path.posix.dirname(releasedDir(pkg, "0.0.0"))}/`,
      ])
        .split("\n")
        .filter(Boolean)
        .map((p) => path.posix.basename(p)),
      ...collectIntents(repo, baseline, head),
    };
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

/** Whether `version` satisfies an exact or caret range (the only forms the manifests use). */
export function satisfiesRange(version: string, range: string): boolean | null {
  if (range.includes("||")) {
    const each = range.split("||").map((r) => satisfiesRange(version, r.trim()));
    return each.includes(null) ? null : each.includes(true);
  }
  const parse = (v: string) =>
    SEMVER.exec(v)?.slice(1, 4).map(Number) as [number, number, number] | undefined;
  const v = parse(version);
  if (!v) return null;
  if (SEMVER.test(range)) return range === version;
  const caret = /^\^(.+)$/.exec(range);
  const r = caret ? parse(caret[1] as string) : undefined;
  if (!r) return null;
  const cmp = v[0] - r[0] || v[1] - r[1] || v[2] - r[2];
  if (cmp < 0) return false;
  if (r[0] > 0) return v[0] === r[0];
  if (r[1] > 0) return v[0] === 0 && v[1] === r[1];
  return v[0] === 0 && v[1] === 0 && v[2] === r[2];
}

export type DependencyImpact = {
  /** Registry packages whose manifest depends on this one, and whether its next version fits. */
  dependents: { package: ReleasePackage; range: string; nextSatisfies: boolean | null }[];
  /** This package's registry dependencies and whether the version installed here fits. */
  dependencies: {
    package: ReleasePackage;
    range: string;
    installed: string | null;
    satisfied: boolean | null;
  }[];
};

/**
 * Cross-package impact, advisory: a dependent whose range excludes this package's next version
 * needs its own intent (widen the range, test, release); nothing is bumped automatically.
 */
export function dependencyImpact(repo: string, head: string, plan: ReleasePlan): DependencyImpact {
  const manifest = (pkg: ReleasePackage) =>
    JSON.parse(show(repo, head, `${profileOf(pkg).dir}/package.json`) || "{}") as {
      dependencies?: Record<string, string>;
    };
  const installed = (pkg: ReleasePackage) => {
    try {
      return (
        JSON.parse(readFileSync(path.join(repo, "node_modules", pkg, "package.json"), "utf8")) as {
          version: string;
        }
      ).version;
    } catch {
      return null;
    }
  };
  return {
    dependents: dependentsOf(plan.package).map((dependent) => {
      const range = manifest(dependent).dependencies?.[plan.package] ?? "(none)";
      return {
        package: dependent,
        range,
        nextSatisfies: plan.nextVersion ? satisfiesRange(plan.nextVersion, range) : null,
      };
    }),
    dependencies: profileOf(plan.package).dependsOn.map((dep) => {
      const range = manifest(plan.package).dependencies?.[dep] ?? "(none)";
      const version = installed(dep);
      return {
        package: dep,
        range,
        installed: version,
        satisfied: version ? satisfiesRange(version, range) : null,
      };
    }),
  };
}

export async function publishedVersions(
  name: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string[]> {
  const res = await fetchImpl(`https://registry.npmjs.org/${name.replace("/", "%2f")}`);
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`registry returned HTTP ${res.status} for ${name}`);
  return Object.keys(((await res.json()) as { versions?: object }).versions ?? {});
}

// ── Version PR ───────────────────────────────────────────────────────────────

export const versionBranch = (plan: Pick<ReleasePlan, "package" | "nextVersion">) =>
  `comforge-release/${profileOf(plan.package).tagPrefix}${plan.nextVersion}`;

/**
 * The packages of a group version PR in dependency order (registry order is dependency order:
 * assertRegistry refuses a package listed before one it depends on), refusing duplicates.
 */
export function groupOrder(names: readonly string[]): ReleasePackage[] {
  const resolved = names.map((n) => profileOf(n).name);
  if (new Set(resolved).size !== resolved.length) throw new Error("a package is listed twice");
  return PACKAGE_NAMES.filter((n) => resolved.includes(n));
}

/** The branch of a group version PR: its packages in dependency order. */
export const groupBranch = (group: readonly ReleasePackage[]) =>
  `comforge-release/group-${group.map((g) => profileOf(g).tagPrefix.replace(/\/v$/, "")).join("-")}`;

/** Writes the planner's version edit into `repo`'s working tree. */
export function writeVersionFiles(repo: string, plan: ReleasePlan): string[] {
  if (plan.status !== "version-pr-due" || !plan.nextVersion || !plan.changelogSection)
    throw new Error(`plan is ${plan.status}; nothing to version`);
  const { dir, example, versionConstant } = profileOf(plan.package);
  const edit = (file: string, fn: (text: string) => string) => {
    const full = path.join(repo, file);
    writeFileSync(full, fn(readFileSync(full, "utf8")));
    return file;
  };
  const next = plan.nextVersion;
  const current = plan.currentVersion;
  return [
    edit(`${dir}/package.json`, (t) =>
      current === next ? t : setManifestVersion(t, current, next),
    ),
    edit(`${example}/package.json`, (t) =>
      current === next ? t : setDependencyVersion(t, plan.package, current, next),
    ),
    edit(`${dir}/CHANGELOG.md`, (t) =>
      writeChangelogSection(t, plan.changelogSection as string, next),
    ),
    ...(versionConstant && current !== next
      ? [
          edit(`${dir}/${versionConstant.file}`, (t) =>
            setVersionConstant(t, versionConstant.name, current, next),
          ),
        ]
      : []),
  ];
}

/** Rewrites `export const NAME = "<current>";`; refuses when the literal is not exactly there. */
export function setVersionConstant(
  text: string,
  name: string,
  current: string,
  next: string,
): string {
  const line = `export const ${name} = "${current}";`;
  if (text.split(line).length !== 2)
    throw new Error(`${name} is not exactly "${current}"; refusing to version`);
  return text.replace(line, `export const ${name} = "${next}";`);
}

export function renderPlan(plan: ReleasePlan): string {
  const lines = [
    `${plan.package}: ${plan.status} — ${plan.reason}`,
    `  head ${plan.head.slice(0, 12)} · last release ${plan.baseline.version} (source ${plan.baseline.sourceCommit.slice(0, 12)}) · package ${plan.currentVersion}`,
    `  bump ${plan.bump}${plan.nextVersion ? ` → ${plan.nextVersion}` : ""} · ${plan.commits.total} commit(s), ${plan.commits.library} touching the library`,
    ...plan.intents.map((i) => `  intent ${i.bump.padEnd(5)} ${i.file}: ${i.summary}`),
    ...(plan.changes.library.length
      ? [`  library changes: ${plan.changes.library.join(", ")}`]
      : []),
    ...(plan.changes.distribution.length
      ? [`  distribution changes: ${plan.changes.distribution.join(", ")}`]
      : []),
    ...(plan.api.added.length ? [`  exports added: ${plan.api.added.join(", ")}`] : []),
    ...(plan.api.removed.length ? [`  exports removed: ${plan.api.removed.join(", ")}`] : []),
    `  plan digest ${plan.digest}`,
  ];
  const flag = plan.package === "@comforge/core" ? "" : ` --package ${plan.package}`;
  if (plan.status === "version-pr-due")
    lines.push(`  next: bun run release:version-pr --open${flag}`);
  if (plan.status === "release-ready")
    lines.push(
      "  next: on main, release.yml starts once CI is green; approve its comforge-release environment",
    );
  return lines.join("\n");
}

export function renderImpact(impact: DependencyImpact): string[] {
  const fits = (v: boolean | null) => (v === null ? "unknown" : v ? "yes" : "NO");
  return [
    ...impact.dependents.map(
      (d) =>
        `  dependent ${d.package} requires ${d.range}; next version fits: ${fits(d.nextSatisfies)}${d.nextSatisfies === false ? " (it needs its own intent to widen the range, then its own release)" : ""}`,
    ),
    ...impact.dependencies.map(
      (d) =>
        `  depends on ${d.package} ${d.range}; installed ${d.installed ?? "none"}, fits: ${fits(d.satisfied)}`,
    ),
  ];
}

function main(argv: string[]): Promise<number> | number {
  const repo = path.resolve(import.meta.dir, "..", "..");
  const arg = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const command = argv[0];
  const head = git(repo, ["rev-parse", arg("--head") ?? "HEAD"]);
  const pkg = profileOf(arg("--package") ?? "@comforge/core").name;
  const run = async () => {
    if (command === "plan") {
      // Each package on its own (`--all`: every registry package); one verdict never moves another.
      const plans = [];
      for (const name of argv.includes("--all") ? PACKAGE_NAMES : [pkg]) {
        const input = collectPlanInput(repo, head, name);
        if (argv.includes("--registry")) input.publishedVersions = await publishedVersions(name);
        const plan = evaluatePlan(input);
        plans.push(plan);
        if (!argv.includes("--json"))
          console.log(
            [renderPlan(plan), ...renderImpact(dependencyImpact(repo, head, plan)), ""].join("\n"),
          );
      }
      const result = argv.includes("--all") ? plans : plans[0];
      if (argv.includes("--json")) console.log(JSON.stringify(result, null, 2));
      const out = arg("--out");
      if (out) writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
      return 0;
    }
    // version-pr: one package, or a group (`--package` repeated) versioned in one PR: one
    // commit per package in dependency order, each planned on top of the previous version
    // commit (a dependent's candidate needs its sibling at the version it pins), each with its
    // own Release-Plan trailer.
    const names = argv.flatMap((a, i) => (a === "--package" ? [argv[i + 1] as string] : []));
    const group = groupOrder(names.length > 0 ? names : [pkg]);
    if (git(repo, ["status", "--porcelain", "--untracked-files=no"]) !== "")
      refuse("dirty-checkout", "commit or discard tracked changes first");
    const start = git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]);
    const plans: ReleasePlan[] = [];
    let branch: string | null = null;
    const abandon = (why: string) => {
      if (branch) {
        git(repo, ["reset", "-q", "--hard", head]);
        git(repo, ["switch", "-q", start]);
        git(repo, ["branch", "-q", "-D", branch]);
      }
      return why;
    };
    for (const name of group) {
      const at = git(repo, ["rev-parse", "HEAD"]);
      let plan: ReleasePlan;
      try {
        const input = collectPlanInput(repo, at, name, group.length > 1 ? group : []);
        if (argv.includes("--registry")) input.publishedVersions = await publishedVersions(name);
        plan = evaluatePlan(input);
      } catch (error) {
        abandon("planning failed");
        throw error;
      }
      console.log(renderPlan(plan));
      if (plan.status !== "version-pr-due") {
        console.log(
          `no version PR: ${plan.package} is ${plan.status}; ${abandon("nothing was committed or pushed")}`,
        );
        return 0;
      }
      if (!branch) {
        branch = group.length === 1 ? versionBranch(plan) : groupBranch(group);
        if (git(repo, ["ls-remote", "origin", `refs/heads/${branch}`], true) !== "")
          refuse(
            "version-pr-exists",
            `origin already has ${branch}; review or close that PR first`,
          );
        git(repo, ["switch", "-q", "-c", branch, head]);
      }
      const files = writeVersionFiles(repo, plan);
      git(repo, ["add", "--", ...files]);
      const message = `build(architecture): version ${plan.package} ${plan.nextVersion}\n\nRelease-Plan: ${plan.digest}\n`;
      const commit = spawnSync("git", ["commit", "-q", "-F", "-"], {
        cwd: repo,
        input: message,
        env: { ...process.env, SKIP_GIT_AI: "1" },
        stdio: ["pipe", "inherit", "inherit"],
      });
      if (commit.status !== 0)
        throw new Error(
          `a version commit failed; ${abandon("the branch was removed and nothing was pushed")}`,
        );
      plans.push(plan);
    }
    console.log(`version commit(s) on ${branch}`);
    if (!argv.includes("--open")) {
      console.log(`review it, then: git push -u origin ${branch} && gh pr create --head ${branch}`);
      return 0;
    }
    git(repo, ["push", "-q", "-u", "origin", branch as string]);
    const title =
      plans.length === 1
        ? `build(architecture): version ${plans[0]?.package} ${plans[0]?.nextVersion}`
        : `build(architecture): version ${plans.map((p) => `${p.package} ${p.nextVersion}`).join(", ")}`;
    const body = [
      `Version PR generated by \`bun run release:version-pr\` from ${head}.`,
      "",
      ...plans.flatMap((plan) => ["```", renderPlan(plan), "```", ""]),
      ...(plans.length > 1
        ? [
            "A release group: each package is still approved, published, read back and recorded on its own, in this order; a dependent's approval waits for its siblings' release records.",
            "",
          ]
        : []),
      "Merging this does not publish anything: the release itself still needs the publisher workflow and its approvals.",
    ].join("\n");
    const pr = spawnSync(
      "gh",
      [
        "pr",
        "create",
        "--head",
        branch as string,
        "--base",
        "main",
        "--title",
        title,
        "--body",
        body,
      ],
      { cwd: repo, stdio: "inherit" },
    );
    return pr.status === 0 ? 0 : 1;
  };
  return run();
}

if (import.meta.main) {
  Promise.resolve()
    .then(() => main(process.argv.slice(2)))
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error((error as Error).message);
      process.exit(error instanceof PlanRefusal ? 1 : 2);
    });
}
