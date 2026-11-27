/**
 * Owner authorization of one Comforge release candidate (COMFORGE-RELEASE-APPROVAL-001).
 *
 * The owner approves a release by signing a `comforge-release-authorization/v1` record with
 * an Ed25519 key, over `<scheme>\n<canonical JSON>`: the signing contract of the engineering
 * lifecycle grants, reused from `@comforge/cli/authority` (`canonicalJson`, `keyIdFor`). It is a
 * separate scheme on purpose: the lifecycle grant vocabulary can never name a release
 * (`PROHIBITED_MODES`), and the scheme prefix in the signed bytes keeps a lifecycle grant
 * from ever verifying here.
 *
 * The record binds the package, version, tag, source commit, candidate digest, release
 * record digest, planner digest, the publishing workflow's digest at the source commit and
 * any mirror-workflow approval, plus the issuer and a validity window. Trust (public keys,
 * the GitHub login each belongs to, revocations) is read from TRUST_FILE at the source
 * commit, never from the record. Consumption: a record is good for one workflow dispatch,
 * run attempt 1; any other run that carried the same id refuses it, so a failed attempt
 * needs a new approval. Signing stays with the owner (tooling/release/releaseApprove.ts);
 * this module holds no private key.
 */
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { createHash, createPublicKey, type KeyObject, sign, verify } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { AUTHORITY_LIMITS, canonicalJson, keyIdFor } from "@comforge/cli/authority";

const CLOCK_SKEW_MS = AUTHORITY_LIMITS.clockSkewMs;

import { z } from "zod";
import {
  assertCandidateIntegrity,
  assertCandidateReady,
  CandidateRefusal,
  githubApiBase,
  type ReleaseCandidate,
} from "./candidate";
import { profileOf, UnknownPackageError } from "./packages";
import { RELEASE_REPOSITORY_SLUG as ENGINEERING_REPOSITORY_SLUG } from "./repository";

export const AUTHORIZATION_SCHEME = "comforge-release-authorization/v1";
export const RELEASE_ACTION = "comforge.release.publish";
export const TRUST_SCHEMA = "comforge-release-trust/v1";
export const TRUST_FILE = "release-trust.json";
export const PUBLISH_WORKFLOW = ".github/workflows/release.yml";
/**
 * The publishing workflow's `run-name` for a publish dispatch, followed by the authorization
 * id; the consumption check reads it. A dry run is named `candidateRunName(package)`.
 */
export const RUN_NAME_PREFIX = "Comforge release ";
export const candidateRunName = (pkg: string) => `Comforge ${profileOf(pkg).id} candidate`;
/** The workflow artifact holding a run's candidate.json (and plan, patch, tarball). */
export const CANDIDATE_ARTIFACT = "comforge-candidate";
export const DEFAULT_LIFETIME_MS = 60 * 60 * 1000;
/** An approval is for one release, now: a day is the longest it may stay usable. */
export const MAX_LIFETIME_MS = 24 * 60 * 60 * 1000;

const Sha40 = z.string().regex(/^[0-9a-f]{40}$/);
const Sha64 = z.string().regex(/^[0-9a-f]{64}$/);
const IsoTime = z.string().datetime({ offset: true });
const Login = z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/);

export const ReleaseAuthorizationSchema = z
  .object({
    schema: z.literal(AUTHORIZATION_SCHEME),
    action: z.literal(RELEASE_ACTION),
    authorizationId: z.string().uuid(),
    nonce: z.string().regex(/^[0-9a-f]{32}$/),
    repository: z.string().regex(/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/),
    issuer: Login,
    package: z.string().min(1),
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    tag: z.string().min(1),
    sourceCommit: Sha40,
    candidateDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    releaseRecordSha256: Sha64,
    planDigest: z.string().min(1),
    workflow: z.object({ path: z.literal(PUBLISH_WORKFLOW), sha256: Sha64 }).strict(),
    mirrorWorkflowApproval: z.string().nullable(),
    candidateRun: z.number().int().positive().nullable(),
    issuedAt: IsoTime,
    expiresAt: IsoTime,
  })
  .strict();
export type ReleaseAuthorization = z.infer<typeof ReleaseAuthorizationSchema>;

export const AuthorizationEnvelopeSchema = z
  .object({
    authorization: z.unknown(),
    keyId: z.string().regex(/^[0-9a-f]{16}$/),
    signature: z.string().regex(/^[A-Za-z0-9_-]+$/),
  })
  .strict();
