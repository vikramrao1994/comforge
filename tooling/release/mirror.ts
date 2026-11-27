/**
 * The Comforge release publisher: builds a
 * versioned, inspectable copy of one registry package (tooling/release/packages.ts;
 * `@comforge/core` by default) from one committed source revision, syncs it into that
 * package's release branch of a checkout of the Comforge repository, and commits, tags
 * and pushes a new immutable release. Each package has its own branch, tag prefix and
 * owned paths; a candidate's package comes from its own RELEASE.json.
 *
 * This repository's main is the only authoritative source. The release branches are
 * distribution targets: nobody edits it, and the publisher refuses to overwrite anything it did not
 * write itself. Design reused from the profile publisher (scripts/github-profile):
 * deterministic generation, a scoped set of owned destination paths, dry run first,
 * no-op on identical output, never a force push.
 *
 * Every refusal throws a ReleaseRefusal with a stable `code`; tests assert the codes.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  compileDistribution,
  compilerVersion,
  DOCUMENTS,
  distributionManifest,
  type Manifest,
  packStaged,
} from "./pack";
import { CORE, isPackageName, type PackageProfile, profileOf, sourceInputs } from "./packages";

/** Proposed private destination. Not provisioned: creating it is the owner's Gate C decision. */
export const MIRROR_REPOSITORY = "vikramrao1994/comforge";
/**
 * The only branch the publisher writes. Each Comforge package is released on its own
 * branch with the package at the branch root, because Bun cannot install a git dependency
 * from a subdirectory; `main` is left for the modular source and is never written.
 */
/** Absolute URL of `examples/` in a release's tagged tree (README and llms.txt links). */
export const exampleLinkBase = (version: string, profile: PackageProfile = CORE) =>
  `https://github.com/${MIRROR_REPOSITORY}/tree/${profile.tagPrefix}${version}/examples/`;
export const RELEASE_SCHEMA = "comforge-release/v1";
export const OWNERSHIP_SCHEMA = "comforge-release-ownership/v1";
export const RELEASE_FILE = "RELEASE.json";
export const OWNERSHIP_FILE = ".comforge-release.json";

/**
 * Licence files shipped when the package source has them. The publisher never chooses
 * a licence: a release without one is a publication blocker (`publicationBlockers`).
 */
export const LICENSE_FILES = ["LICENSE", "NOTICE"] as const;

/**
 * SHA-256 of each licence's canonical, unmodified text, keyed by SPDX id. A release ships
 * only a licence recorded here, so a truncated, reformatted or mismatched LICENSE blocks it.
 * Apache-2.0 is https://www.apache.org/licenses/LICENSE-2.0.txt byte for byte.
 */
export const CANONICAL_LICENSE_TEXTS: Readonly<Record<string, string>> = {
  "Apache-2.0": "cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30",
};

/**
 * Destination paths the publisher owns on a package's release branch. Every other path in
 * the mirror is left untouched.
 */
export const ownedFiles = (profile: PackageProfile): readonly string[] => [
  "package.json",
  "README.md",
  "llms.txt",
  "CHANGELOG.md",
  ...LICENSE_FILES,
  RELEASE_FILE,
  OWNERSHIP_FILE,
  ...Object.keys(profile.assets),
];
export const ownedDirs = (profile: PackageProfile): readonly string[] => [
  "dist",
  "src",
  profile.example,
];

export type RefusalCode =
  | "source-missing"
  | "source-dirty"
  | "source-unverified"
  | "malformed-manifest"
  | "malformed-version"
  | "changelog-missing"
  | "not-reproducible"
  | "privacy-finding"
  | "broken-link"
  | "validation-failed"
  | "destination-not-git"
  | "destination-branch"
  | "destination-dirty"
  | "unexpected-file"
  | "modified-outside-publisher"
  | "version-reused"
  | "version-regression"
  | "tag-changed"
  | "untrusted-destination"
  | "approval-missing"
  | "destination-moved"
  | "push-rejected"
  | "destination-uninitialized"
  | "publication-blocked"
  | "workflow-change-unapproved"
  | "workflow-permission";

export class ReleaseRefusal extends Error {
  readonly code: RefusalCode;
  constructor(code: RefusalCode, message: string) {
    super(`release:build refused (${code}): ${message}`);
    this.code = code;
  }
}

const refuse = (code: RefusalCode, message: string): never => {
  throw new ReleaseRefusal(code, message);
};

