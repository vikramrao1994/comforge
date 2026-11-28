/**
 * `bun run release:rehearse [--package NAME ...] [--mirror URL|PATH] [--out FILE] [--keep]`
 *
 * A credential-free rehearsal of the whole release pipeline for every package (or the named
 * ones), in dependency order. It is a REHEARSAL, never a publication: nothing is pushed, no
 * tag is created anywhere but in throwaway copies, no registry is written, and no credential
 * is read.
 *
 * For each package, in a throwaway clone of this repository's committed HEAD:
 *   1. the release planner's version commit (`release:version-pr`, local branch only);
 *   2. the candidate build (`release:build` dry run: two byte-identical builds, disclosure
 *      scan, Node import, the sync rehearsed into a throwaway copy of the release branch),
 *      run twice more, so the candidate digest itself is shown to be reproducible;
 *   3. the owner's signed authorization, with a synthetic Ed25519 key generated for this run:
 *      accepted when signed by the trusted key, refused when altered, signed by another key,
 *      expired, or bound to another candidate;
 *   4. npm publication preparation (`npm-release.mjs` plan: staged, listed, packed,
 *      re-verified) against a fake registry where the version is not yet published;
 *   5. readback of that tarball from the fake registry, and refusal of a substituted one.
 *
 * Exit 0 only when every step of every package passes. The report (stdout, and `--out`) labels
 * itself `rehearsal`; it is never evidence that anything was published.
 */

import { spawnSync } from "node:child_process";
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { keyIdFor } from "@comforge/cli/authority";
import { NpmReleaseRefusal, plan as npmPlan, readback } from "./assets/npm-release.mjs";
import type { ReleaseCandidate } from "./candidate";
import { PACKAGE_NAMES, profileOf } from "./packages";
import {
  AuthorizationRefusal,
  buildAuthorization,
  type ReleaseTrust,
  signAuthorization,
  TRUST_SCHEMA,
  verifyReleaseAuthorization,
  workflowDigestAt,
} from "./releaseAuthorization";
import { groupOrder } from "./releasePlan";

const REPO = path.resolve(import.meta.dir, "../..");
export const REHEARSAL_SCHEMA = "comforge-release-rehearsal/v1";
const REHEARSAL_LOGIN = "rehearsal-owner";

type Step = { step: string; pass: boolean; detail: string };
export type PackageRehearsal = {
  package: string;
  version: string | null;
  candidateDigest: string | null;
  pass: boolean;
  steps: Step[];
};

function run(cmd: string, args: string[], cwd: string) {
  const r = spawnSync(cmd, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, SKIP_GIT_AI: "1" },
  });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

const lastLine = (text: string) =>
  text
    .trim()
    .split("\n")
    .filter((l) => l.trim())
    .slice(-1)[0]
    ?.slice(0, 300) ?? "";

/**
 * Step 3: the authorization decision, offline, with a synthetic key. Exported for its test:
 * it needs only a candidate and the workflow digest it is bound to.
 */