export type AuthorizationEnvelope = {
  authorization: ReleaseAuthorization;
  keyId: string;
  signature: string;
};

export const TrustSchema = z
  .object({
    schema: z.literal(TRUST_SCHEMA),
    keys: z.array(
      z
        .object({
          keyId: z.string().regex(/^[0-9a-f]{16}$/),
          publicKeyPem: z.string().min(1),
          /** The GitHub account the key belongs to; the issuer and the dispatcher must be it. */
          login: Login,
          label: z.string(),
        })
        .strict(),
    ),
    revoked: z.array(z.object({ authorizationId: z.string().uuid(), reason: z.string() }).strict()),
  })
  .strict();
export type ReleaseTrust = z.infer<typeof TrustSchema>;

export type AuthorizationRefusalCode =
  | "authorization-missing"
  | "authorization-malformed"
  | "authorization-untrusted"
  | "authorization-signature"
  | "authorization-issuer"
  | "authorization-repository"
  | "authorization-not-yet-valid"
  | "authorization-expired"
  | "authorization-revoked"
  | "authorization-consumed"
  | "authorization-mismatch"
  | "authorization-workflow"
  | "authorization-dispatch"
  | "authorization-unavailable"
  | "trust-invalid";

export class AuthorizationRefusal extends Error {
  constructor(
    readonly code: AuthorizationRefusalCode,
    message: string,
  ) {
    super(`release authorization refused (${code}): ${message}`);
  }
}

const refuse = (code: AuthorizationRefusalCode, message: string): never => {
  throw new AuthorizationRefusal(code, message);
};

/** The exact bytes the owner signs. */
export function signingBytes(authorization: ReleaseAuthorization): Buffer {
  return Buffer.from(`${AUTHORIZATION_SCHEME}\n${canonicalJson(authorization)}`, "utf8");
}

export function sha256(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function parseTrust(raw: unknown): ReleaseTrust {
  const trust = TrustSchema.safeParse(raw);
  if (!trust.success)
    return refuse("trust-invalid", `${TRUST_FILE} does not match ${TRUST_SCHEMA}`);
  for (const key of trust.data.keys)
    if (keyIdFor(key.publicKeyPem) !== key.keyId)
      refuse("trust-invalid", `trusted key ${key.keyId} does not match its public key`);
  return trust.data;
}

export interface AuthorizationRequest {
  candidate: ReleaseCandidate;
  workflowSha256: string;
  repository: string;
  issuer: string;
  authorizationId: string;
  nonce: string;
  candidateRun: number | null;
  now: Date;
  lifetimeMs?: number;
}

/** Owner side: the record for exactly this candidate. Signing is `signAuthorization`. */
export function buildAuthorization(request: AuthorizationRequest): ReleaseAuthorization {
  const { candidate, now } = request;
  return ReleaseAuthorizationSchema.parse({
    schema: AUTHORIZATION_SCHEME,
    action: RELEASE_ACTION,
    authorizationId: request.authorizationId,
    nonce: request.nonce,
    repository: request.repository,
    issuer: request.issuer,
    package: candidate.package,
    version: candidate.version,
    tag: candidate.tag,
    sourceCommit: candidate.sourceCommit,
    candidateDigest: candidate.digest,
    releaseRecordSha256: candidate.releaseRecordSha256,
    planDigest: candidate.plan.digest,
    workflow: { path: PUBLISH_WORKFLOW, sha256: request.workflowSha256 },
    mirrorWorkflowApproval: candidate.workflowApproval,
    candidateRun: request.candidateRun,
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + (request.lifetimeMs ?? DEFAULT_LIFETIME_MS)).toISOString(),
  });
}

export function signAuthorization(
  authorization: ReleaseAuthorization,
  privateKey: KeyObject,
): AuthorizationEnvelope {
  const publicKeyPem = createPublicKey(privateKey)
    .export({ type: "spki", format: "pem" })
    .toString();
  return {
    authorization,
    keyId: keyIdFor(publicKeyPem),
    signature: sign(null, signingBytes(authorization), privateKey).toString("base64url"),
  };
}

/** The workflow input form: base64url of the envelope's JSON. */
export function encodeEnvelope(envelope: AuthorizationEnvelope): string {
  return Buffer.from(JSON.stringify(envelope), "utf8").toString("base64url");
}

