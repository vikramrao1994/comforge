/**
 * Cost: none — verifies a signature and keeps a ledger; the gate it opens is what
 *   allows a client to run, and nothing here runs one
 *
 * Owner approval and budget enforcement, fail closed. An approval is a JSON payload signed with
 * Ed25519 by the owner; the public key is given on the command line, never read from the file.
 * The only way to obtain a LiveGate is openGate(); the client runner requires one, so without a
 * valid approval no client is ever spawned.
 */
import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { canonicalJson } from "./prng.ts";
import { DATA_BOUNDARY } from "./types.ts";

export interface Approval {
  approvalId: string;
  budgetUsd: number;
  maxRuns: number;
  perRunMaxUsd: number;
  model: string;
  client: string;
  dataBoundary: string;
  expiresAt: string;
}
export interface ApprovalFile {
  approval: Approval;
  signature: string;
}

export class Refusal extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "Refusal";
  }
}

export function signApproval(approval: Approval, privateKeyPem: string): ApprovalFile {
  const signature = sign(
    null,
    Buffer.from(canonicalJson(approval)),
    createPrivateKey(privateKeyPem),
  );
  return { approval, signature: signature.toString("base64") };
}

const FIELDS = [
  "approvalId",
  "budgetUsd",
  "maxRuns",
  "perRunMaxUsd",
  "model",
  "client",
  "dataBoundary",
  "expiresAt",
] as const;

export type ApprovalCheck =
  | { ok: true; approval: Approval }
  | { ok: false; code: string; problems: string[] };

/** Validates shape, signature, expiry and boundary. Every failure is a refusal, never a warning. */
export function verifyApproval(
  fileText: string | null,
  publicKeyPem: string | null,
  opts: { now: Date; model?: string; client?: string },
): ApprovalCheck {
  const fail = (code: string, ...problems: string[]): ApprovalCheck => ({
    ok: false,
    code,
    problems,
  });
  if (fileText === null) return fail("missing-approval", "no approval file");
  if (!publicKeyPem) return fail("missing-public-key", "no owner public key supplied");
  let file: ApprovalFile;
  try {
    file = JSON.parse(fileText) as ApprovalFile;
  } catch {
    return fail("malformed-approval", "approval file is not JSON");
  }
  const a = file?.approval as unknown as Record<string, unknown> | undefined;
  if (!a || typeof a !== "object" || typeof file.signature !== "string")
    return fail("malformed-approval", "approval and signature are required");
  const problems: string[] = [];
  for (const k of FIELDS) if (a[k] === undefined) problems.push(`missing ${k}`);
  for (const k of Object.keys(a))
    if (!(FIELDS as readonly string[]).includes(k)) problems.push(`unknown field ${k}`);
  for (const k of ["budgetUsd", "perRunMaxUsd"] as const)
    if (
      a[k] !== undefined &&
      !(typeof a[k] === "number" && Number.isFinite(a[k]) && (a[k] as number) > 0)
    )
      problems.push(`${k} must be a positive number`);
  if (a.maxRuns !== undefined && !(Number.isInteger(a.maxRuns) && (a.maxRuns as number) > 0))
    problems.push("maxRuns must be a positive integer");
  for (const k of ["approvalId", "model", "client", "expiresAt"] as const)
    if (a[k] !== undefined && (typeof a[k] !== "string" || a[k] === ""))
      problems.push(`${k} must be a non-empty string`);
  if (problems.length) return fail("malformed-approval", ...problems);

  let valid = false;
  try {
    valid = verify(
      null,
      Buffer.from(canonicalJson(a)),
      createPublicKey(publicKeyPem),
      Buffer.from(file.signature, "base64"),
    );
  } catch {
    valid = false;
  }
  if (!valid)
    return fail("invalid-signature", "signature does not verify against the supplied key");
  const approval = a as unknown as Approval;
  if (approval.dataBoundary !== DATA_BOUNDARY)
    return fail("data-boundary", `dataBoundary must be '${DATA_BOUNDARY}'`);
  const expires = Date.parse(approval.expiresAt);
  if (!Number.isFinite(expires)) return fail("malformed-approval", "expiresAt is not a date");
  if (expires <= opts.now.getTime()) return fail("expired", "approval expired");
  if (approval.perRunMaxUsd > approval.budgetUsd)
    return fail("malformed-approval", "perRunMaxUsd exceeds budgetUsd");
  if (opts.model !== undefined && approval.model !== opts.model)
    return fail("model-mismatch", "model differs from the approval");
  if (opts.client !== undefined && approval.client !== opts.client)
    return fail("client-mismatch", "client differs from the approval");
  return { ok: true, approval };
}

type LedgerEntry =
  | { kind: "header"; approvalId: string }
  | { kind: "reserve"; runId: string; usd: number }
  | { kind: "settle"; runId: string; usd: number };