export function rehearseAuthorization(
  candidate: ReleaseCandidate,
  workflowSha256: string,
  repository: string,
  now = new Date(),
): Step[] {
  const trusted = generateKeyPairSync("ed25519");
  const other = generateKeyPairSync("ed25519");
  const publicKeyPem = trusted.publicKey.export({ type: "spki", format: "pem" }).toString();
  const trust: ReleaseTrust = {
    schema: TRUST_SCHEMA,
    keys: [
      { keyId: keyIdFor(publicKeyPem), publicKeyPem, login: REHEARSAL_LOGIN, label: "rehearsal" },
    ],
    revoked: [],
  };
  const request = {
    candidate,
    workflowSha256,
    repository,
    issuer: REHEARSAL_LOGIN,
    authorizationId: randomUUID(),
    nonce: randomBytes(16).toString("hex"),
    candidateRun: null,
    now,
  };
  const record = buildAuthorization(request);
  const context = { trust, repository, candidate, workflowSha256, now };
  const outcome = (name: string, raw: unknown, expected: string | null): Step => {
    try {
      verifyReleaseAuthorization(raw, context);
      return { step: name, pass: expected === null, detail: "accepted" };
    } catch (error) {
      if (!(error instanceof AuthorizationRefusal)) throw error;
      return { step: name, pass: error.code === expected, detail: `refused: ${error.code}` };
    }
  };
  const signed = signAuthorization(record, trusted.privateKey);
  const tampered = { ...signed, authorization: { ...signed.authorization, version: "99.0.0" } };
  const expired = signAuthorization(
    buildAuthorization({ ...request, now: new Date(now.getTime() - 2 * 60 * 60 * 1000) }),
    trusted.privateKey,
  );
  const otherCandidate = signAuthorization(
    { ...record, candidateDigest: `sha256:${"0".repeat(64)}` },
    trusted.privateKey,
  );
  return [
    outcome("authorization: signed by the trusted key is accepted", signed, null),
    outcome("authorization: an altered record is refused", tampered, "authorization-signature"),
    outcome(
      "authorization: a key outside the trust file is refused",
      signAuthorization(record, other.privateKey),
      "authorization-untrusted",
    ),
    outcome("authorization: an expired record is refused", expired, "authorization-expired"),
    outcome(
      "authorization: a record bound to another candidate is refused",
      otherCandidate,
      "authorization-mismatch",
    ),
  ];
}

type Route = { status: number; body?: unknown; bytes?: Uint8Array };
/** A registry fake: an in-memory map from URL to answer; anything else is a 404. */
export const fakeRegistry =
  (routes: Record<string, Route>) =>
  async (url: string): Promise<Response> => {
    const route = routes[url] ?? { status: 404, body: { error: "Not found" } };
    if (route.bytes) return new Response(Buffer.from(route.bytes), { status: route.status });
    return new Response(JSON.stringify(route.body ?? {}), { status: route.status });
  };

const REGISTRY = "https://registry.invalid";

/** Steps 4 and 5: npm preparation, then readback of the planned tarball, from a fake registry. */
export async function rehearseNpm(options: {
  releaseDir: string;
  tag: string;
  repository: string;
  outDir: string;
  packageName: string;
  previousVersions: string[];
}): Promise<Step[]> {
  const { packageName } = options;
  const scope = packageName.split("/")[0]?.slice(1) ?? "";
  const packument = `${REGISTRY}/${packageName.replace("/", "%2f")}`;
  const before = fakeRegistry({
    [`${REGISTRY}/-/org/${scope}/package`]: { status: 200, body: {} },
    [packument]: {
      status: 200,
      body: { versions: Object.fromEntries(options.previousVersions.map((v) => [v, {}])) },
    },
  });
  const steps: Step[] = [];
  let planned: Awaited<ReturnType<typeof npmPlan>>;
  try {
    planned = await npmPlan({
      releaseDir: options.releaseDir,
      commit: undefined,
      tag: options.tag,
      repository: options.repository,
      outDir: options.outDir,
      fetchImpl: before,
      registry: REGISTRY,
      packageName,
    });
    steps.push({
      step: "npm: staged, listed, packed and re-verified (not published)",
      pass: true,
      detail: `${planned.tarball.files} files, ${planned.tarball.integrity.slice(0, 22)}…`,
    });
  } catch (error) {
    const code = error instanceof NpmReleaseRefusal ? error.code : String(error);
    return [
      {
        step: "npm: staged, listed, packed and re-verified (not published)",
        pass: false,
        detail: code,
      },
    ];
  }
  const bytes = readFileSync(path.join(options.outDir, planned.tarball.file as string));
  const tarballUrl = `${REGISTRY}/${packageName}/-/${planned.tarball.file}`;
  const served = (served: Uint8Array) =>
    fakeRegistry({
      [packument]: {
        status: 200,
        body: {
          versions: {
            [planned.version]: {
              dist: { integrity: planned.tarball.integrity, tarball: tarballUrl },
            },
          },
        },
      },
      [tarballUrl]: { status: 200, bytes: served },
    });
  const good = await readback({ plan: planned, fetchImpl: served(bytes), registry: REGISTRY });
  steps.push({
    step: "npm: readback of the planned tarball from a fake registry passes",
    pass: good.pass,
    detail: good.checks
      .map((c: { check: string; pass: boolean }) => `${c.check}=${c.pass}`)
      .join(", "),
  });
  const swapped = await readback({
    plan: planned,
    fetchImpl: served(new Uint8Array(bytes).reverse()),
    registry: REGISTRY,
  });
  steps.push({
    step: "npm: readback of a substituted tarball fails",
    pass: !swapped.pass,
    detail: swapped.pass ? "accepted (wrong)" : "refused",
  });
  return steps;
}