export function decodeEnvelope(encoded: string | undefined): unknown {
  if (!encoded?.trim())
    return refuse("authorization-missing", "no owner authorization was supplied");
  try {
    return JSON.parse(Buffer.from(encoded.trim(), "base64url").toString("utf8"));
  } catch {
    return refuse("authorization-malformed", "the authorization is not base64url JSON");
  }
}

export interface VerificationContext {
  trust: ReleaseTrust;
  /** The repository this run belongs to; the record must name it. */
  repository: string;
  /** Integrity-checked candidate the run will publish (the rebuild is compared separately). */
  candidate: ReleaseCandidate;
  /** SHA-256 of PUBLISH_WORKFLOW at the candidate's source commit. */
  workflowSha256: string;
  /** Who dispatched the run (GITHUB_TRIGGERING_ACTOR), when known. */
  triggeringActor?: string;
  /** The `approve_workflows` value the run received, when it receives one. */
  approveWorkflows?: string;
  now: Date;
}

/**
 * The offline decision: signature, trust, issuer, window, revocation and every binding to
 * the candidate. Throws an AuthorizationRefusal naming the first failed check.
 */
export function verifyReleaseAuthorization(
  raw: unknown,
  context: VerificationContext,
): ReleaseAuthorization {
  if (raw === undefined || raw === null)
    refuse("authorization-missing", "no owner authorization was supplied");
  const envelope = AuthorizationEnvelopeSchema.safeParse(raw);
  if (!envelope.success) return refuse("authorization-malformed", "the envelope is malformed");
  const parsed = ReleaseAuthorizationSchema.safeParse(envelope.data.authorization);
  if (!parsed.success)
    return refuse(
      "authorization-malformed",
      `the record does not match ${AUTHORIZATION_SCHEME}: ${parsed.error.issues
        .map((i) => `${i.path.join(".")} ${i.message}`)
        .slice(0, 3)
        .join("; ")}`,
    );
  const a = parsed.data;
  const key = context.trust.keys.find((k) => k.keyId === envelope.data.keyId);
  if (!key)
    return refuse(
      "authorization-untrusted",
      `key ${envelope.data.keyId} is not in ${TRUST_FILE} at the source commit`,
    );
  let valid = false;
  try {
    valid = verify(
      null,
      signingBytes(a),
      createPublicKey(key.publicKeyPem),
      Buffer.from(envelope.data.signature, "base64url"),
    );
  } catch {
    valid = false;
  }
  if (!valid)
    refuse("authorization-signature", "the signature does not verify (forged or altered)");
  if (a.issuer !== key.login)
    refuse("authorization-issuer", `the record names ${a.issuer}, the key belongs to ${key.login}`);
  if (context.triggeringActor !== undefined && context.triggeringActor !== key.login)
    refuse(
      "authorization-issuer",
      `the run was dispatched by ${context.triggeringActor}, not the issuer ${key.login}`,
    );
  if (a.repository !== context.repository)
    refuse(
      "authorization-repository",
      `the record names ${a.repository}, not ${context.repository}`,
    );
  const issued = Date.parse(a.issuedAt);
  const expires = Date.parse(a.expiresAt);
  if (!(expires > issued && expires - issued <= MAX_LIFETIME_MS))
    refuse("authorization-malformed", "the validity window must be positive and at most 24 hours");
  if (issued > context.now.getTime() + CLOCK_SKEW_MS)
    refuse("authorization-not-yet-valid", `issued in the future (${a.issuedAt})`);
  if (expires <= context.now.getTime())
    refuse("authorization-expired", `expired at ${a.expiresAt}`);
  const revoked = context.trust.revoked.find((r) => r.authorizationId === a.authorizationId);
  if (revoked) refuse("authorization-revoked", `${a.authorizationId}: ${revoked.reason}`);

  const c = context.candidate;
  const bindings: [string, unknown, unknown][] = [
    ["package", a.package, c.package],
    ["version", a.version, c.version],
    ["tag", a.tag, c.tag],
    ["sourceCommit", a.sourceCommit, c.sourceCommit],
    ["candidateDigest", a.candidateDigest, c.digest],
    ["releaseRecordSha256", a.releaseRecordSha256, c.releaseRecordSha256],
    ["planDigest", a.planDigest, c.plan.digest],
    ["mirrorWorkflowApproval", a.mirrorWorkflowApproval, c.workflowApproval],
  ];
  const differs = bindings.filter(([, x, y]) => x !== y).map(([f]) => f);
  if (differs.length > 0)
    refuse("authorization-mismatch", `the approved candidate differs in ${differs.join(", ")}`);
  if (a.workflow.sha256 !== context.workflowSha256)
    refuse(
      "authorization-workflow",
      `${PUBLISH_WORKFLOW} at the source commit is not the workflow the owner approved`,
    );
  if (
    context.approveWorkflows !== undefined &&
    (context.approveWorkflows || null) !== a.mirrorWorkflowApproval
  )
    refuse(
      "authorization-mismatch",
      "approve_workflows is not the mirror-workflow change the owner approved",
    );
  return a;
}