/** Append-only JSONL spend ledger in the run directory. Anything unreadable fails closed. */
export class SpendLedger {
  readonly file: string;
  constructor(
    dir: string,
    readonly approvalId: string,
  ) {
    mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, "spend-ledger.jsonl");
    if (!existsSync(this.file)) this.append({ kind: "header", approvalId });
    const h = this.entries()[0];
    if (!h || h.kind !== "header" || h.approvalId !== approvalId)
      throw new Refusal("ledger-mismatch", "ledger belongs to a different approval");
  }
  private append(e: LedgerEntry) {
    appendFileSync(this.file, `${JSON.stringify(e)}\n`);
  }
  entries(): LedgerEntry[] {
    const out: LedgerEntry[] = [];
    for (const line of readFileSync(this.file, "utf8").split("\n")) {
      if (!line) continue;
      try {
        const e = JSON.parse(line) as LedgerEntry;
        const ok =
          e.kind === "header" ||
          ((e.kind === "reserve" || e.kind === "settle") &&
            typeof e.runId === "string" &&
            typeof e.usd === "number" &&
            Number.isFinite(e.usd) &&
            e.usd >= 0);
        if (!ok) throw new Error("bad entry");
        out.push(e);
      } catch {
        throw new Refusal("ledger-corrupt", "spend ledger is unreadable; refusing to continue");
      }
    }
    return out;
  }
  /** A run's cost is its settlement if there is one, else its reservation (a crashed run stays booked). */
  spent(): number {
    const per = new Map<string, number>();
    for (const e of this.entries()) {
      if (e.kind === "reserve" && !per.has(e.runId)) per.set(e.runId, e.usd);
      if (e.kind === "settle") per.set(e.runId, e.usd);
    }
    return [...per.values()].reduce((a, b) => a + b, 0);
  }
  runsStarted(): number {
    return new Set(
      this.entries()
        .filter((e) => e.kind === "reserve")
        .map((e) => (e as { runId: string }).runId),
    ).size;
  }
  reserve(runId: string, usd: number) {
    this.append({ kind: "reserve", runId, usd });
  }
  settle(runId: string, usd: number) {
    this.append({ kind: "settle", runId, usd });
  }
}

export interface GateRequest {
  approvalText: string | null;
  publicKeyPem: string | null;
  ledgerDir: string;
  now: () => Date;
  model?: string;
  client?: string;
  /** Runs the campaign intends to perform; the campaign must fit the approval as a whole. */
  plannedRuns: number;
}

export class LiveGate {
  constructor(
    readonly approval: Approval,
    readonly ledger: SpendLedger,
    private readonly now: () => Date,
  ) {}

  /** Throws Refusal; on success the run's ceiling is reserved before anything is spawned. */
  beforeRun(runId: string): void {
    const a = this.approval;
    if (Date.parse(a.expiresAt) <= this.now().getTime())
      throw new Refusal("expired", "approval expired");
    if (this.ledger.runsStarted() >= a.maxRuns) throw new Refusal("run-count", "maxRuns reached");
    const spent = this.ledger.spent();
    if (spent >= a.budgetUsd)
      throw new Refusal("budget-exhausted", "cumulative spend reached the budget");
    if (spent + a.perRunMaxUsd > a.budgetUsd)
      throw new Refusal(
        "projected-over-budget",
        "spent plus this run's ceiling exceeds the budget",
      );
    this.ledger.reserve(runId, a.perRunMaxUsd);
  }

  /** Books the actual cost. A run over its ceiling halts the campaign. */
  afterRun(runId: string, bookedUsd: number): { halt: boolean; reason: string | null } {
    this.ledger.settle(runId, bookedUsd);
    if (bookedUsd > this.approval.perRunMaxUsd)
      return { halt: true, reason: "per-run-ceiling-exceeded" };
    if (this.ledger.spent() >= this.approval.budgetUsd)
      return { halt: true, reason: "budget-reached" };
    return { halt: false, reason: null };
  }
}

export function openGate(r: GateRequest): LiveGate {
  const check = verifyApproval(r.approvalText, r.publicKeyPem, {
    now: r.now(),
    ...(r.model !== undefined ? { model: r.model } : {}),
    ...(r.client !== undefined ? { client: r.client } : {}),
  });
  if (!check.ok) throw new Refusal(check.code, check.problems.join("; "));
  const a = check.approval;
  if (r.plannedRuns > a.maxRuns)
    throw new Refusal("run-count", `planned ${r.plannedRuns} runs exceed maxRuns ${a.maxRuns}`);
  if (r.plannedRuns * a.perRunMaxUsd > a.budgetUsd)
    throw new Refusal("projected-over-budget", "planned runs at their ceiling exceed the budget");
  const ledger = new SpendLedger(r.ledgerDir, a.approvalId);
  const gate = new LiveGate(a, ledger, r.now);
  if (ledger.spent() >= a.budgetUsd)
    throw new Refusal("budget-exhausted", "ledger already at the budget");
  if (ledger.runsStarted() >= a.maxRuns)
    throw new Refusal("run-count", "ledger already at maxRuns");
  return gate;
}

export const writeJson = (file: string, v: unknown) =>
  writeFileSync(file, `${JSON.stringify(v, null, 2)}\n`);