async function rehearsePackage(
  name: string,
  scratch: string,
  head: string,
  mirror: string,
  repository: string,
): Promise<PackageRehearsal> {
  const profile = profileOf(name);
  const steps: Step[] = [];
  const result: PackageRehearsal = {
    package: name,
    version: null,
    candidateDigest: null,
    pass: false,
    steps,
  };
  const repo = path.join(scratch, `repo-${profile.id}`);
  const clone = run("git", ["clone", "-q", "--no-hardlinks", REPO, repo], scratch);
  if (!clone.ok) {
    steps.push({ step: "clone", pass: false, detail: lastLine(clone.out) });
    return result;
  }
  run("git", ["checkout", "-q", "--detach", head], repo);
  // The version commit needs an identity; a CI runner has none, and this clone is discarded.
  run("git", ["config", "user.name", "Comforge rehearsal"], repo);
  run("git", ["config", "user.email", "rehearsal@example.invalid"], repo);
  const install = run("bun", ["install", "--frozen-lockfile"], repo);
  if (!install.ok) {
    steps.push({ step: "install", pass: false, detail: lastLine(install.out) });
    return result;
  }
  // A version PR's own head is already versioned: the planner reports it release-ready, and
  // the rehearsal builds that head instead of asking for a second version commit.
  const planned = run(
    "bun",
    ["tooling/release/releasePlan.ts", "plan", "--package", name, "--json"],
    repo,
  );
  let status: string | null = null;
  try {
    if (planned.ok) status = (JSON.parse(planned.out) as { status?: string }).status ?? null;
  } catch {
    status = null;
  }
  // Published and recorded, waiting for adoption: there is nothing left to rehearse.
  if (/\(version-published\)/.test(planned.out)) {
    steps.push({
      step: "version commit (local branch only, nothing pushed)",
      pass: true,
      detail: "already released and recorded: nothing to rehearse",
    });
    result.pass = true;
    return result;
  }
  if (status === "release-ready") {
    steps.push({
      step: "version commit (local branch only, nothing pushed)",
      pass: true,
      detail: "already versioned at the head: release-ready",
    });
  } else {
    const versionPr = run(
      "bun",
      ["tooling/release/releasePlan.ts", "version-pr", "--package", name],
      repo,
    );
    const versioned = versionPr.ok && /version commit\(s\) on /.test(versionPr.out);
    steps.push({
      step: "version commit (local branch only, nothing pushed)",
      pass: versioned,
      detail: lastLine(versionPr.out),
    });
    if (!versioned) return result;
  }
  const source = run("git", ["rev-parse", "HEAD"], repo).out.trim();

  const digests: string[] = [];
  let candidate: ReleaseCandidate | null = null;
  const outBase = path.join(scratch, `out-${profile.id}`);
  for (const attempt of [1, 2]) {
    const out = `${outBase}-${attempt}`;
    const build = run(
      "bun",
      ["tooling/release/release.ts", "--package", name, "--dest", mirror, "--out", out],
      repo,
    );
    const file = path.join(out, "candidate.json");
    if (!build.ok || !existsSync(file)) {
      steps.push({ step: `candidate build ${attempt}`, pass: false, detail: lastLine(build.out) });
      return result;
    }
    candidate = JSON.parse(readFileSync(file, "utf8")) as ReleaseCandidate;
    digests.push(candidate.digest);
  }
  if (!candidate) return result;
  result.version = candidate.version;
  result.candidateDigest = candidate.digest;
  steps.push({
    step: "candidate: release-ready, two byte-identical builds each, dry-run sync of the release branch",
    pass: candidate.plan.status === "release-ready" && candidate.sourceCommit === source,
    detail: `${candidate.package} ${candidate.version} ${candidate.plan.status}, ${candidate.fileCount} files`,
  });
  steps.push({
    step: "candidate digest reproducible across separate runs",
    pass: digests.length === 2 && digests[0] === digests[1],
    detail: digests.map((d) => d.slice(0, 19)).join(" = "),
  });

  steps.push(...rehearseAuthorization(candidate, workflowDigestAt(repo, source), repository));

  // The fake registry already holds the last released version, as the real one does.
  const baseline = JSON.parse(
    readFileSync(path.join(repo, "releases", "baseline", profile.id, "RELEASE.json"), "utf8"),
  ) as { version: string };
  steps.push(
    ...(await rehearseNpm({
      releaseDir: path.join(`${outBase}-1`, "a", "tree"),
      tag: candidate.tag,
      repository,
      outDir: path.join(scratch, `npm-${profile.id}`),
      packageName: name,
      previousVersions: [baseline.version],
    })),
  );
  result.pass = steps.every((s) => s.pass);
  return result;
}

