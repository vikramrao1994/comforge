/**
 * `bun run release:candidates [ensure|check|plan]` — wires unpublished sibling candidates
 * into the one package that declares them.
 *
 * A package whose manifest pins a sibling at a version other than the release the
 * repository has installed (root node_modules, the published pin) depends on that sibling's
 * unreleased candidate: `@comforge/cli` declaring `@comforge/core` 0.2.0 while 0.1.2 is
 * pinned. Such a package can only be built and tested against the candidate. This installs
 * each candidate's distribution (the same compiled `dist/` + manifest + documents that
 * `release:pack` puts in a tarball) into `<package>/node_modules/@comforge/<name>`,
 * which Node, Bun and TypeScript resolve before the root release for files under that
 * package — and for nothing else.
 *
 * Why it is safe: the application imports `@comforge/*` only from the root node_modules, so
 * no production path can reach a candidate (tests/release/consumerPin.test.ts
 * keeps it that way); `<package>/node_modules` is never committed or shipped (a tarball
 * carries `dist` and documents only). Releasing stays dependency-ordered: a package's
 * candidate dependency must be published, read back and pinned before its own version PR.
 *
 * `ensure` rebuilds only what is stale (a stamp hashes every candidate's sources), `check`
 * fails when anything is stale or missing, `plan` prints the wiring.
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
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  compileDistribution,
  DOCUMENTS,
  distributionManifest,
  type Manifest,
  packStaged,
} from "./pack";
import { PACKAGES, type PackageName, profileOf } from "./packages";

const REPO = path.resolve(import.meta.dir, "..", "..");
const STAMP = ".comforge-candidates.json";

const manifestOf = (dir: string, repo = REPO) =>
  JSON.parse(readFileSync(path.join(repo, dir, "package.json"), "utf8")) as Manifest & {
    version: string;
    dependencies?: Record<string, string>;
  };

const installedVersion = (name: string, repo = REPO): string | null => {
  const file = path.join(repo, "node_modules", name, "package.json");
  return existsSync(file)
    ? (JSON.parse(readFileSync(file, "utf8")) as { version: string }).version
    : null;
};

/** The siblings a package consumes as candidates: exact pins that are not the installed release. */
export function candidateDependencies(name: PackageName, repo = REPO): PackageName[] {
  const deps = manifestOf(profileOf(name).dir, repo).dependencies ?? {};
  return (Object.keys(PACKAGES) as PackageName[]).filter((sibling) => {
    const declared = deps[sibling];
    return (
      declared !== undefined &&
      /^\d+\.\d+\.\d+$/.test(declared) &&
      declared !== installedVersion(sibling, repo)
    );
  });
}

/**
 * Where the verified readback of a published version is committed when its adoption waits for
 * its adoption group: `<dir>/npm-pin.json` and `RELEASE.json`, written by
 * `release:npm-readback --write-pin`. It proves the version is on npm and matches its Git
 * release; it installs nothing.
 */
export const releasedDir = (name: PackageName, version: string) =>
  `releases/records/${profileOf(name).id}/${version}`;

export type ReleaseRecord = {
  version: string;
  integrity: string;
  gitRelease: { commit: string; tag: string; source: { commit: string; packageTree: string } };
};

/** The committed release record of `name@version` at `rev` (default: the working tree). */
export function releaseRecordOf(
  name: PackageName,
  version: string,
  repo = REPO,
  rev?: string,
): ReleaseRecord | null {
  const file = `${releasedDir(name, version)}/npm-pin.json`;
  let text: string | null = null;
  if (rev) {
    const r = spawnSync("git", ["show", `${rev}:${file}`], { cwd: repo, encoding: "utf8" });
    text = r.status === 0 ? r.stdout : null;
  } else if (existsSync(path.join(repo, file))) text = readFileSync(path.join(repo, file), "utf8");
  if (!text) return null;
  const record = JSON.parse(text) as ReleaseRecord & { package?: string };
  return record.package === name && record.version === version ? record : null;
}