export function git(cwd: string, args: string[], allowFailure = false): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0 && !allowFailure)
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${(r.stderr || r.stdout).trim()}`);
  return r.status === 0 ? r.stdout.trim() : "";
}

const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

/** Every regular file under `root`, as sorted POSIX relative paths, skipping `.git`. */
export function listFiles(root: string, dir = ""): string[] {
  const out: string[] = [];
  const here = path.join(root, dir);
  if (!existsSync(here)) return out;
  for (const entry of readdirSync(here).sort()) {
    if (entry === ".git" && dir === "") continue;
    const rel = dir ? `${dir}/${entry}` : entry;
    if (statSync(path.join(root, rel)).isDirectory()) out.push(...listFiles(root, rel));
    else out.push(rel);
  }
  return out;
}

export const isOwnedBy = (profile: PackageProfile, file: string) =>
  ownedFiles(profile).includes(file) ||
  ownedDirs(profile).some((dir) => file.startsWith(`${dir}/`));

/** The registry profile a candidate or release record names. */
const profileOfRecord = (release: { package: string }): PackageProfile => {
  try {
    return profileOf(release.package);
  } catch {
    return refuse("malformed-manifest", `${release.package} is not a registry package`);
  }
};

// ── Version and changelog ────────────────────────────────────────────────────

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** A release version: strict MAJOR.MINOR.PATCH, and never the workspace placeholder 0.0.0. */
export function assertReleaseVersion(version: unknown): string {
  if (typeof version !== "string" || !SEMVER.test(version))
    return refuse(
      "malformed-version",
      `version ${JSON.stringify(version)} is not MAJOR.MINOR.PATCH`,
    );
  if (version === "0.0.0")
    return refuse(
      "malformed-version",
      "0.0.0 is the unreleased placeholder; set a release version",
    );
  return version;
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return (pa[i] as number) - (pb[i] as number);
  return 0;
}

export function assertChangelogEntry(changelog: string | null, version: string): void {
  if (changelog === null) refuse("changelog-missing", "packages/core/CHANGELOG.md is missing");
  const heading = new RegExp(`^## ${version.replaceAll(".", "\\.")}(\\s|$)`, "m");
  if (!heading.test(changelog as string))
    refuse("changelog-missing", `CHANGELOG.md has no "## ${version}" entry`);
}

// ── Disclosure scan ──────────────────────────────────────────────────────────

/**
 * Content that must never reach the mirror, even a private one: credentials and key
 * material, personal or machine identifiers, and private repository identities and
 * internal paths. The kernel is published under neutral example identities only.
 */