async function main(argv: string[]): Promise<number> {
  const arg = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const named = argv.flatMap((a, i) => (a === "--package" ? [argv[i + 1] as string] : []));
  const packages = groupOrder(named.length > 0 ? named : PACKAGE_NAMES);
  const repository = process.env.GITHUB_REPOSITORY ?? "vikramrao1994/comforge";
  if (run("git", ["status", "--porcelain", "--untracked-files=no"], REPO).out.trim() !== "") {
    console.error(
      "release:rehearse refused: commit or discard tracked changes first (it rehearses HEAD)",
    );
    return 2;
  }
  const head = run("git", ["rev-parse", "HEAD"], REPO).out.trim();
  const scratch = mkdtempSync(path.join(tmpdir(), "comforge-rehearsal-"));
  try {
    const mirrorSource = arg("--mirror") ?? `https://github.com/${repository}.git`;
    const mirror = path.join(scratch, "mirror");
    const prepared = run(
      "bash",
      [path.join(REPO, "tooling/release/prepareMirrorCheckout.sh"), mirrorSource, mirror],
      scratch,
    );
    if (!prepared.ok) {
      console.error(
        `release:rehearse: the release branches could not be read: ${lastLine(prepared.out)}`,
      );
      return 1;
    }
    const results: PackageRehearsal[] = [];
    for (const name of packages) {
      const r = await rehearsePackage(name, scratch, head, mirror, repository);
      results.push(r);
      console.log(`${r.pass ? "PASS" : "FAIL"} ${r.package} ${r.version ?? ""}`);
      for (const s of r.steps) console.log(`  ${s.pass ? "ok  " : "FAIL"} ${s.step} — ${s.detail}`);
    }
    const report = {
      schema: REHEARSAL_SCHEMA,
      mode: "rehearsal",
      note: "Credential-free rehearsal: nothing was pushed, tagged on a remote, or published, and no credential was read. Not evidence of a publication.",
      repository,
      head,
      order: packages,
      pass: results.every((r) => r.pass),
      packages: results,
    };
    const out = arg("--out");
    if (out) writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
    console.log(
      `release:rehearse ${report.pass ? "PASS" : "FAIL"} (rehearsal only: nothing published)`,
    );
    return report.pass ? 0 : 1;
  } finally {
    if (!argv.includes("--keep")) rmSync(scratch, { recursive: true, force: true });
    else console.log(`kept ${scratch}`);
  }
}

if (import.meta.main) main(process.argv.slice(2)).then((code) => process.exit(code));