export type UnreleasedDependency = { name: PackageName; reason: "unreleased" | "drifted" };

/** SHA-256 of every `src/` file of `name`'s package at `rev`, keyed like RELEASE.json `files`. */
function sourceAt(name: PackageName, repo: string, rev: string): Record<string, string> {
  const dir = profileOf(name).dir;
  const list = spawnSync("git", ["ls-tree", "-r", "--name-only", rev, "--", `${dir}/src`], {
    cwd: repo,
    encoding: "utf8",
  }).stdout;
  const out: Record<string, string> = {};
  for (const file of list.split("\n").filter(Boolean)) {
    const blob = spawnSync("git", ["show", `${rev}:${file}`], { cwd: repo }).stdout as Buffer;
    out[path.posix.relative(dir, file)] = createHash("sha256").update(blob).digest("hex");
  }
  return out;
}

/**
 * The candidate dependencies of `name` that the planner must still refuse: those with no
 * committed release record for exactly the declared version, or whose `src/` at `head` is no
 * longer the source that release shipped (the candidate the tests use would then differ from
 * what npm serves). Documents may differ: they wait for the next release.
 */
export function unreleasedDependencies(
  name: PackageName,
  repo = REPO,
  head = "HEAD",
): UnreleasedDependency[] {
  const deps = manifestOf(profileOf(name).dir, repo).dependencies ?? {};
  return candidateDependencies(name, repo).flatMap((dep): UnreleasedDependency[] => {
    const version = deps[dep] as string;
    if (!releaseRecordOf(dep, version, repo, head)) return [{ name: dep, reason: "unreleased" }];
    const shown = spawnSync("git", ["show", `${head}:${releasedDir(dep, version)}/RELEASE.json`], {
      cwd: repo,
      encoding: "utf8",
    });
    const shipped = Object.entries(
      shown.status === 0
        ? ((JSON.parse(shown.stdout) as { files?: Record<string, string> }).files ?? {})
        : {},
    ).filter(([file]) => file.startsWith("src/"));
    const current = Object.entries(sourceAt(dep, repo, head));
    const same =
      shipped.length > 0 && JSON.stringify(shipped.sort()) === JSON.stringify(current.sort());
    return same ? [] : [{ name: dep, reason: "drifted" }];
  });
}

/** Every candidate a package needs, transitively, in build order (dependencies first). */
export function candidateClosure(name: PackageName, repo = REPO): PackageName[] {
  const order: PackageName[] = [];
  const visit = (n: PackageName) => {
    for (const dep of candidateDependencies(n, repo)) {
      if (order.includes(dep)) continue;
      visit(dep);
      order.push(dep);
    }
  };
  visit(name);
  return order;
}

function sourceDigest(name: PackageName, repo = REPO): string {
  const dir = path.join(repo, profileOf(name).dir);
  const hash = createHash("sha256");
  const files = [
    "package.json",
    "tsconfig.json",
    ...DOCUMENTS,
    ...readdirSync(path.join(dir, "src"), { recursive: true, withFileTypes: true })
      .filter((f) => f.isFile())
      .map((f) => path.relative(dir, path.join(f.parentPath, f.name))),
  ].sort();
  for (const f of files)
    hash
      .update(`${f}\0`)
      .update(readFileSync(path.join(dir, f)))
      .update("\0");
  return hash.digest("hex");
}

/** The stamp a package's candidate directory must carry to be current. */
export function expectedStamp(name: PackageName, repo = REPO) {
  const closure = candidateClosure(name, repo);
  return {
    schema: "comforge-candidates/v1",
    consumer: name,
    candidates: Object.fromEntries(
      closure.map((c) => [
        c,
        {
          declared: manifestOf(profileOf(name).dir, repo).dependencies?.[c] ?? null,
          source: sourceDigest(c, repo),
        },
      ]),
    ),
  };
}

const stampPath = (name: PackageName, repo = REPO) =>
  path.join(repo, profileOf(name).dir, "node_modules", STAMP);