export const DISCLOSURE_RULES: ReadonlyArray<{ id: string; pattern: RegExp }> = [
  { id: "private-key-block", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  {
    id: "github-token",
    pattern: /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}/,
  },
  {
    id: "provider-key",
    pattern: /\bsk-(ant-)?[A-Za-z0-9_-]{20,}|\bAKIA[0-9A-Z]{16}\b|\bxox[abpr]-[A-Za-z0-9-]{10,}/,
  },
  { id: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\./ },
  {
    id: "email-address",
    pattern:
      /[A-Za-z0-9._%+-]+@(?!example\.(?:com|org|net|invalid)\b)[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/,
  },
  { id: "local-path", pattern: /\/Users\/[A-Za-z]|\/home\/[a-z]|[A-Z]:\\\\Users\\\\/ },
  { id: "owner-identity", pattern: /vikram|portfolio-mcp|portfolio-engineering|portfolio-agent/i },
  {
    id: "internal-ticket",
    pattern: /\b(?:ENGINEERING|GITHUB|CAREER|PHOTOGRAPHY|ADMIN|FRONTEND)-[A-Z-]*\d{3}/,
  },
  {
    id: "portfolio-path",
    pattern:
      /\b(?:docs\/engineering|src\/lib|scripts\/(?:engineering|git|factory-core)|tests\/unit|packages\/factory-core)\b/,
  },
  { id: "env-file", pattern: /(^|\/)\.env(\.|$)/ },
];

export type DisclosureFinding = { file: string; line: number; rule: string };

export function scanForDisclosure(root: string): DisclosureFinding[] {
  const findings: DisclosureFinding[] = [];
  for (const file of listFiles(root)) {
    if (file.endsWith(".tgz")) continue;
    for (const rule of DISCLOSURE_RULES.filter((r) => r.id === "env-file"))
      if (rule.pattern.test(file)) findings.push({ file, line: 0, rule: rule.id });
    // The release's own public home is the one owner-named string a release may contain.
    const lines = readFileSync(path.join(root, file), "utf8")
      .replaceAll(`github.com/${MIRROR_REPOSITORY}`, "github.com/<release-repository>")
      .split("\n");
    lines.forEach((text, index) => {
      for (const rule of DISCLOSURE_RULES)
        if (rule.id !== "env-file" && rule.pattern.test(text))
          findings.push({ file, line: index + 1, rule: rule.id });
    });
  }
  return findings;
}

/**
 * Relative links in the shipped documents (Markdown and llms.txt) must resolve inside the
 * candidate: no links outside the release.
 */
export function brokenRelativeLinks(root: string): string[] {
  const broken: string[] = [];
  for (const file of listFiles(root).filter((f) => f.endsWith(".md") || f.endsWith(".txt"))) {
    const text = readFileSync(path.join(root, file), "utf8");
    for (const [, target] of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      if (!target || /^[a-z]+:|^#/i.test(target)) continue;
      const resolved = path.posix.normalize(
        path.posix.join(path.posix.dirname(file), target.split("#")[0] as string),
      );
      if (resolved.startsWith("..") || !existsSync(path.join(root, resolved)))
        broken.push(`${file} → ${target}`);
    }
  }
  return broken;
}

// ── Candidate ────────────────────────────────────────────────────────────────

export type ReleaseRecord = {
  schema: typeof RELEASE_SCHEMA;
  package: string;
  version: string;
  tag: string;
  source: { commit: string; packageTree: string; exampleTree: string };
  toolchain: { typescript: string };
  tarball: { file: string; sha256: string; integrity: string };
  files: Record<string, string>;
};

export type Candidate = {
  dir: string;
  tarball: string;
  release: ReleaseRecord;
  /**
   * The sibling distributions the package was compiled against (`stageSiblings`), for
   * `verifyCompiledExports`; null when every registry dependency is the installed release.
   * Lives in `stagingRoot`: the caller removes it.
   */
  siblingModules: string | null;
};

const EXACT = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

const installedVersion = (repo: string, name: string): string | null => {
  const file = path.join(repo, "node_modules", ...name.split("/"), "package.json");
  return existsSync(file)
    ? (JSON.parse(readFileSync(file, "utf8")) as { version: string }).version
    : null;
};

/**
 * Compiles, into `into` (a package's node_modules), every registry sibling the manifest pins
 * exactly at a version the repository does not have installed: its distribution (dist,
 * manifest, documents) from `sourceCommit`, its own such siblings first. This is how a package
 * released ahead of its dependents' adoption (core 0.2.0 while 0.1.2 is installed) is built and
 * import-checked against: the planner admits it only with a committed release record whose
 * `src/` equals the sibling's source at the planned head (tooling/release/candidates.ts),
 * so this compiles what npm serves. Never shipped: the tree carries dist, src, example and docs.
 */
function stageSiblings(
  repo: string,
  sourceCommit: string,
  dependencies: Record<string, string> | undefined,
  into: string,
  stagingRoot: string,
): void {
  for (const [name, declared] of Object.entries(dependencies ?? {})) {
    if (!isPackageName(name) || !EXACT.test(declared) || installedVersion(repo, name) === declared)
      continue;
    const dep = profileOf(name);
    const src = mkdtempSync(path.join(stagingRoot, "sibling-"));
    try {
      const archive = path.join(src, "source.tar");
      git(repo, ["archive", "--format=tar", "-o", archive, sourceCommit, dep.dir]);
      const untar = spawnSync("tar", ["-xf", archive, "-C", src], { encoding: "utf8" });
      if (untar.status !== 0) throw new Error(`tar -xf failed: ${untar.stderr}`);
      const dir = path.join(src, dep.dir);
      const manifest = JSON.parse(
        readFileSync(path.join(dir, "package.json"), "utf8"),
      ) as Manifest & {
        version: string;
        dependencies?: Record<string, string>;
      };
      if (manifest.version !== declared)
        refuse(
          "malformed-manifest",
          `${name} at ${sourceCommit.slice(0, 12)} is ${manifest.version}, not the pinned ${declared}`,
        );
      stageSiblings(
        repo,
        sourceCommit,
        manifest.dependencies,
        path.join(dir, "node_modules"),
        stagingRoot,
      );
      const target = path.join(into, ...name.split("/"));
      rmSync(target, { recursive: true, force: true });
      mkdirSync(target, { recursive: true });
      compileDistribution(dir, path.join(target, "dist"));
      writeFileSync(path.join(target, "package.json"), json(distributionManifest(manifest)));
      for (const doc of DOCUMENTS)
        if (existsSync(path.join(dir, doc))) cpSync(path.join(dir, doc), path.join(target, doc));
      if (existsSync(path.join(dir, "node_modules")))
        cpSync(path.join(dir, "node_modules"), path.join(target, "node_modules"), {
          recursive: true,
        });
    } finally {
      rmSync(src, { recursive: true, force: true });
    }
  }
}

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

/**
 * Builds the mirror tree for one committed source revision into `outDir/tree`, and the
 * npm tarball into `outDir`. The input is `git archive` of `sourceCommit`, never the working
 * tree, so uncommitted edits cannot leak into a release. `stagingRoot` must be inside the
 * repository (the compiler resolves zod and @types/node from its node_modules).
 */
export function buildCandidate(options: {
  repo: string;
  sourceCommit: string;
  outDir: string;
  stagingRoot: string;
  /** Defaults to `@comforge/core`. */
  profile?: PackageProfile;
  /**
   * The release planner's build: it compares shipped files and exports, so it accepts the
   * unreleased placeholder 0.0.0 and a version without a changelog entry yet. A release
   * build never sets this.
   */
  planning?: boolean;
}): Candidate {
  const { repo, sourceCommit, outDir } = options;
  const profile = options.profile ?? CORE;
  if (
    !/^[0-9a-f]{40}$/.test(sourceCommit) ||
    git(repo, ["cat-file", "-t", sourceCommit], true) !== "commit"
  )
    refuse("source-missing", `${sourceCommit} is not a commit in ${repo}`);

  mkdirSync(options.stagingRoot, { recursive: true });
  const staging = mkdtempSync(path.join(options.stagingRoot, "source-"));
  try {
    const archive = path.join(staging, "source.tar");
    git(repo, ["archive", "--format=tar", "-o", archive, sourceCommit, ...sourceInputs(profile)]);
    const untar = spawnSync("tar", ["-xf", archive, "-C", staging], { encoding: "utf8" });
    if (untar.status !== 0) throw new Error(`tar -xf failed: ${untar.stderr}`);
    const pkg = path.join(staging, profile.dir);
    const example = path.join(staging, profile.example);

    let source: Manifest;
    try {
      source = JSON.parse(readFileSync(path.join(pkg, "package.json"), "utf8")) as Manifest;
    } catch {
      return refuse("malformed-manifest", `${profile.dir}/package.json is not valid JSON`);
    }
    if (
      source.name !== profile.name ||
      typeof source.exports !== "object" ||
      source.private !== true
    )
      refuse(
        "malformed-manifest",
        `the package must be named ${profile.name}, private, with an exports map`,
      );
    const version =
      options.planning && source.version === "0.0.0"
        ? source.version
        : assertReleaseVersion(source.version);
    const changelogPath = path.join(pkg, "CHANGELOG.md");
    const changelog = existsSync(changelogPath) ? readFileSync(changelogPath, "utf8") : null;
    if (!options.planning) assertChangelogEntry(changelog, version);
    const exampleManifest = JSON.parse(
      readFileSync(path.join(example, "package.json"), "utf8"),
    ) as {
      dependencies?: Record<string, string>;
    };
    if (exampleManifest.dependencies?.[profile.name] !== version)
      refuse("malformed-manifest", `the example must depend on ${profile.name} ${version} exactly`);

    const tree = path.join(outDir, "tree");
    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(tree, { recursive: true });
    const deps = (source as Manifest & { dependencies?: Record<string, string> }).dependencies;
    stageSiblings(repo, sourceCommit, deps, path.join(pkg, "node_modules"), options.stagingRoot);
    let siblingModules: string | null = null;
    if (existsSync(path.join(pkg, "node_modules"))) {
      siblingModules = mkdtempSync(path.join(options.stagingRoot, "siblings-"));
      cpSync(path.join(pkg, "node_modules"), siblingModules, { recursive: true });
    }
    compileDistribution(pkg, path.join(tree, "dist"));
    cpSync(path.join(pkg, "src"), path.join(tree, "src"), { recursive: true });
    cpSync(example, path.join(tree, profile.example), { recursive: true });
    writeFileSync(path.join(tree, "package.json"), json(distributionManifest(source)));
    // The example ships on the release branch but not in the npm package, so example links
    // point at this release's tag on GitHub: they resolve from both, and never move.
    for (const doc of DOCUMENTS)
      writeFileSync(
        path.join(tree, doc),
        readFileSync(path.join(pkg, doc), "utf8").replaceAll(
          "](../../examples/",
          `](${exampleLinkBase(version, profile)}`,
        ),
      );
    cpSync(changelogPath, path.join(tree, "CHANGELOG.md"));
    for (const file of LICENSE_FILES)
      if (existsSync(path.join(pkg, file))) cpSync(path.join(pkg, file), path.join(tree, file));
    for (const [dest, src] of Object.entries(profile.assets)) {
      mkdirSync(path.dirname(path.join(tree, dest)), { recursive: true });
      cpSync(path.join(staging, src), path.join(tree, dest));
    }

    // The tarball: the same manifest, dist and documents `npm pack` would ship from the mirror.
    const packStage = path.join(staging, "pack");
    mkdirSync(packStage);
    const licenses = LICENSE_FILES.filter((f) => existsSync(path.join(tree, f)));
    for (const entry of ["package.json", "dist", ...DOCUMENTS, ...licenses])
      cpSync(path.join(tree, entry), path.join(packStage, entry), { recursive: true });
    const packed = packStaged(packStage, outDir);

    const files: Record<string, string> = {};
    for (const file of listFiles(tree)) files[file] = sha256(readFileSync(path.join(tree, file)));
    const release: ReleaseRecord = {
      schema: RELEASE_SCHEMA,
      package: profile.name,
      version,
      tag: `${profile.tagPrefix}${version}`,
      source: {
        commit: sourceCommit,
        packageTree: git(repo, ["rev-parse", `${sourceCommit}:${profile.dir}`]),
        exampleTree: git(repo, ["rev-parse", `${sourceCommit}:${profile.example}`]),
      },
      toolchain: { typescript: compilerVersion() },
      tarball: {
        file: path.basename(packed.tarball),
        sha256: packed.sha256,
        integrity: packed.integrity,
      },
      files,
    };
    writeFileSync(path.join(tree, RELEASE_FILE), json(release));
    writeOwnership(tree);
    return { dir: tree, tarball: packed.tarball, release, siblingModules };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/** The ownership record: every file the publisher wrote, with its digest. */
function writeOwnership(tree: string): void {
  const files: Record<string, string> = {};
  for (const file of listFiles(tree).filter((f) => f !== OWNERSHIP_FILE))
    files[file] = sha256(readFileSync(path.join(tree, file)));
  writeFileSync(path.join(tree, OWNERSHIP_FILE), json({ schema: OWNERSHIP_SCHEMA, files }));
}

/** Two candidates from the same inputs must be byte-identical, tarball included. */
export function assertReproducible(a: Candidate, b: Candidate): void {
  const fa = listFiles(a.dir);
  const fb = listFiles(b.dir);
  if (fa.join("\n") !== fb.join("\n"))
    refuse("not-reproducible", "the two builds produced different file sets");
  for (const file of fa)
    if (!readFileSync(path.join(a.dir, file)).equals(readFileSync(path.join(b.dir, file))))
      refuse("not-reproducible", `${file} differs between two builds of the same inputs`);
  if (a.release.tarball.sha256 !== b.release.tarball.sha256)
    refuse("not-reproducible", "the tarball differs between two builds of the same inputs");
}

/** A candidate is consistent when its RELEASE.json digests match its files exactly. */
export function assertCandidateConsistent(dir: string): ReleaseRecord {
  const release = JSON.parse(readFileSync(path.join(dir, RELEASE_FILE), "utf8")) as ReleaseRecord;
  const actual = listFiles(dir).filter((f) => f !== RELEASE_FILE && f !== OWNERSHIP_FILE);
  const recorded = Object.keys(release.files).sort();
  if (actual.join("\n") !== recorded.join("\n"))
    refuse("validation-failed", "RELEASE.json does not list exactly the candidate's files");
  for (const file of actual)
    if (sha256(readFileSync(path.join(dir, file))) !== release.files[file])
      refuse("validation-failed", `${file} does not match its RELEASE.json digest`);
  const profile = profileOfRecord(release);
  if (release.tag !== `${profile.tagPrefix}${release.version}`)
    refuse("validation-failed", `RELEASE.json tag ${release.tag} is not ${profile.name}'s`);
  const outside = listFiles(dir).filter((f) => !isOwnedBy(profile, f));
  if (outside.length > 0)
    refuse("validation-failed", `candidate files outside the owned paths: ${outside.join(", ")}`);
  assertReleaseVersion(release.version);
  return release;
}

/**
 * The compiled package must load under Node and export exactly what its source exports
 * under Bun. Runs on a copy inside `stagingRoot` (in the repository), where `zod` resolves.
 */
export function verifyCompiledExports(
  tree: string,
  stagingRoot: string,
  siblingModules: string | null = null,
): string[] {
  mkdirSync(stagingRoot, { recursive: true });
  const copy = mkdtempSync(path.join(stagingRoot, "verify-"));
  try {
    for (const entry of ["package.json", "dist", "src"])
      cpSync(path.join(tree, entry), path.join(copy, entry), { recursive: true });
    if (siblingModules)
      cpSync(siblingModules, path.join(copy, "node_modules"), { recursive: true });
    const keys = (runtime: string, args: string[], entry: string) => {
      const href = JSON.stringify(pathToFileURL(path.join(copy, entry)).href);
      const r = spawnSync(
        runtime,
        [...args, `const m = await import(${href}); console.log(Object.keys(m).sort().join(","));`],
        { cwd: copy, encoding: "utf8" },
      );
      if (r.status !== 0)
        refuse("validation-failed", `${runtime} cannot import ${entry}: ${r.stderr.slice(0, 400)}`);
      return r.stdout.trim();
    };
    const compiled = keys("node", ["--input-type=module", "-e"], "dist/index.js");
    const source = keys("bun", ["-e"], "src/index.ts");
    if (!compiled || compiled !== source)
      refuse(
        "validation-failed",
        "dist/index.js under Node does not export what src/index.ts does under Bun",
      );
    return compiled.split(",");
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
}

// ── Destination ──────────────────────────────────────────────────────────────

export type SyncPlan = {
  base: string | null;
  previousVersion: string | null;
  write: string[];
  remove: string[];
  unchanged: string[];
};

/**
 * Compares a candidate with a mirror checkout without changing either. Refuses a dirty
 * checkout, any owned file the publisher did not write (or that changed since it did),
 * a released version reused for different content, and a version lower than the last.
 */
export function planSync(candidateDir: string, destDir: string): SyncPlan {
  const profile = profileOfRecord(
    JSON.parse(readFileSync(path.join(candidateDir, RELEASE_FILE), "utf8")) as { package: string },
  );
  const isOwned = (file: string) => isOwnedBy(profile, file);
  if (!existsSync(path.join(destDir, ".git")))
    refuse("destination-not-git", `${destDir} is not a git checkout of the mirror`);
  if (git(destDir, ["status", "--porcelain", "--untracked-files=all"]) !== "")
    refuse("destination-dirty", `${destDir} has uncommitted changes`);
  if (git(destDir, ["symbolic-ref", "-q", "HEAD"], true) !== `refs/heads/${profile.releaseBranch}`)
    refuse(
      "destination-branch",
      `the checkout must be on ${profile.releaseBranch}; the publisher never writes another branch`,
    );
  const base = git(destDir, ["rev-parse", "-q", "--verify", "HEAD"], true) || null;
  const release = assertCandidateConsistent(candidateDir);

  const ownedInDest = listFiles(destDir).filter(isOwned);
  const ownershipPath = path.join(destDir, OWNERSHIP_FILE);
  const previous = existsSync(ownershipPath)
    ? (JSON.parse(readFileSync(ownershipPath, "utf8")) as {
        schema: string;
        files: Record<string, string>;
      })
    : null;
  if (previous && previous.schema !== OWNERSHIP_SCHEMA)
    refuse("modified-outside-publisher", `${OWNERSHIP_FILE} has an unknown schema`);
  for (const file of ownedInDest) {
    if (file === OWNERSHIP_FILE) continue;
    const recorded = previous?.files[file];
    if (recorded === undefined)
      refuse("unexpected-file", `${file} is in an owned path but the publisher never wrote it`);
    if (sha256(readFileSync(path.join(destDir, file))) !== recorded)
      refuse("modified-outside-publisher", `${file} changed since the publisher wrote it`);
  }
  for (const file of Object.keys(previous?.files ?? {}))
    if (!existsSync(path.join(destDir, file)))
      refuse("modified-outside-publisher", `${file} was deleted outside the publisher`);

  const write: string[] = [];
  const unchanged: string[] = [];
  for (const file of listFiles(candidateDir)) {
    const to = path.join(destDir, file);
    if (existsSync(to) && readFileSync(to).equals(readFileSync(path.join(candidateDir, file))))
      unchanged.push(file);
    else write.push(file);
  }
  const candidateFiles = new Set(listFiles(candidateDir));
  const remove = ownedInDest.filter((f) => !candidateFiles.has(f));

  let previousVersion: string | null = null;
  if (previous) {
    previousVersion = (
      JSON.parse(readFileSync(path.join(destDir, RELEASE_FILE), "utf8")) as ReleaseRecord
    ).version;
    const order = compareVersions(release.version, previousVersion);
    if (order < 0)
      refuse(
        "version-regression",
        `${release.version} is lower than the released ${previousVersion}`,
      );
    if (order === 0 && write.length + remove.length > 0)
      refuse(
        "version-reused",
        `${release.version} is already released with different content; bump the version`,
      );
  }
  return { base, previousVersion, write, remove, unchanged };
}

const COMMITTER = [
  "-c",
  "user.name=comforge-release",
  "-c",
  "user.email=comforge-release@example.invalid",
];

export type ReleaseOutcome = {
  plan: SyncPlan;
  changed: boolean;
  commit: string;
  tag: string;
  tagCreated: boolean;
};

/**
 * Applies a plan to the checkout, commits only owned paths and creates the release tag.
 * An identical candidate whose tag already exists is a no-op. A tag that exists for any
 * other content is never moved.
 */
export function releaseMirror(candidateDir: string, destDir: string): ReleaseOutcome {
  const plan = planSync(candidateDir, destDir);
  const release = assertCandidateConsistent(candidateDir);
  const tag = release.tag;
  const tagRef = `refs/tags/${tag}`;
  const existingTag = git(destDir, ["rev-parse", "-q", "--verify", `${tagRef}^{commit}`], true);

  const changed = plan.write.length + plan.remove.length > 0;
  if (existingTag && changed)
    refuse("tag-changed", `${tag} already exists for other content; released tags are immutable`);
  if (changed) {
    for (const file of plan.write) {
      mkdirSync(path.dirname(path.join(destDir, file)), { recursive: true });
      cpSync(path.join(candidateDir, file), path.join(destDir, file));
    }
    for (const file of plan.remove) rmSync(path.join(destDir, file));
    // Exactly the planned files: owned paths only, and none that does not exist yet.
    git(destDir, ["add", "-A", "--", ...plan.write, ...plan.remove]);
    git(destDir, [
      ...COMMITTER,
      "commit",
      "-q",
      "-m",
      `release: ${release.package} ${tag}`,
      "-m",
      `Source: comforge@${release.source.commit}\nTarball: ${release.tarball.file} sha256 ${release.tarball.sha256}`,
    ]);
  }
  const commit = git(destDir, ["rev-parse", "HEAD"]);
  if (existingTag && existingTag !== commit)
    refuse("tag-changed", `${tag} points at ${existingTag}, not the released content at ${commit}`);
  if (!existingTag) git(destDir, [...COMMITTER, "tag", tag, commit]);
  return { plan, changed, commit, tag, tagCreated: !existingTag };
}

/**
 * Switches a clean mirror checkout to RELEASE_BRANCH: the local branch, else one tracking
 * origin's, else a new empty orphan branch (the first release). Never touches another
 * branch's history; on the orphan path the previous branch's files leave the working tree
 * and index only.
 */
export function checkoutReleaseBranch(destDir: string, profile: PackageProfile = CORE): void {
  const RELEASE_BRANCH = profile.releaseBranch;
  if (!existsSync(path.join(destDir, ".git")))
    refuse("destination-not-git", `${destDir} is not a git checkout of the mirror`);
  if (git(destDir, ["status", "--porcelain", "--untracked-files=all"]) !== "")
    refuse("destination-dirty", `${destDir} has uncommitted changes`);
  const branchRef = `refs/heads/${RELEASE_BRANCH}`;
  if (git(destDir, ["symbolic-ref", "-q", "HEAD"], true) === branchRef) return;
  const has = (ref: string) => git(destDir, ["rev-parse", "-q", "--verify", ref], true) !== "";
  if (has(branchRef)) git(destDir, ["checkout", "-q", RELEASE_BRANCH]);
  else if (has(`refs/remotes/origin/${RELEASE_BRANCH}`))
    git(destDir, ["checkout", "-q", "-b", RELEASE_BRANCH, `refs/remotes/origin/${RELEASE_BRANCH}`]);
  else {
    git(destDir, ["symbolic-ref", "HEAD", branchRef]);
    if (git(destDir, ["ls-files"]) !== "") git(destDir, ["rm", "-rfq", "."]);
  }
}

/**
 * What must be settled before a public release, independent of the build: a licence the
 * owner chose (manifest `license` plus that licence's canonical LICENSE text), and a destination whose
 * `main` exists. GitHub makes the first branch pushed to an empty repository its default
 * branch, so pushing `releases/core` first would make it the repository's front page.
 * `remoteMain` is the origin's main commit, "" when absent, or null when not checked.
 */
export function publicationBlockers(candidateDir: string, remoteMain: string | null): string[] {
  const blockers: string[] = [];
  const manifest = JSON.parse(readFileSync(path.join(candidateDir, "package.json"), "utf8")) as {
    license?: unknown;
  };
  const hasLicenseFile = existsSync(path.join(candidateDir, "LICENSE"));
  if (typeof manifest.license !== "string" && !hasLicenseFile)
    blockers.push(
      "license-missing: no licence chosen; the owner decides (manifest license + LICENSE)",
    );
  else if (typeof manifest.license !== "string" || !hasLicenseFile)
    blockers.push(
      "license-inconsistent: the manifest license and the LICENSE file must both be present",
    );
  else if (manifest.license === "UNLICENSED")
    blockers.push("license-unlicensed: UNLICENSED grants nobody any rights in a public repository");
  else if (!Object.hasOwn(CANONICAL_LICENSE_TEXTS, manifest.license))
    blockers.push(
      `license-unrecognized: ${manifest.license} has no canonical text digest in CANONICAL_LICENSE_TEXTS`,
    );
  else if (
    sha256(readFileSync(path.join(candidateDir, "LICENSE"))) !==
    CANONICAL_LICENSE_TEXTS[manifest.license]
  )
    blockers.push(
      `license-text-mismatch: LICENSE is not the canonical, unmodified ${manifest.license} text`,
    );
  if (remoteMain === "")
    blockers.push(
      "destination-uninitialized: the repository has no main; the owner pushes main first",
    );
  return blockers;
}

/** github.com/<owner>/<repo> for https, ssh and token-bearing remote URLs; anything else as-is. */
export function normalizeRemote(url: string): string {
  const m =
    /^(?:https:\/\/(?:[^@/]+@)?|git@|ssh:\/\/git@)github\.com[/:]([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(
      url.trim(),
    );
  return m ? `github.com/${m[1]}/${m[2]}`.toLowerCase() : url.trim();
}

export type PushOutcome = { pushed: string[]; remoteBranch: string; remoteTag: string };

export type WorkflowChange = { file: string; sha256: string | null };

/**
 * Workflow files a release adds, changes or removes, with the SHA-256 each will have
 * (`null` when removed), read from `dir` (the candidate, or the checkout after the release
 * commit). A Comforge workflow is the npm Trusted Publisher's identity: changing it changes
 * what may publish `@comforge/core`, so it needs its own approval (`workflowApproval`).
 */
export function workflowChanges(plan: SyncPlan, dir: string): WorkflowChange[] {
  const isWorkflow = (f: string) => f.startsWith(".github/workflows/");
  return [
    ...plan.write.filter(isWorkflow).map((file) => ({
      file,
      sha256: createHash("sha256")
        .update(readFileSync(path.join(dir, file)))
        .digest("hex"),
    })),
    ...plan.remove.filter(isWorkflow).map((file) => ({ file, sha256: null })),
  ].sort((a, b) => a.file.localeCompare(b.file));
}

/** The approval naming exactly these workflow changes: `path@sha256` (or `path@removed`), comma-separated. */
export const workflowApproval = (changes: WorkflowChange[]) =>
  changes.map((c) => `${c.file}@${c.sha256 ?? "removed"}`).join(",");

/**
 * Pushes the release commit and tag to `origin`, fast-forward only and atomically. Refuses
 * an origin other than `trustedOrigin`, an approval that does not name this exact version
 * and source commit, a workflow change without its own approval, a remote that moved since
 * the checkout was taken, and a remote tag that differs. Never forces.
 */
export function pushRelease(options: {
  destDir: string;
  outcome: ReleaseOutcome;
  release: ReleaseRecord;
  trustedOrigin: string;
  approval: string | undefined;
  workflowApproval?: string | undefined;
}): PushOutcome {
  const { destDir, outcome, release } = options;
  // The branch belongs to the released package, never to the caller's choice.
  const RELEASE_BRANCH = profileOfRecord(release).releaseBranch;
  const expected = `${release.version}@${release.source.commit}`;
  if (options.approval !== expected)
    refuse("approval-missing", `publishing needs the explicit approval "${expected}"`);
  const workflows = workflowApproval(workflowChanges(outcome.plan, destDir));
  if (workflows && options.workflowApproval !== workflows)
    refuse(
      "workflow-change-unapproved",
      `this release changes the npm publishing workflow; it needs the separate approval "${workflows}"`,
    );
  // Both URLs: `git push` uses the push URL, which a `pushInsteadOf` rewrite can point
  // elsewhere while the fetch URL still names the approved mirror.
  const origin = git(destDir, ["remote", "get-url", "origin"], true);
  const pushUrl = git(destDir, ["remote", "get-url", "--push", "origin"], true);
  if (!origin || normalizeRemote(origin) !== normalizeRemote(options.trustedOrigin))
    refuse(
      "untrusted-destination",
      `origin ${JSON.stringify(normalizeRemote(origin))} is not the approved mirror`,
    );
  if (normalizeRemote(pushUrl) !== normalizeRemote(options.trustedOrigin))
    refuse(
      "untrusted-destination",
      `origin pushes to ${JSON.stringify(normalizeRemote(pushUrl))}, not the approved mirror`,
    );

  const remote = (ref: string) => git(destDir, ["ls-remote", "origin", ref]).split(/\s+/)[0] ?? "";
  if (remote("refs/heads/main") === "")
    refuse(
      "destination-uninitialized",
      "origin has no main; the first branch pushed would become the default branch",
    );
  const branchRef = `refs/heads/${RELEASE_BRANCH}`;
  const remoteBranch = remote(branchRef);
  if (remoteBranch !== (outcome.plan.base ?? ""))
    refuse(
      "destination-moved",
      `origin ${RELEASE_BRANCH} is ${remoteBranch || "absent"}, not the ${outcome.plan.base ?? "empty"} base this release was built on`,
    );
  const remoteTag = remote(`refs/tags/${outcome.tag}`);
  if (remoteTag && remoteTag !== outcome.commit)
    refuse("tag-changed", `origin already has ${outcome.tag} at ${remoteTag}`);

  const refspecs: string[] = [];
  if (remoteBranch !== outcome.commit) refspecs.push(`${outcome.commit}:${branchRef}`);
  if (!remoteTag) refspecs.push(`refs/tags/${outcome.tag}:refs/tags/${outcome.tag}`);
  if (refspecs.length > 0) {
    const r = spawnSync("git", ["push", "--atomic", "--porcelain", "origin", ...refspecs], {
      cwd: destDir,
      encoding: "utf8",
    });
    if (r.status !== 0) {
      // --porcelain prints each ref's rejection reason on stdout; stderr only says the push failed.
      const message = [r.stdout, r.stderr]
        .map((part) => part.trim())
        .filter(Boolean)
        .join("\n")
        .slice(0, 1000);
      // GitHub refuses a push that creates or updates a workflow unless the credential has
      // the Workflows permission (fine-grained token or App) or `workflow` scope (classic).
      if (/workflow/i.test(message) && /(permission|scope)/i.test(message))
        refuse(
          "workflow-permission",
          `${message} — the credential lacks Workflows: write; see "Workflow changes" in docs/release-governance.md`,
        );
      refuse("push-rejected", message);
    }
  }
  const after = { branch: remote(branchRef), tag: remote(`refs/tags/${outcome.tag}`) };
  if (after.branch !== outcome.commit || after.tag !== outcome.commit)
    refuse(
      "push-rejected",
      `readback: origin ${RELEASE_BRANCH} ${after.branch}, tag ${after.tag}, expected ${outcome.commit}`,
    );
  return { pushed: refspecs, remoteBranch: after.branch, remoteTag: after.tag };
}

/** A dry run: the same release, in a throwaway copy of the checkout. Nothing is pushed. */
export function dryRunRelease(candidateDir: string, destDir: string, scratch: string) {
  const copy = mkdtempSync(path.join(scratch, "dry-run-"));
  // verbatimSymlinks: a default copy rewrites a relative link (this repository's `main` tracks
  // `.claude/skills -> ../skills`) to an absolute one, and git then sees the checkout as dirty.
  cpSync(destDir, copy, { recursive: true, verbatimSymlinks: true });
  // The candidate's own package decides the branch, as it does for the real release.
  checkoutReleaseBranch(
    copy,
    profileOfRecord(
      JSON.parse(readFileSync(path.join(candidateDir, RELEASE_FILE), "utf8")) as {
        package: string;
      },
    ),
  );
  const outcome = releaseMirror(candidateDir, copy);
  const patch = outcome.changed
    ? git(copy, ["show", "--stat", "--patch", "--format=commit %H%n%n%B", outcome.commit])
    : "";
  rmSync(copy, { recursive: true, force: true });
  return { outcome, patch };
}