export interface DispatchContext {
  authorization: ReleaseAuthorization;
  /** The run's `package` input: which package this dispatch was started to publish. */
  packageInput: string | undefined;
  /** The `authorization_id` input, which the run's name was derived from. */
  authorizationIdInput: string | undefined;
  runAttempt: string | undefined;
  /** GITHUB_SHA and GITHUB_WORKFLOW_SHA: what was dispatched, and which workflow file runs. */
  sha: string | undefined;
  workflowSha: string | undefined;
}

/** The run is the first attempt of a dispatch, named after this record, of the approved commit. */
export function verifyDispatch(d: DispatchContext): void {
  let dispatched: string;
  try {
    dispatched = profileOf(d.packageInput).name;
  } catch (error) {
    if (!(error instanceof UnknownPackageError)) throw error;
    throw new AuthorizationRefusal(
      "authorization-dispatch",
      `the run's package input ${JSON.stringify(d.packageInput ?? null)} is not a registry package`,
    );
  }
  if (dispatched !== d.authorization.package)
    refuse(
      "authorization-dispatch",
      `the run publishes ${dispatched}; the owner authorized ${d.authorization.package}`,
    );
  if (d.authorizationIdInput !== d.authorization.authorizationId)
    refuse("authorization-dispatch", "authorization_id is not the signed record's id");
  if (d.runAttempt !== "1")
    refuse(
      "authorization-consumed",
      `run attempt ${d.runAttempt ?? "unknown"}: a re-run needs a new owner approval`,
    );
  if (d.sha !== d.authorization.sourceCommit || d.workflowSha !== d.authorization.sourceCommit)
    refuse(
      "authorization-mismatch",
      `the run is for ${d.sha ?? "unknown"} (workflow ${d.workflowSha ?? "unknown"}), not the approved ${d.authorization.sourceCommit}; main moved after the approval`,
    );
}

/**
 * Other runs of the publishing workflow that carried this authorization. Lists dispatch runs
 * created since the record was issued; any API failure refuses (fail closed).
 */
export async function otherRunsCarrying(options: {
  repository: string;
  authorization: ReleaseAuthorization;
  runId: number;
  token: string | undefined;
  fetchImpl?: typeof fetch;
}): Promise<number[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const since = new Date(Date.parse(options.authorization.issuedAt) - CLOCK_SKEW_MS).toISOString();
  const title = `${RUN_NAME_PREFIX}${options.authorization.authorizationId}`;
  const found: number[] = [];
  for (let page = 1; page <= 10; page++) {
    const url = `${githubApiBase()}/repos/${options.repository}/actions/workflows/${path.basename(PUBLISH_WORKFLOW)}/runs?event=workflow_dispatch&per_page=100&page=${page}&created=${encodeURIComponent(`>=${since}`)}`;
    let res: Response;
    try {
      res = await fetchImpl(url, {
        headers: {
          accept: "application/vnd.github+json",
          ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
        },
      });
    } catch (error) {
      return refuse(
        "authorization-unavailable",
        `listing workflow runs failed: ${(error as Error).message}`,
      );
    }
    if (!res.ok)
      return refuse(
        "authorization-unavailable",
        `listing workflow runs returned HTTP ${res.status}`,
      );
    const body = (await res.json()) as {
      total_count?: number;
      workflow_runs?: { id: number; display_title?: string }[];
    };
    const runs = body.workflow_runs ?? [];
    for (const run of runs)
      if (run.id !== options.runId && run.display_title === title) found.push(run.id);
    if (runs.length < 100) return found;
  }
  return refuse(
    "authorization-unavailable",
    "too many workflow runs to prove the authorization unused",
  );
}