export function isCurrent(name: PackageName, repo = REPO): boolean {
  const file = stampPath(name, repo);
  if (!existsSync(file)) return candidateClosure(name, repo).length === 0;
  return readFileSync(file, "utf8") === `${JSON.stringify(expectedStamp(name, repo), null, 2)}\n`;
}

/** Installs `candidate`'s distribution into `consumer`'s own node_modules. */
function install(candidate: PackageName, consumer: PackageName, repo = REPO) {
  const source = profileOf(candidate).dir;
  const target = path.join(repo, profileOf(consumer).dir, "node_modules", ...candidate.split("/"));
  // Staged inside the repository so the compiler finds zod and @types/node.
  const staging = mkdtempSync(path.join(repo, "generated", "candidate-"));
  try {
    compileDistribution(path.join(repo, source), path.join(staging, "dist"));
    writeFileSync(
      path.join(staging, "package.json"),
      `${JSON.stringify(distributionManifest(manifestOf(source, repo)), null, 2)}\n`,
    );
    for (const doc of DOCUMENTS) cpSync(path.join(repo, source, doc), path.join(staging, doc));
    rmSync(target, { recursive: true, force: true });
    mkdirSync(path.dirname(target), { recursive: true });
    cpSync(staging, target, { recursive: true });
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/** Brings one package's candidates up to date; returns what was rebuilt. */
export function ensure(name: PackageName, repo = REPO): PackageName[] {
  if (isCurrent(name, repo)) return [];
  const closure = candidateClosure(name, repo);
  // In this workspace every sibling is linked as its candidate source; nothing to wire, and
  // the workspace links must not be replaced.
  if (closure.length === 0) return [];
  // A candidate that itself consumes candidates is compiled against its own, current ones.
  for (const c of closure) ensure(c, repo);
  rmSync(path.join(repo, profileOf(name).dir, "node_modules", "@comforge"), {
    recursive: true,
    force: true,
  });
  for (const c of closure) install(c, name, repo);
  writeFileSync(stampPath(name, repo), `${JSON.stringify(expectedStamp(name, repo), null, 2)}\n`);
  return closure;
}

/**
 * Tarballs of every candidate `name` needs, packed from its current wiring, for an isolated
 * packed-artifact rehearsal: `{ "@comforge/core": "file:/…/comforge-core-0.1.2.tgz", … }`.
 * Use them as npm `overrides` too: a candidate keeps its source version until its own version
 * PR, so the exact pin a dependent declares (0.2.0) is satisfied only by the override.
 */
export function packCandidates(
  name: PackageName,
  outDir: string,
  repo = REPO,
): Record<string, string> {
  ensure(name, repo);
  const out: Record<string, string> = {};
  for (const c of candidateClosure(name, repo)) {
    const staged = path.join(repo, profileOf(name).dir, "node_modules", ...c.split("/"));
    out[c] = `file:${packStaged(staged, outDir).tarball}`;
  }
  return out;
}

if (import.meta.main) {
  const mode = process.argv[2] ?? "ensure";
  mkdirSync(path.join(REPO, "generated"), { recursive: true });
  const names = Object.keys(PACKAGES) as PackageName[];
  if (mode === "plan") {
    for (const n of names)
      console.log(`${n}: ${candidateClosure(n).join(", ") || "(published releases only)"}`);
  } else if (mode === "check") {
    const stale = names.filter((n) => !isCurrent(n));
    if (stale.length) {
      console.error(`stale candidate wiring: ${stale.join(", ")} — run bun run release:candidates`);
      process.exit(1);
    }
    console.log("candidate wiring current");
  } else if (mode === "ensure") {
    for (const n of names) {
      const rebuilt = ensure(n);
      if (rebuilt.length) console.log(`${n}: installed candidates ${rebuilt.join(", ")}`);
    }
  } else {
    console.error("usage: bun tooling/release/candidates.ts [ensure|check|plan]");
    process.exit(2);
  }
}
