// npm distribution of a Comforge release. Runs on Node >= 22 with no dependencies.
//
// The verified Git release (a checkout of a package's release branch at a release commit) is the only
// input. The npm package is derived from it by exactly two manifest changes: `private` is
// removed and `repository` names the release repository, which npm requires for provenance.
// Every other packed byte is a release file whose SHA-256 is recorded in RELEASE.json.
//
//   node npm-release.mjs plan --release-dir DIR --commit SHA --tag core/vX.Y.Z --repository OWNER/REPO --out DIR [--release-branch-ref REF] [--package NAME]
//   node npm-release.mjs verify-tarball --plan FILE --tarball FILE
//   node npm-release.mjs readback --plan FILE [--expect-provenance]
//
// This file never publishes and never reads a credential. Publishing is one command in the
// release workflow, run on the tarball this file planned and re-verified.

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
import { tmpdir } from "node:os";
import path from "node:path";

export const REGISTRY = "https://registry.npmjs.org";
/**
 * Each Comforge package's identity on the mirror: its tag prefix, and the workflow npm
 * provenance must name (its Trusted Publisher). A release record must name one of these
 * packages and carry exactly its prefix. A copy of the source repository's package
 * registry, because this file runs in the mirror without it; the source repository's
 * tests fail when the two differ.
 */
export const PACKAGES = Object.freeze({
  "@comforge/core": Object.freeze({ tagPrefix: "core/v", workflow: ".github/workflows/npm-publish.yml" }),
  "@comforge/github": Object.freeze({ tagPrefix: "github/v", workflow: ".github/workflows/npm-publish-github.yml" }),
});
export const PLAN_SCHEMA = "comforge-npm-plan/v1";
export const RELEASE_SCHEMA = "comforge-release/v1";
export const WORKFLOW_PATH = PACKAGES["@comforge/core"].workflow;
export const SLSA_PROVENANCE = "https://slsa.dev/provenance/v1";
// npm runs these on install or pack; a released package must have none.
export const LIFECYCLE_SCRIPTS = [
  "preinstall",
  "install",
  "postinstall",
  "prepare",
  "preprepare",
  "postprepare",
  "prepack",
  "postpack",
  "prepublish",
  "prepublishOnly",
  "publish",
  "postpublish",
];
// npm always packs these when present, whatever `files` says.
const ALWAYS_PACKED = /^(package\.json|README(\.[^/]*)?|LICEN[CS]E(\.[^/]*)?)$/i;

export class NpmReleaseRefusal extends Error {
  constructor(code, message) {
    super(`refused (${code}): ${message}`);
    this.code = code;
  }
}
const refuse = (code, message) => {
  throw new NpmReleaseRefusal(code, message);
};

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sha512 = (bytes) => createHash("sha512").update(bytes).digest();
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0)
    throw new Error(`${cmd} ${args.join(" ")} failed (${r.status}): ${(r.stderr || r.stdout || String(r.error)).slice(0, 2000)}`);
  return r.stdout;
}

function listFiles(root, dir = "") {
  const out = [];
  for (const entry of readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = dir ? `${dir}/${entry.name}` : entry.name;
    if (entry.name === ".git" && !dir) continue;
    if (entry.isDirectory()) out.push(...listFiles(root, rel));
    else out.push(rel);
  }
  return out.sort();
}