function gitShow(repo: string, commit: string, file: string): string {
  const r = spawnSync("git", ["show", `${commit}:${file}`], { cwd: repo, encoding: "utf8" });
  if (r.status !== 0) return refuse("trust-invalid", `${file} is missing at ${commit}`);
  return r.stdout;
}

/** Trust as committed at `commit`: the working tree and the record never supply it. */
export function trustAt(repo: string, commit: string): ReleaseTrust {
  let raw: unknown;
  try {
    raw = JSON.parse(gitShow(repo, commit, TRUST_FILE));
  } catch (error) {
    if (error instanceof AuthorizationRefusal) throw error;
    return refuse("trust-invalid", `${TRUST_FILE} is not JSON at ${commit}`);
  }
  return parseTrust(raw);
}

export function workflowDigestAt(repo: string, commit: string): string {
  return sha256(gitShow(repo, commit, PUBLISH_WORKFLOW));
}

/** The repository a record must name: this repository, and the run's own when in Actions. */
export function expectedRepository(env: NodeJS.ProcessEnv = process.env): string {
  if (env.GITHUB_REPOSITORY !== undefined && env.GITHUB_REPOSITORY !== ENGINEERING_REPOSITORY_SLUG)
    refuse(
      "authorization-repository",
      `this run belongs to ${env.GITHUB_REPOSITORY}, releases are authorized for ${ENGINEERING_REPOSITORY_SLUG}`,
    );
  return ENGINEERING_REPOSITORY_SLUG;
}

/**
 * `verify --candidate FILE --out FILE`: the workflow's gate before any credential. Reads the
 * envelope from AUTHORIZATION, the run's identity from the GitHub environment, and trust and
 * the workflow digest from the source commit (HEAD); checks the candidate, the record, the
 * dispatch and consumption; writes the verified envelope for the publisher.
 */
async function cli(argv: string[]): Promise<number> {
  const arg = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  if (argv[0] !== "verify" || !arg("--candidate") || !arg("--out")) {
    console.error(
      "usage: bun tooling/release/releaseAuthorization.ts verify --candidate FILE --out FILE",
    );
    return 2;
  }
  const env = process.env;
  const repo = process.cwd();
  const head = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: repo,
    encoding: "utf8",
  }).stdout.trim();
  const candidate = JSON.parse(
    readFileSync(arg("--candidate") as string, "utf8"),
  ) as ReleaseCandidate;
  assertCandidateIntegrity(candidate);
  assertCandidateReady(candidate);
  if (candidate.sourceCommit !== head)
    refuse(
      "authorization-mismatch",
      `the candidate is for ${candidate.sourceCommit}, the checkout is ${head}`,
    );
  const raw = decodeEnvelope(env.AUTHORIZATION);
  const repository = expectedRepository(env);
  const authorization = verifyReleaseAuthorization(raw, {
    trust: trustAt(repo, head),
    repository,
    candidate,
    workflowSha256: workflowDigestAt(repo, head),
    triggeringActor: env.GITHUB_TRIGGERING_ACTOR ?? "",
    approveWorkflows: env.APPROVE_WORKFLOWS ?? "",
    now: new Date(),
  });
  verifyDispatch({
    authorization,
    packageInput: env.PACKAGE,
    authorizationIdInput: env.AUTHORIZATION_ID,
    runAttempt: env.GITHUB_RUN_ATTEMPT,
    sha: env.GITHUB_SHA,
    workflowSha: env.GITHUB_WORKFLOW_SHA,
  });
  const others = await otherRunsCarrying({
    repository,
    authorization,
    runId: Number(env.GITHUB_RUN_ID),
    token: env.GITHUB_TOKEN,
  });
  if (others.length > 0)
    refuse(
      "authorization-consumed",
      `already carried by run(s) ${others.join(", ")}; each approval is good for one dispatch`,
    );
  const out = arg("--out") as string;
  mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  writeFileSync(out, `${JSON.stringify(raw, null, 2)}\n`);
  const line = `authorization ${authorization.authorizationId} by ${authorization.issuer} verified for ${authorization.package} ${authorization.version} at ${authorization.sourceCommit} (candidate ${authorization.candidateDigest}, expires ${authorization.expiresAt})`;
  console.log(line);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `- ${line}\n`);
  return 0;
}

if (import.meta.main)
  cli(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error((error as Error).message);
      process.exit(
        error instanceof AuthorizationRefusal || error instanceof CandidateRefusal ? 1 : 2,
      );
    });