export function parseVersion(version) {
  const m = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(String(version));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function compareVersions(a, b) {
  const [x, y] = [parseVersion(a), parseVersion(b)];
  if (!x || !y) return Number.NaN;
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
}

/** The release checkout, verified against its own record and the expected identity. */
export function verifyRelease({ releaseDir, commit, tag, packageName }) {
  const recordPath = path.join(releaseDir, "RELEASE.json");
  if (!existsSync(recordPath)) refuse("release-record-missing", "RELEASE.json is absent");
  let record;
  let manifest;
  try {
    record = JSON.parse(readFileSync(recordPath, "utf8"));
    manifest = JSON.parse(readFileSync(path.join(releaseDir, "package.json"), "utf8"));
  } catch {
    refuse("malformed-release", "RELEASE.json or package.json is not valid JSON");
  }
  if (record.schema !== RELEASE_SCHEMA) refuse("malformed-release", `RELEASE.json schema is not ${RELEASE_SCHEMA}`);
  if (!parseVersion(record.version)) refuse("malformed-release", `version ${record.version} is not MAJOR.MINOR.PATCH`);
  if (manifest.name !== record.package || manifest.version !== record.version)
    refuse("manifest-mismatch", "package.json name/version differ from RELEASE.json");
  if (packageName !== undefined && record.package !== packageName)
    refuse("package-mismatch", `the release is ${record.package}, this workflow publishes ${packageName}`);
  const prefix = Object.hasOwn(PACKAGES, record.package) ? PACKAGES[record.package].tagPrefix : null;
  if (prefix === null) refuse("package-mismatch", `${record.package} is not a Comforge package`);
  if (record.tag !== `${prefix}${record.version}`) refuse("tag-mismatch", `RELEASE.json tag ${record.tag} does not match its version`);
  if (tag !== undefined && tag !== record.tag) refuse("tag-mismatch", `expected tag ${tag}, release is ${record.tag}`);
  if (commit !== undefined) {
    if (!/^[0-9a-f]{40}$/.test(commit)) refuse("commit-mismatch", "the expected commit must be a full 40-hex SHA");
    if (existsSync(path.join(releaseDir, ".git"))) {
      const head = run("git", ["rev-parse", "HEAD"], releaseDir).trim();
      if (head !== commit) refuse("commit-mismatch", `checkout is at ${head}, expected ${commit}`);
    }
  }
  const scripts = Object.keys(manifest.scripts ?? {}).filter((s) => LIFECYCLE_SCRIPTS.includes(s));
  if (scripts.length) refuse("lifecycle-script", `package.json declares ${scripts.join(", ")}`);
  const changed = [];
  for (const [file, digest] of Object.entries(record.files ?? {})) {
    const p = path.join(releaseDir, file);
    if (!existsSync(p) || sha256(readFileSync(p)) !== digest) changed.push(file);
  }
  if (Object.keys(record.files ?? {}).length === 0) refuse("malformed-release", "RELEASE.json lists no files");
  if (changed.length) refuse("release-files-changed", `files differ from RELEASE.json: ${changed.join(", ")}`);
  // The digests above prove these files are the recorded ones; these prove they are present.
  if (!Object.keys(record.files).some((f) => /^LICEN[CS]E$/.test(f)))
    refuse("license-missing", "the release records no LICENSE file");
  const changelog = record.files["CHANGELOG.md"] ? readFileSync(path.join(releaseDir, "CHANGELOG.md"), "utf8") : "";
  if (!new RegExp(`^## ${record.version.replaceAll(".", "\\.")}$`, "m").test(changelog))
    refuse("changelog-missing", `CHANGELOG.md has no "## ${record.version}" entry`);
  return { record, manifest };
}

/**
 * Refuses a release commit that is not on the release branch: a `core/v*` tag pushed onto any
 * other commit (a side branch, a fork's commit) is not a release. `branchRef` is a ref in the
 * checkout, for example `refs/remotes/origin/releases/core`.
 */
export function verifyOnReleaseBranch({ releaseDir, commit, branchRef }) {
  const r = spawnSync("git", ["merge-base", "--is-ancestor", commit, branchRef], { cwd: releaseDir });
  if (r.status !== 0) refuse("commit-not-released", `${commit} is not on ${branchRef}`);
}

/** The npm manifest: the release manifest without `private`, with the release repository. */
export function npmManifest(releaseManifest, repository) {
  if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(String(repository)))
    refuse("repository-mismatch", "the release repository must be OWNER/REPO");
  const url = `git+https://github.com/${repository}.git`;
  const derived = { ...releaseManifest };
  const transforms = [];
  if ("private" in derived) {
    delete derived.private;
    transforms.push("remove private");
  }
  if (derived.repository === undefined) {
    derived.repository = { type: "git", url };
    transforms.push(`add repository ${url}`);
  } else if (derived.repository?.type !== "git" || derived.repository?.url !== url)
    refuse("repository-mismatch", `package.json repository must be { type: git, url: ${url} }`);
  if (typeof derived.license !== "string" || derived.license === "UNLICENSED")
    refuse("license-missing", "the release must declare an SPDX license");
  return { manifest: derived, transforms };
}

/** Files npm must pack: `files` entries plus the always-packed ones, from the release record. */
export function expectedPackFiles(record, manifest) {
  const entries = manifest.files ?? [];
  return Object.keys(record.files)
    .filter((f) => ALWAYS_PACKED.test(f) || entries.some((e) => f === e || f.startsWith(`${e.replace(/\/$/, "")}/`)))
    .concat(record.files["package.json"] ? [] : ["package.json"])
    .sort();
}

function stagePackage(releaseDir, record, manifest, stageDir) {
  rmSync(stageDir, { recursive: true, force: true });
  mkdirSync(stageDir, { recursive: true });
  for (const file of Object.keys(record.files)) {
    if (file === "package.json") continue;
    mkdirSync(path.dirname(path.join(stageDir, file)), { recursive: true });
    cpSync(path.join(releaseDir, file), path.join(stageDir, file));
  }
  writeFileSync(path.join(stageDir, "package.json"), json(manifest));
}

function npmPack(stageDir, outDir, dryRun) {
  const cache = mkdtempSync(path.join(tmpdir(), "npm-release-cache-"));
  try {
    const args = ["pack", "--json", "--ignore-scripts", "--cache", cache, "--logs-dir", cache];
    if (dryRun) args.push("--dry-run");
    else args.push("--pack-destination", outDir);
    const out = run("npm", args, stageDir);
    return JSON.parse(out.slice(out.indexOf("[")))[0];
  } finally {
    rmSync(cache, { recursive: true, force: true });
  }
}

/** Unpacks a tarball and requires every file to be the release's own bytes or the derived manifest. */
export function verifyTarball({ tarball, record, manifest, expectedFiles }) {
  const dir = mkdtempSync(path.join(tmpdir(), "npm-release-unpack-"));
  try {
    run("tar", ["-xzf", tarball, "-C", dir], dir);
    const root = path.join(dir, "package");
    const files = existsSync(root) ? listFiles(root) : [];
    if (JSON.stringify(files) !== JSON.stringify(expectedFiles))
      refuse("unexpected-pack-content", `packed ${JSON.stringify(files)}, expected ${JSON.stringify(expectedFiles)}`);
    const mismatched = files.filter((f) =>
      f === "package.json"
        ? JSON.stringify(JSON.parse(readFileSync(path.join(root, f), "utf8"))) !== JSON.stringify(manifest)
        : sha256(readFileSync(path.join(root, f))) !== record.files[f],
    );
    if (mismatched.length) refuse("tarball-content-mismatch", `differs from the release: ${mismatched.join(", ")}`);
    return files.length;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Registry state for a version about to be published. `fetchImpl` is injectable for tests. */
export async function registryState({ name, version, fetchImpl = fetch, registry = REGISTRY }) {
  const scope = /^@([^/]+)\//.exec(name)?.[1];
  if (scope) {
    const org = await fetchImpl(`${registry}/-/org/${encodeURIComponent(scope)}/package`);
    if (org.status === 404) refuse("scope-missing", `the npm scope @${scope} does not exist; the owner creates it first`);
  }
  const res = await fetchImpl(`${registry}/${name.replace("/", "%2f")}`);
  if (res.status === 404) return { exists: false, versions: [], bootstrapRequired: true };
  if (!res.ok) refuse("registry-unavailable", `registry answered ${res.status}`);
  const packument = await res.json();
  const versions = Object.keys(packument.versions ?? {});
  if (versions.includes(version)) refuse("version-published", `${name}@${version} is already on the registry; npm versions are immutable`);
  const newer = versions.filter((v) => compareVersions(v, version) > 0);
  if (newer.length) refuse("version-regression", `${name} already has newer ${newer.join(", ")}`);
  return { exists: true, versions, bootstrapRequired: false };
}

/**
 * What the npm version of a verified release must contain, derived from the release alone:
 * every packed file's SHA-256 and the release identity. The tarball's integrity is left null
 * because gzip output differs across platforms; readback then takes it from the registry and
 * requires the downloaded bytes and any provenance subject to match it.
 */
export function releaseExpectation({ releaseDir, commit, tag, repository, packageName }) {
  const { record, manifest: releaseManifest } = verifyRelease({ releaseDir, commit, tag, packageName });
  const { manifest, transforms } = npmManifest(releaseManifest, repository);
  const expected = expectedPackFiles(record, manifest);
  return {
    record,
    manifest,
    expected,
    expectation: {
      schema: PLAN_SCHEMA,
      package: manifest.name,
      version: manifest.version,
      tarball: { file: null, integrity: null, sha256: null, files: expected.length },
      manifest: { transforms, sha256: sha256(json(manifest)) },
      gitRelease: {
        repository,
        commit: commit ?? null,
        tag: record.tag,
        releaseRecordSha256: sha256(readFileSync(path.join(releaseDir, "RELEASE.json"))),
        source: record.source,
      },
      registry: null,
      files: Object.fromEntries(expected.map((f) => [f, f === "package.json" ? sha256(json(manifest)) : record.files[f]])),
    },
  };
}

/** Plans the npm artifact for one verified release: staged, listed, packed, re-verified. */
export async function plan({ releaseDir, commit, tag, repository, outDir, fetchImpl, registry, packageName }) {
  const { record, manifest, expected, expectation } = releaseExpectation({ releaseDir, commit, tag, repository, packageName });
  const state = await registryState({ name: manifest.name, version: manifest.version, fetchImpl, registry });
  mkdirSync(outDir, { recursive: true });
  const stage = mkdtempSync(path.join(tmpdir(), "npm-release-stage-"));
  try {
    stagePackage(releaseDir, record, manifest, stage);
    const dry = npmPack(stage, outDir, true);
    const listed = dry.files.map((f) => f.path).sort();
    if (JSON.stringify(listed) !== JSON.stringify(expected))
      refuse("unexpected-pack-content", `npm pack --dry-run lists ${JSON.stringify(listed)}, expected ${JSON.stringify(expected)}`);
    const packed = npmPack(stage, outDir, false);
    const tarball = path.join(outDir, packed.filename);
    const bytes = readFileSync(tarball);
    const integrity = `sha512-${sha512(bytes).toString("base64")}`;
    if (packed.integrity !== integrity) refuse("tarball-content-mismatch", "npm pack integrity differs from the tarball bytes");
    verifyTarball({ tarball, record, manifest, expectedFiles: expected });
    const result = {
      ...expectation,
      tarball: { file: packed.filename, integrity, sha256: sha256(bytes), files: expected.length },
      registry: { bootstrapRequired: state.bootstrapRequired, existingVersions: state.versions },
    };
    writeFileSync(path.join(outDir, "npm-plan.json"), json(result));
    writeFileSync(path.join(outDir, "npm-manifest.json"), json(manifest));
    return result;
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

/** Re-checks a planned tarball just before publishing: same bytes, version still unpublished. */
export async function verifyPlannedTarball({ planFile, tarball, fetchImpl, registry }) {
  const p = JSON.parse(readFileSync(planFile, "utf8"));
  if (p.schema !== PLAN_SCHEMA) refuse("malformed-plan", `plan schema is not ${PLAN_SCHEMA}`);
  const integrity = `sha512-${sha512(readFileSync(tarball)).toString("base64")}`;
  if (integrity !== p.tarball.integrity) refuse("tarball-content-mismatch", "the tarball is not the planned one");
  await registryState({ name: p.package, version: p.version, fetchImpl, registry });
  return p;
}

/** Decodes the SLSA provenance statement from an npm attestations response. */
export function provenanceStatement(attestations) {
  const entry = (attestations?.attestations ?? []).find((a) => a.predicateType === SLSA_PROVENANCE);
  const payload = entry?.bundle?.dsseEnvelope?.payload;
  return payload ? JSON.parse(Buffer.from(payload, "base64").toString("utf8")) : null;
}

/** Checks a provenance statement binds this tarball to the release repository, workflow, tag and commit. */
export function checkProvenance(statement, { name, version, integrity, repository, tag, commit }) {
  const problems = [];
  const digest = Buffer.from(integrity.replace(/^sha512-/, ""), "base64").toString("hex");
  const subject = statement?.subject?.[0];
  if (decodeURIComponent(subject?.name ?? "") !== `pkg:npm/${name}@${version}`) problems.push("subject name");
  if (subject?.digest?.sha512 !== digest) problems.push("subject digest");
  const workflow = statement?.predicate?.buildDefinition?.externalParameters?.workflow ?? {};
  if (workflow.repository !== `https://github.com/${repository}`) problems.push("workflow repository");
  // An unknown package has no expected workflow, so its provenance never passes.
  if (!Object.hasOwn(PACKAGES, name) || workflow.path !== PACKAGES[name].workflow) problems.push("workflow path");
  if (workflow.ref !== `refs/tags/${tag}`) problems.push("workflow ref");
  const dep = statement?.predicate?.buildDefinition?.resolvedDependencies?.[0];
  if (dep?.digest?.gitCommit !== commit) problems.push("source commit");
  return problems;
}

/**
 * Reads a published version back and compares it with a plan (`planFile`, or `plan` as an
 * object) or with a release expectation, provenance included when expected. A plan pins the
 * tarball integrity; an expectation (integrity null) pins only the files, and the registry's
 * integrity must then match the downloaded bytes and the provenance subject.
 */
export async function readback({ planFile, plan: given, expectProvenance = false, fetchImpl = fetch, registry = REGISTRY }) {
  const p = given ?? JSON.parse(readFileSync(planFile, "utf8"));
  if (p.schema !== PLAN_SCHEMA) refuse("malformed-plan", `plan schema is not ${PLAN_SCHEMA}`);
  const res = await fetchImpl(`${registry}/${p.package.replace("/", "%2f")}`);
  if (!res.ok) refuse("readback-failed", `registry answered ${res.status} for ${p.package}`);
  const meta = (await res.json()).versions?.[p.version];
  if (!meta) refuse("readback-failed", `${p.package}@${p.version} is not on the registry`);
  const checks = [];
  const add = (check, pass, detail) => checks.push({ check, pass, detail });
  const registryIntegrity = meta.dist?.integrity ?? "none";
  const integrity = p.tarball.integrity ?? registryIntegrity;
  add(
    "registry-integrity",
    p.tarball.integrity ? registryIntegrity === p.tarball.integrity : /^sha512-[A-Za-z0-9+/]+=*$/.test(registryIntegrity),
    p.tarball.integrity ? registryIntegrity : `${registryIntegrity} (not pinned: expectation from the Git release)`,
  );
  const tgz = await fetchImpl(meta.dist.tarball);
  const bytes = Buffer.from(await tgz.arrayBuffer());
  const intact = `sha512-${sha512(bytes).toString("base64")}` === integrity;
  add("tarball-integrity", intact, `${bytes.length} bytes`);
  if (!intact) add("files-match-release", false, "not compared: the tarball is not the expected one");
  else {
    const dir = mkdtempSync(path.join(tmpdir(), "npm-release-readback-"));
    try {
      const file = path.join(dir, "package.tgz");
      writeFileSync(file, bytes);
      const unpack = path.join(dir, "u");
      mkdirSync(unpack);
      run("tar", ["-xzf", file, "-C", unpack], dir);
      const root = path.join(unpack, "package");
      const files = listFiles(root);
      // package.json included: the registry serves the derived manifest byte for byte.
      const wrong = files.filter((f) => sha256(readFileSync(path.join(root, f))) !== p.files[f]);
      add(
        "files-match-release",
        JSON.stringify(files) === JSON.stringify(Object.keys(p.files).sort()) && wrong.length === 0,
        `${files.length} files, ${wrong.length} differ${wrong.length ? `: ${wrong.join(", ")}` : ""}`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  const attestationsUrl = meta.dist?.attestations?.url;
  if (expectProvenance) {
    let problems = ["no attestations"];
    if (attestationsUrl) {
      const a = await fetchImpl(attestationsUrl);
      const statement = a.ok ? provenanceStatement(await a.json()) : null;
      problems = statement
        ? checkProvenance(statement, { name: p.package, version: p.version, integrity, repository: p.gitRelease.repository, tag: p.gitRelease.tag, commit: p.gitRelease.commit })
        : ["no SLSA provenance statement"];
    }
    add("provenance", problems.length === 0, problems.length ? problems.join(", ") : "binds tarball, workflow, tag and commit");
  } else add("provenance", true, attestationsUrl ? "attestations present (not required)" : "none (not required for this version)");
  return { package: p.package, version: p.version, pass: checks.every((c) => c.pass), checks };
}

function arg(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function main(argv) {
  const [command] = argv;
  if (command === "plan") {
    const releaseDir = path.resolve(arg(argv, "--release-dir") ?? ".");
    const branchRef = arg(argv, "--release-branch-ref");
    if (branchRef) verifyOnReleaseBranch({ releaseDir, commit: arg(argv, "--commit"), branchRef });
    const result = await plan({
      releaseDir,
      commit: arg(argv, "--commit"),
      tag: arg(argv, "--tag"),
      repository: arg(argv, "--repository"),
      outDir: path.resolve(arg(argv, "--out") ?? "npm-release"),
      packageName: arg(argv, "--package"),
    });
    process.stdout.write(json(result));
  } else if (command === "verify-tarball") {
    const p = await verifyPlannedTarball({ planFile: arg(argv, "--plan"), tarball: arg(argv, "--tarball") });
    process.stdout.write(`verified ${p.package}@${p.version} ${p.tarball.integrity}\n`);
  } else if (command === "readback") {
    const r = await readback({ planFile: arg(argv, "--plan"), expectProvenance: argv.includes("--expect-provenance") });
    process.stdout.write(json(r));
    if (!r.pass) process.exitCode = 1;
  } else {
    process.stderr.write("usage: npm-release.mjs plan|verify-tarball|readback ...\n");
    process.exitCode = 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname)
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
