import { z } from "zod";
import { GitHubAdapterError, type GitHubErrorCode } from "./errors.ts";
import {
  bodyDigest,
  carriesMarker,
  correlationMarker,
  describe,
  markedBody,
  type OperationDescriptor,
  WRITE_CAPABILITIES,
  type WriteCapability,
  type WriteKind,
  type WriteOperation,
} from "./operations.ts";
import { type SendOptions, sendWrite } from "./request.ts";
import { createFetchTransport, DEFAULTS, type GitHubTransport } from "./transport.ts";

/**
 * Caller-authorized GitHub writes. Opt-in and separate from every read
 * API: `createFetchTransport` and `createGitHubEvidence` stay GET-only, and nothing they return
 * can reach this module.
 *
 * Authority stays with the consumer. The writer validates and binds; it decides nothing:
 * - `authorize` is the consumer's policy, called with the frozen descriptor of exactly what will
 *   be sent. Its `allow` is a policy decision, never evidence that a human approved anything;
 * - the token is the consumer's, and whatever it permits on GitHub, the writer performs only the
 *   capabilities it was constructed with;
 * - the operation ledger is the consumer's durable storage. The writer's guarantees across
 *   processes are exactly those of the ledger's atomic `create` and `replace`.
 *
 * GitHub has no idempotency keys and no compare-and-swap for these endpoints, so nothing here is
 * exactly-once. A write that may have reached GitHub without a definite answer is reported
 * `indeterminate`, recorded, and never resent automatically; `reconcile` looks for it.
 */

export type OperationState =
  | "reserved"
  | "sending"
  | "succeeded"
  | "failed"
  | "indeterminate"
  | "abandoned";

export type WrittenResource =
  | { type: "issue"; number: number; url: string }
  | { type: "comment"; id: number; issueNumber: number; url: string }
  | { type: "review"; id: number; pullNumber: number; commitSha: string | null; state: string }
  | { type: "pull"; number: number; url: string; headSha: string };

export interface ReconciliationReport {
  /** Every page that could hold the write was read. */
  complete: boolean;
  /** Bodies with this operation's marker, by the expected author when one is configured. */
  matches: number;
  /** Bodies with this operation's marker by another author: copies, never accepted as the write. */
  foreignMarkers: number;
  /** Extra matches beyond the first: duplicates GitHub holds for this one operation. */
  duplicates: number[];
}

export interface WriteOutcome {
  /**
   * - `verified`: GitHub answered, and a fresh read shows exactly what was authorized.
   * - `accepted`: the resource exists but the read-back differs or was unavailable (`mismatches`).
   * - `indeterminate`: the write may or may not have happened. Never resend blindly: `reconcile`.
   */
  status: "verified" | "accepted" | "indeterminate";
  operationId: string;
  kind: WriteKind;
  repository: string;
  descriptorDigest: string;
  /** Answered from the ledger; nothing was sent by this call. */
  replayed: boolean;
  /** The resource was identified by reconciliation, not by GitHub's response to the write. */
  recovered: boolean;
  resource: WrittenResource | null;
  verification: "matched" | "mismatch" | "unavailable" | "not-attempted";
  mismatches: string[];
  /** For a review: the pull request head moved between the precondition and the read-back. */
  headMovedDuringPublication?: boolean;
  reconciliation?: ReconciliationReport;
  reason?: string;
  /** False when the ledger could not record this outcome; the write's result above still stands. */
  recorded: boolean;
}

export interface OperationRecord {
  schema: "comforge-github-operation/v1";
  operationId: string;
  repository: string;
  kind: WriteKind;
  capability: WriteCapability;
  /** The descriptor digest: a retry with other content under the same id is a `conflict`. */
  fingerprint: string;
  /** The authorized descriptor, kept so `reconcile` needs nothing else. Holds no secret. */
  descriptor: OperationDescriptor;
  /** Incremented by every replace; the ledger's compare-and-swap key. */
  version: number;
  state: OperationState;
  /** While `reserved` or `sending`, another caller must wait until this clock time. */
  leaseUntil: number | null;
  attempts: number;
  /** Clock time of the first request that may have reached GitHub. */
  firstSentAt: number | null;
  changedAt: number;
  authorizationReference: string | null;
  marker: string | null;
  outcome: Omit<WriteOutcome, "replayed" | "recorded"> | null;
  failure: {
    code: GitHubErrorCode;
    message: string;
    status?: number;
    retryable: boolean;
    notBefore: number | null;
  } | null;
  note: string | null;
}

/**
 * Durable, consumer-owned storage. Preconditions the writer relies on (a process-local map meets
 * them only within one process):
 * - `create` inserts only when no record has that `operationId`, atomically, and says whether it did;
 * - `replace` writes only when the stored `version` equals `expectedVersion`, atomically;
 * - records are returned as stored (a copy), never shared mutable objects.
 * A thrown error from any method is `ledger-failure`: before a send, nothing is sent.
 */
export interface OperationLedger {
  get(operationId: string): Promise<OperationRecord | null>;
  create(record: OperationRecord): Promise<boolean>;
  replace(operationId: string, expectedVersion: number, next: OperationRecord): Promise<boolean>;
}

export type AuthorizationDecision =
  | { allow: true; descriptorDigest: string; expiresAt: number; reference?: string }
  | { allow: false; reason?: string };

export interface WriterLimits {
  /** Pages read when searching for an uncertain create (100 items each). */
  reconcileMaxPages: number;
  /** How long a `reserved`/`sending` record excludes other callers. */
  leaseMs: number;
  /** The longest authorization lifetime accepted; a longer `expiresAt` is refused. */
  maxAuthorizationTtlMs: number;
  /** How far before the first send a reconciliation search starts (clock skew allowance). */
  searchSkewMs: number;
}

export const DEFAULT_WRITER_LIMITS: WriterLimits = {
  reconcileMaxPages: 5,
  leaseMs: 120_000,
  maxAuthorizationTtlMs: 15 * 60_000,
  searchSkewMs: 10 * 60_000,
};

export interface GitHubWriterOptions {
  repository: { owner: string; name: string };
  /** A token, or a function returning one per request. Never stored, logged or returned. */
  token: string | (() => string | Promise<string>);
  /** The only writes this writer performs, whatever the token permits. */
  capabilities: readonly WriteCapability[];
  /** The consumer's policy decision for one exact descriptor. */
  authorize: (
    descriptor: OperationDescriptor,
  ) => AuthorizationDecision | Promise<AuthorizationDecision>;
  ledger: OperationLedger;
  /** Milliseconds since the epoch. Injected: the package reads no ambient clock. */
  clock: () => number;
  /**
   * Correlation markers appended to created bodies, so an uncertain create can be found.
   * `false` disables them; an uncertain create then stays `indeterminate` until you resolve it.
   */
  markers?: { namespace?: string } | false;
  /** The login the token writes as (an App writes as `<slug>[bot]`). Reconciliation trusts only its markers. */
  expectedAuthor?: string;
  fetchImpl?: typeof fetch;
  apiOrigin?: string;
  timeoutMs?: number;
  maxBodyBytes?: number;
  userAgent?: string;
  limits?: Partial<WriterLimits>;
}

export interface GitHubWriter {
  readonly repository: string;
  readonly capabilities: readonly WriteCapability[];
  /** The descriptor `execute` would authorize and send; sends and records nothing. */
  prepare(operation: WriteOperation): Promise<OperationDescriptor>;
  /** Authorize, record, check preconditions, send once, read back. Refusals throw; nothing was written. */
  execute(operation: WriteOperation): Promise<WriteOutcome>;
  /** Looks for an `indeterminate` operation's write on GitHub (reads only) and records what it finds. */
  reconcile(operationId: string): Promise<WriteOutcome>;
  /** Ends an unfinished operation by the caller's decision; it is never sent again under this id. */
  abandon(operationId: string, reason: string): Promise<void>;
}

const NAME = /^[A-Za-z0-9_.-]{1,100}$/;
const NAMESPACE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\[bot\])?$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters
const CONTROL = /[\u0000-\u001f\u007f]/;
const CREATES: ReadonlySet<WriteKind> = new Set([
  "issue.create",
  "issue.comment",
  "pull.review",
  "pull.create",
]);

const User = z.object({ login: z.string() }).nullable().optional();
const IssueRead = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  body: z.string().nullable().optional(),
  state: z.string(),
  state_reason: z.string().nullable().optional(),
  locked: z.boolean().optional(),
  labels: z.array(z.union([z.string(), z.object({ name: z.string() })])).optional(),
  assignees: z
    .array(z.object({ login: z.string() }))
    .nullable()
    .optional(),
  pull_request: z.unknown().optional(),
  html_url: z.string(),
  updated_at: z.string(),
  user: User,
});
const CommentRead = z.object({
  id: z.number().int().positive(),
  body: z.string().nullable().optional(),
  html_url: z.string(),
  issue_url: z.string(),
  updated_at: z.string(),
  user: User,
});
const Ref = z.object({
  ref: z.string(),
  sha: z.string(),
  repo: z.object({ full_name: z.string() }).nullable().optional(),
});
const PullRead = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  body: z.string().nullable().optional(),
  state: z.string(),
  draft: z.boolean().optional(),
  merged_at: z.string().nullable().optional(),
  html_url: z.string(),
  head: Ref,
  base: Ref,
  user: User,
});
const ReviewRead = z.object({
  id: z.number().int().positive(),
  commit_id: z.string().nullable().optional(),
  state: z.string(),
  body: z.string().nullable().optional(),
  user: User,
});
/** The fields a reconciliation search needs from any listed issue, comment, review or pull request. */
const Listed = z.object({
  id: z.number().optional(),
  number: z.number().optional(),
  body: z.string().nullable().optional(),
  user: User,
});
const GitRefRead = z.object({
  ref: z.string(),
  object: z.object({ sha: z.string(), type: z.string() }),
});

const REVIEW_STATE = {
  COMMENT: "COMMENTED",
  APPROVE: "APPROVED",
  REQUEST_CHANGES: "CHANGES_REQUESTED",
} as const;

function fail(code: GitHubErrorCode, message: string, detail: Record<string, unknown> = {}): never {
  throw new GitHubAdapterError(code, message, detail);
}

function parse<T>(schema: z.ZodType<T>, body: unknown, what: string): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) fail("malformed-response", `Unexpected GitHub response for ${what}`);
  return parsed.data;
}

const labelNames = (labels: z.infer<typeof IssueRead>["labels"]) =>
  (labels ?? []).map((l) => (typeof l === "string" ? l : l.name));
const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && [...a].sort().join("\n") === [...b].sort().join("\n");

export function createGitHubWriter(options: GitHubWriterOptions): GitHubWriter {
  const { owner, name } = options.repository ?? ({} as never);
  if (!NAME.test(owner ?? "") || !NAME.test(name ?? ""))
    fail("invalid-input", "Invalid repository owner or name");
  const repository = `${owner}/${name}`;
  const root = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
  if (!Array.isArray(options.capabilities) || options.capabilities.length === 0)
    fail("invalid-input", "A writer needs at least one explicit capability");
  for (const capability of options.capabilities)
    if (!(WRITE_CAPABILITIES as readonly string[]).includes(capability))
      fail("invalid-input", `Unknown capability: ${String(capability)}`);
  const capabilities = Object.freeze([...new Set(options.capabilities)]);
  if (typeof options.authorize !== "function") fail("invalid-input", "authorize is required");
  if (typeof options.clock !== "function") fail("invalid-input", "clock is required");
  const ledger = options.ledger;
  if (
    !ledger ||
    typeof ledger.get !== "function" ||
    typeof ledger.create !== "function" ||
    typeof ledger.replace !== "function"
  )
    fail("invalid-input", "A durable operation ledger is required");
  if (options.expectedAuthor !== undefined && !LOGIN.test(options.expectedAuthor))
    fail("invalid-input", "Invalid expectedAuthor");
  const namespace = options.markers === false ? null : (options.markers?.namespace ?? "comforge");
  if (namespace !== null && !NAMESPACE.test(namespace))
    fail("invalid-input", "Invalid marker namespace");
  const limits: WriterLimits = { ...DEFAULT_WRITER_LIMITS, ...options.limits };
  if (
    !(
      Number.isSafeInteger(limits.reconcileMaxPages) &&
      limits.reconcileMaxPages >= 1 &&
      limits.reconcileMaxPages <= 50
    ) ||
    !(limits.leaseMs > 0 && limits.maxAuthorizationTtlMs > 0 && limits.searchSkewMs >= 0)
  )
    fail("invalid-input", "Invalid writer limits");

  const apiOrigin = options.apiOrigin ?? DEFAULTS.apiOrigin;
  const fetchImpl = (...args: Parameters<typeof fetch>) =>
    (options.fetchImpl ?? globalThis.fetch)(...args);
  const token = async () => (typeof options.token === "function" ? options.token() : options.token);
  const transport: GitHubTransport = createFetchTransport({
    token,
    fetchImpl: fetchImpl as typeof fetch,
    apiOrigin,
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.maxBodyBytes !== undefined ? { maxBodyBytes: options.maxBodyBytes } : {}),
    ...(options.userAgent !== undefined ? { userAgent: options.userAgent } : {}),
  });
  const sendOptions: SendOptions = {
    origin: new URL(apiOrigin).origin,
    base: apiOrigin.replace(/\/+$/, ""),
    token,
    fetchImpl: fetchImpl as typeof fetch,
    timeoutMs: options.timeoutMs ?? DEFAULTS.timeoutMs,
    maxBodyBytes: options.maxBodyBytes ?? DEFAULTS.maxBodyBytes,
    ...(options.userAgent !== undefined ? { userAgent: options.userAgent } : {}),
  };
  const now = () => {
    const t = options.clock();
    if (!Number.isFinite(t)) fail("invalid-input", "The clock returned no time");
    return t;
  };
  const read = (segments: readonly (string | number)[], query?: Record<string, string>) =>
    transport.get(`${root}/${segments.map((s) => encodeURIComponent(String(s))).join("/")}`, query);
  const readRef = (branch: string) =>
    transport.get(`${root}/git/ref/heads/${branch.split("/").map(encodeURIComponent).join("/")}`);

  // --- ledger -------------------------------------------------------------------------------

  async function store<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      if (error instanceof GitHubAdapterError) throw error;
      fail("ledger-failure", "The operation ledger failed");
    }
  }

  /** Compare-and-swap; `false` means another caller changed the record first. */
  async function advance(
    record: OperationRecord,
    changes: Partial<OperationRecord>,
  ): Promise<OperationRecord | null> {
    const next: OperationRecord = {
      ...record,
      ...changes,
      version: record.version + 1,
      changedAt: now(),
    };
    return (await store(() => ledger.replace(record.operationId, record.version, next)))
      ? next
      : null;
  }

  /** As `advance`, after a send: a ledger failure must not hide what happened on GitHub. */
  async function settle(
    record: OperationRecord,
    changes: Partial<OperationRecord>,
  ): Promise<boolean> {
    try {
      return (await advance(record, changes)) !== null;
    } catch {
      return false;
    }
  }

  function storedOutcome(record: OperationRecord, replayed: boolean): WriteOutcome {
    if (!record.outcome)
      fail("conflict", "The operation has no recorded outcome", { reason: record.state });
    return { ...record.outcome, replayed, recorded: true };
  }

  async function refuse(
    record: OperationRecord,
    error: GitHubAdapterError,
    retryable: boolean,
  ): Promise<never> {
    const retryAfter = error.detail.retryAfterSeconds;
    await settle(record, {
      state: "failed",
      leaseUntil: null,
      failure: {
        code: error.code,
        message: error.message,
        ...(error.detail.status !== undefined ? { status: error.detail.status } : {}),
        retryable,
        notBefore: typeof retryAfter === "number" ? now() + retryAfter * 1000 : null,
      },
    });
    throw error;
  }

  // --- authorization ------------------------------------------------------------------------

  async function authorize(
    descriptor: OperationDescriptor,
  ): Promise<{ expiresAt: number; reference: string | null }> {
    let decision: unknown;
    try {
      decision = await options.authorize(descriptor);
    } catch {
      fail("authorization-denied", "The authorization callback failed; nothing was sent");
    }
    const d = decision as Record<string, unknown> | null;
    if (!d || typeof d !== "object" || d.allow !== true) {
      const reason = d && typeof d.reason === "string" ? d.reason.slice(0, 200) : undefined;
      fail(
        "authorization-denied",
        "The consumer's policy did not allow this operation",
        reason ? { reason } : {},
      );
    }
    if (d.descriptorDigest !== descriptor.digest)
      fail("authorization-denied", "The authorization is for a different descriptor");
    const t = now();
    if (typeof d.expiresAt !== "number" || !Number.isFinite(d.expiresAt) || d.expiresAt <= t)
      fail("authorization-denied", "The authorization has expired or has no expiry");
    if (d.expiresAt > t + limits.maxAuthorizationTtlMs)
      fail("authorization-denied", "The authorization lives longer than the writer accepts");
    if (
      d.reference !== undefined &&
      (typeof d.reference !== "string" || d.reference.length > 200 || CONTROL.test(d.reference))
    )
      fail("authorization-denied", "The authorization reference is malformed");
    return { expiresAt: d.expiresAt, reference: (d.reference as string | undefined) ?? null };
  }

  // --- per-kind GitHub mechanics --------------------------------------------------------------

  function writePath(d: OperationDescriptor): string {
    const t = d.target;
    switch (d.kind) {
      case "issue.create":
        return `${root}/issues`;
      case "issue.comment":
        return `${root}/issues/${(t as { number: number }).number}/comments`;
      case "pull.review":
        return `${root}/pulls/${(t as { number: number }).number}/reviews`;
      case "pull.create":
        return `${root}/pulls`;
      case "issue.update":
        return `${root}/issues/${(t as { number: number }).number}`;
      case "comment.update":
        return `${root}/issues/comments/${(t as { id: number }).id}`;
    }
  }

  function payloadOf(d: OperationDescriptor, marker: string | null): Record<string, unknown> {
    const payload = { ...d.payload };
    if (CREATES.has(d.kind)) payload.body = markedBody(String(payload.body ?? ""), marker);
    return payload;
  }

  /** Reads what must hold before the write. Throws a refusal; nothing has been sent. */
  async function preflight(d: OperationDescriptor): Promise<{ headSha?: string }> {
    const pre = d.precondition as Record<string, unknown>;
    switch (d.kind) {
      case "issue.create":
        return {};
      case "issue.comment": {
        const number = (d.target as { number: number }).number;
        const issue = parse(IssueRead, await read(["issues", number]), "an issue");
        const isPull = issue.pull_request !== undefined && issue.pull_request !== null;
        if (isPull !== (pre.thread === "pull-request"))
          fail(
            "wrong-target",
            `#${number} is ${isPull ? "a pull request" : "an issue"}, not the expected thread`,
          );
        if (issue.state !== "open" && pre.allowClosed !== true)
          fail("conflict", `#${number} is ${issue.state}`, { reason: "closed" });
        if (issue.locked === true && pre.allowLocked !== true)
          fail("conflict", `#${number} is locked`, { reason: "locked" });
        return {};
      }
      case "pull.review": {
        const pull = parse(
          PullRead,
          await read(["pulls", (d.target as { number: number }).number]),
          "a pull request",
        );
        if (pull.state !== "open" || pull.merged_at)
          fail("conflict", "The pull request is not open", { reason: "closed" });
        if (pull.head.sha !== pre.headSha)
          fail("stale", "The pull request head is not the reviewed commit", {
            expected: pre.headSha,
            actual: pull.head.sha,
          });
        return { headSha: pull.head.sha };
      }
      case "pull.create": {
        const t = d.target as { head: string; base: string };
        const head = parse(GitRefRead, await readRef(t.head), "a branch");
        if (head.object.sha !== pre.headSha)
          fail("stale", "The head branch is not at the expected commit", {
            expected: pre.headSha,
            actual: head.object.sha,
          });
        if (pre.baseSha !== undefined) {
          const base = parse(GitRefRead, await readRef(t.base), "a branch");
          if (base.object.sha !== pre.baseSha)
            fail("stale", "The base branch is not at the expected commit", {
              expected: pre.baseSha,
              actual: base.object.sha,
            });
        }
        const open = parse(
          z.array(PullRead),
          await read(["pulls"], {
            state: "open",
            head: `${owner}:${t.head}`,
            base: t.base,
            per_page: "100",
          }),
          "pull requests",
        );
        if (open.length > 0)
          fail("conflict", "An open pull request already exists for this head and base", {
            reason: "exists",
            number: open[0]?.number,
          });
        return {};
      }
      case "issue.update": {
        const number = (d.target as { number: number }).number;
        const issue = parse(IssueRead, await read(["issues", number]), "an issue");
        if (issue.pull_request !== undefined && issue.pull_request !== null)
          fail("wrong-target", `#${number} is a pull request`);
        await expectState(issue.updated_at, issue.body, pre, { state: issue.state });
        return {};
      }
      case "comment.update": {
        const comment = parse(
          CommentRead,
          await read(["issues", "comments", (d.target as { id: number }).id]),
          "a comment",
        );
        if (!comment.issue_url.endsWith(`${root}/issues/${pre.issueNumber}`))
          fail("wrong-target", "The comment is not on the expected issue in this repository");
        if (pre.author !== undefined && comment.user?.login !== pre.author)
          fail("conflict", "The comment is by another author", { reason: "author" });
        await expectState(comment.updated_at, comment.body, pre, {});
        return {};
      }
    }
  }

  async function expectState(
    updatedAt: string,
    body: string | null | undefined,
    pre: Record<string, unknown>,
    actual: { state?: string },
  ) {
    if (updatedAt !== pre.updatedAt)
      fail("stale", "The target changed since it was read", {
        expected: pre.updatedAt,
        actual: updatedAt,
      });
    if (pre.bodyDigest !== undefined && (await bodyDigest(body)) !== pre.bodyDigest)
      fail("stale", "The target's body changed since it was read");
    if (pre.state !== undefined && actual.state !== pre.state)
      fail("stale", "The target's state changed since it was read");
  }

  function resourceOf(d: OperationDescriptor, body: unknown): WrittenResource | null {
    const target = d.target as { number?: number; id?: number };
    switch (d.kind) {
      case "issue.create":
      case "issue.update": {
        const r = IssueRead.safeParse(body);
        return r.success ? { type: "issue", number: r.data.number, url: r.data.html_url } : null;
      }
      case "issue.comment":
      case "comment.update": {
        const r = CommentRead.safeParse(body);
        const issueNumber =
          d.kind === "issue.comment"
            ? (target.number as number)
            : (d.precondition as { issueNumber: number }).issueNumber;
        return r.success
          ? { type: "comment", id: r.data.id, issueNumber, url: r.data.html_url }
          : null;
      }
      case "pull.review": {
        const r = ReviewRead.safeParse(body);
        return r.success
          ? {
              type: "review",
              id: r.data.id,
              pullNumber: target.number as number,
              commitSha: r.data.commit_id ?? null,
              state: r.data.state,
            }
          : null;
      }
      case "pull.create": {
        const r = PullRead.safeParse(body);
        return r.success
          ? { type: "pull", number: r.data.number, url: r.data.html_url, headSha: r.data.head.sha }
          : null;
      }
    }
  }

  /** A fresh read of the written resource, compared field by field with what was authorized. */
  async function verify(
    d: OperationDescriptor,
    resource: WrittenResource,
    sent: Record<string, unknown>,
  ) {
    const mismatches: string[] = [];
    let headMoved: boolean | undefined;
    try {
      switch (resource.type) {
        case "issue": {
          const issue = parse(IssueRead, await read(["issues", resource.number]), "an issue");
          if (sent.title !== undefined && issue.title !== sent.title) mismatches.push("title");
          if (sent.body !== undefined && (issue.body ?? "") !== sent.body) mismatches.push("body");
          if (sent.state !== undefined && issue.state !== sent.state) mismatches.push("state");
          if (
            sent.labels !== undefined &&
            !sameSet(labelNames(issue.labels), sent.labels as string[])
          )
            mismatches.push("labels");
          if (
            sent.assignees !== undefined &&
            !sameSet(
              (issue.assignees ?? []).map((a) => a.login),
              sent.assignees as string[],
            )
          )
            mismatches.push("assignees");
          break;
        }
        case "comment": {
          const comment = parse(
            CommentRead,
            await read(["issues", "comments", resource.id]),
            "a comment",
          );
          if ((comment.body ?? "") !== sent.body) mismatches.push("body");
          if (!comment.issue_url.endsWith(`${root}/issues/${resource.issueNumber}`))
            mismatches.push("issue");
          break;
        }
        case "review": {
          const review = parse(
            ReviewRead,
            await read(["pulls", resource.pullNumber, "reviews", resource.id]),
            "a review",
          );
          if (review.commit_id !== sent.commit_id) mismatches.push("commit");
          if (review.state !== REVIEW_STATE[sent.event as keyof typeof REVIEW_STATE])
            mismatches.push("state");
          if ((review.body ?? "") !== sent.body) mismatches.push("body");
          const pull = parse(
            PullRead,
            await read(["pulls", resource.pullNumber]),
            "a pull request",
          );
          headMoved = pull.head.sha !== (d.precondition as { headSha: string }).headSha;
          break;
        }
        case "pull": {
          const pull = parse(PullRead, await read(["pulls", resource.number]), "a pull request");
          const pre = d.precondition as { headSha: string };
          if (pull.head.sha !== pre.headSha) mismatches.push("head.sha");
          if (pull.head.ref !== sent.head) mismatches.push("head.ref");
          if (pull.head.repo?.full_name !== repository) mismatches.push("head.repository");
          if (pull.base.ref !== sent.base) mismatches.push("base.ref");
          if (pull.title !== sent.title) mismatches.push("title");
          if ((pull.body ?? "") !== sent.body) mismatches.push("body");
          break;
        }
      }
    } catch {
      return { verification: "unavailable" as const, mismatches, headMoved };
    }
    return {
      verification: mismatches.length === 0 ? ("matched" as const) : ("mismatch" as const),
      mismatches,
      headMoved,
    };
  }

  /** Bounded search for an uncertain create, by its marker. Reads only. */
  async function search(
    record: OperationRecord,
  ): Promise<{ found: WrittenResource | null; body: string | null; report: ReconciliationReport }> {
    const d = record.descriptor;
    const marker = record.marker;
    const empty = { complete: false, matches: 0, foreignMarkers: 0, duplicates: [] };
    if (marker === null || !CREATES.has(d.kind)) return { found: null, body: null, report: empty };
    const since =
      record.firstSentAt === null
        ? undefined
        : new Date(Math.max(0, record.firstSentAt - limits.searchSkewMs)).toISOString();
    const t = d.target as { number?: number; head?: string; base?: string };
    let segments: (string | number)[];
    let query: Record<string, string> = {};
    switch (d.kind) {
      case "issue.create":
        segments = ["issues"];
        query = { state: "all", sort: "created", direction: "desc", ...(since ? { since } : {}) };
        break;
      case "issue.comment":
        segments = ["issues", t.number as number, "comments"];
        query = since ? { since } : {};
        break;
      case "pull.review":
        segments = ["pulls", t.number as number, "reviews"];
        break;
      default:
        segments = ["pulls"];
        query = { state: "all", head: `${owner}:${t.head}`, base: t.base as string };
    }
    const matches: { item: z.infer<typeof Listed>; raw: unknown }[] = [];
    let foreign = 0;
    let complete = false;
    for (let page = 1; page <= limits.reconcileMaxPages; page++) {
      const batch = parse(
        z.array(z.unknown()),
        await read(segments, { ...query, per_page: "100", page: String(page) }),
        "a listing",
      );
      for (const raw of batch) {
        const item = parse(Listed, raw, "a listed item");
        if (d.kind === "issue.create" && (raw as { pull_request?: unknown }).pull_request) continue;
        if (!carriesMarker(item.body, marker)) continue;
        if (options.expectedAuthor !== undefined && item.user?.login !== options.expectedAuthor)
          foreign += 1;
        else matches.push({ item, raw });
      }
      if (batch.length < 100) {
        complete = true;
        break;
      }
    }
    const first = matches[0];
    const report: ReconciliationReport = {
      complete,
      matches: matches.length,
      foreignMarkers: foreign,
      duplicates: matches.slice(1).map((m) => m.item.id ?? m.item.number ?? 0),
    };
    if (!first) return { found: null, body: null, report };
    // Listings are newest-first for issues, oldest-first elsewhere; report the oldest as the write.
    const chosen = d.kind === "issue.create" ? (matches.at(-1) ?? first) : first;
    if (d.kind === "issue.create")
      report.duplicates = matches.slice(0, -1).map((m) => m.item.number ?? 0);
    return { found: resourceOf(d, chosen.raw), body: chosen.item.body ?? null, report };
  }

  function outcome(
    record: OperationRecord,
    status: WriteOutcome["status"],
    fields: Partial<
      Omit<WriteOutcome, "status" | "operationId" | "kind" | "repository" | "descriptorDigest">
    >,
  ): Omit<WriteOutcome, "replayed" | "recorded"> {
    return {
      status,
      operationId: record.operationId,
      kind: record.kind,
      repository: record.repository,
      descriptorDigest: record.fingerprint,
      recovered: false,
      resource: null,
      verification: "not-attempted",
      mismatches: [],
      ...fields,
    };
  }

  /** The write was found by reconciliation: record it as succeeded and say how it was found. */
  async function adopt(
    record: OperationRecord,
    found: WrittenResource,
    report: ReconciliationReport,
  ): Promise<WriteOutcome> {
    const sent = payloadOf(record.descriptor, record.marker);
    const checked = await verify(record.descriptor, found, sent);
    const result = outcome(record, checked.verification === "matched" ? "verified" : "accepted", {
      recovered: true,
      resource: found,
      verification: checked.verification,
      mismatches: checked.mismatches,
      reconciliation: report,
      ...(checked.headMoved !== undefined ? { headMovedDuringPublication: checked.headMoved } : {}),
    });
    const recorded = await settle(record, {
      state: "succeeded",
      leaseUntil: null,
      outcome: result,
      failure: null,
    });
    return { ...result, replayed: false, recorded };
  }

  async function markIndeterminate(
    record: OperationRecord,
    reason: string,
    report?: ReconciliationReport,
  ): Promise<WriteOutcome> {
    const result = outcome(record, "indeterminate", {
      reason,
      ...(report ? { reconciliation: report } : {}),
    });
    const recorded = await settle(record, {
      state: "indeterminate",
      leaseUntil: null,
      outcome: result,
    });
    return { ...result, replayed: false, recorded };
  }

  /** For an update that may already have been sent: is it applied, still applicable, or neither? */
  async function updateStatus(
    d: OperationDescriptor,
  ): Promise<"applied" | "applicable" | "diverged"> {
    const sent = payloadOf(d, null);
    const pre = d.precondition as Record<string, unknown>;
    if (d.kind === "issue.update") {
      const issue = parse(
        IssueRead,
        await read(["issues", (d.target as { number: number }).number]),
        "an issue",
      );
      const applied =
        (sent.title === undefined || issue.title === sent.title) &&
        (sent.body === undefined || (issue.body ?? "") === sent.body) &&
        (sent.state === undefined || issue.state === sent.state) &&
        (sent.labels === undefined || sameSet(labelNames(issue.labels), sent.labels as string[]));
      if (applied) return "applied";
      return issue.updated_at === pre.updatedAt ? "applicable" : "diverged";
    }
    const comment = parse(
      CommentRead,
      await read(["issues", "comments", (d.target as { id: number }).id]),
      "a comment",
    );
    if ((comment.body ?? "") === sent.body) return "applied";
    return comment.updated_at === pre.updatedAt ? "applicable" : "diverged";
  }

  // --- execution ------------------------------------------------------------------------------

  /** Takes ownership of the operation's record, or answers from it without sending. */
  async function claim(
    d: OperationDescriptor,
    marker: string | null,
    reference: string | null,
  ): Promise<{ record: OperationRecord } | { answer: WriteOutcome }> {
    for (let round = 0; round < 3; round++) {
      const existing = await store(() => ledger.get(d.operationId));
      const t = now();
      if (!existing) {
        const fresh: OperationRecord = {
          schema: "comforge-github-operation/v1",
          operationId: d.operationId,
          repository,
          kind: d.kind,
          capability: d.capability,
          fingerprint: d.digest,
          descriptor: d,
          version: 1,
          state: "reserved",
          leaseUntil: t + limits.leaseMs,
          attempts: 0,
          firstSentAt: null,
          changedAt: t,
          authorizationReference: reference,
          marker,
          outcome: null,
          failure: null,
          note: null,
        };
        if (await store(() => ledger.create(fresh))) return { record: fresh };
        continue;
      }
      if (existing.repository !== repository || existing.fingerprint !== d.digest)
        fail("conflict", "This operationId was already used for a different operation", {
          reason: "fingerprint-mismatch",
        });
      switch (existing.state) {
        case "succeeded":
          return { answer: storedOutcome(existing, true) };
        case "indeterminate":
          return { answer: storedOutcome(existing, true) };
        case "abandoned":
          fail("conflict", "This operation was abandoned; use a new operationId", {
            reason: "abandoned",
          });
          break;
        case "reserved":
        case "sending": {
          if (existing.leaseUntil !== null && existing.leaseUntil > t)
            fail("conflict", "This operation is in progress elsewhere", { reason: "in-progress" });
          if (existing.state === "sending") {
            // The sender stopped without recording an answer: the write may have happened.
            const taken = await advance(existing, { leaseUntil: t + limits.leaseMs });
            if (!taken) continue;
            return {
              answer: await markIndeterminate(taken, "a previous attempt stopped after sending"),
            };
          }
          const taken = await advance(existing, {
            leaseUntil: t + limits.leaseMs,
            authorizationReference: reference,
          });
          if (taken) return { record: taken };
          continue;
        }
        case "failed": {
          const f = existing.failure;
          if (!f?.retryable)
            fail(f?.code ?? "conflict", f?.message ?? "This operation failed", {
              ...(f?.status !== undefined ? { status: f.status } : {}),
              reason: "failed",
            });
          if (f.notBefore !== null && f.notBefore > t)
            fail("rate-limited", "Retry after GitHub's requested delay", {
              retryAfterSeconds: Math.ceil((f.notBefore - t) / 1000),
            });
          const taken = await advance(existing, {
            state: "reserved",
            leaseUntil: t + limits.leaseMs,
            authorizationReference: reference,
          });
          if (taken) return { record: taken };
          continue;
        }
      }
    }
    fail("conflict", "The operation record kept changing; retry later", { reason: "in-progress" });
  }

  async function execute(operation: WriteOperation): Promise<WriteOutcome> {
    const d = await describe(repository, operation);
    if (!capabilities.includes(d.capability))
      fail("capability-denied", `This writer was not constructed with ${d.capability}`);
    const marker =
      namespace !== null && CREATES.has(d.kind) ? await correlationMarker(namespace, d) : null;
    payloadOf(d, marker); // refuses an over-long body before anything is recorded
    const grant = await authorize(d);
    const claimed = await claim(d, marker, grant.reference);
    if ("answer" in claimed) return claimed.answer;
    let record = claimed.record;

    // A create that may already have reached GitHub is looked for before it is sent again.
    if (record.firstSentAt !== null) {
      if (CREATES.has(d.kind)) {
        let found: Awaited<ReturnType<typeof search>>;
        try {
          found = await search(record);
        } catch {
          return markIndeterminate(record, "could not search for an earlier attempt");
        }
        if (found.found) return adopt(record, found.found, found.report);
        if (!found.report.complete)
          return markIndeterminate(
            record,
            "an earlier attempt could not be ruled out",
            found.report,
          );
      } else {
        const status = await updateStatus(d).catch(() => "diverged" as const);
        if (status === "applied")
          return adopt(record, resourceOf(d, await readTarget(d)) as WrittenResource, {
            complete: true,
            matches: 1,
            foreignMarkers: 0,
            duplicates: [],
          });
        if (status === "diverged")
          return markIndeterminate(record, "the target changed after an earlier attempt");
      }
    }

    try {
      await preflight(d);
    } catch (error) {
      const e =
        error instanceof GitHubAdapterError
          ? error
          : new GitHubAdapterError("malformed-response", "Precondition read failed");
      // Stale or wrong targets are permanent for this exact descriptor; transient reads are not.
      return refuse(
        record,
        e,
        ["timeout", "network", "rate-limited", "http-error"].includes(e.code),
      );
    }
    if (grant.expiresAt <= now())
      return refuse(
        record,
        new GitHubAdapterError(
          "authorization-denied",
          "The authorization expired before the write",
        ),
        true,
      );

    const sending = await advance(record, {
      state: "sending",
      attempts: record.attempts + 1,
      firstSentAt: record.firstSentAt ?? now(),
      leaseUntil: now() + limits.leaseMs,
    });
    if (!sending) fail("conflict", "Another caller took this operation", { reason: "in-progress" });
    record = sending;

    const sent = payloadOf(d, marker);
    let result: Awaited<ReturnType<typeof sendWrite>>;
    try {
      result = await sendWrite(sendOptions, d.kind, writePath(d), sent);
    } catch (error) {
      // Refused before sending (token provider, path): nothing reached GitHub.
      const e =
        error instanceof GitHubAdapterError
          ? error
          : new GitHubAdapterError("network", "The request could not be built");
      return refuse(record, e, true);
    }
    if (result.kind === "refused")
      return refuse(record, result.error, result.error.code === "rate-limited");
    if (result.kind === "sent-unknown") {
      // Look once; never resend.
      const found = CREATES.has(d.kind) ? await search(record).catch(() => null) : null;
      if (found?.found) return adopt(record, found.found, found.report);
      if (!CREATES.has(d.kind)) {
        const status = await updateStatus(d).catch(() => "diverged" as const);
        if (status === "applied")
          return adopt(record, resourceOf(d, await readTarget(d)) as WrittenResource, {
            complete: true,
            matches: 1,
            foreignMarkers: 0,
            duplicates: [],
          });
      }
      return markIndeterminate(
        record,
        `GitHub's answer is unknown (${result.reason})`,
        found?.report,
      );
    }
    const resource = resourceOf(d, result.body);
    if (!resource)
      return markIndeterminate(
        record,
        "GitHub accepted the request but its response was unreadable",
      );
    const checked = await verify(d, resource, sent);
    const final = outcome(record, checked.verification === "matched" ? "verified" : "accepted", {
      resource,
      verification: checked.verification,
      mismatches: checked.mismatches,
      ...(checked.headMoved !== undefined ? { headMovedDuringPublication: checked.headMoved } : {}),
    });
    const recorded = await settle(record, {
      state: "succeeded",
      leaseUntil: null,
      outcome: final,
      failure: null,
    });
    return { ...final, replayed: false, recorded };
  }

  async function readTarget(d: OperationDescriptor): Promise<unknown> {
    return d.kind === "issue.update"
      ? read(["issues", (d.target as { number: number }).number])
      : read(["issues", "comments", (d.target as { id: number }).id]);
  }

  async function reconcile(operationId: string): Promise<WriteOutcome> {
    const record = await store(() => ledger.get(operationId));
    if (!record || record.repository !== repository)
      fail("not-found", "No such operation in the ledger");
    if (record.state === "succeeded") return storedOutcome(record, true);
    const t = now();
    if (record.state === "sending" && record.leaseUntil !== null && record.leaseUntil > t)
      fail("conflict", "This operation is in progress elsewhere", { reason: "in-progress" });
    if (record.state !== "indeterminate" && record.state !== "sending")
      fail("conflict", `A ${record.state} operation has nothing to reconcile`, {
        reason: record.state,
      });
    const owned = await advance(record, { leaseUntil: t + limits.leaseMs });
    if (!owned)
      fail("conflict", "Another caller changed this operation", { reason: "in-progress" });
    const d = owned.descriptor;
    if (CREATES.has(d.kind)) {
      const found = await search(owned);
      if (found.found) return adopt(owned, found.found, found.report);
      return markIndeterminate(
        owned,
        owned.marker === null
          ? "no correlation marker: resolve by inspection, then abandon"
          : found.report.complete
            ? "not found; it may still appear, or it was never created — abandon to give up"
            : "the search was incomplete",
        found.report,
      );
    }
    const status = await updateStatus(d);
    if (status === "applied")
      return adopt(owned, resourceOf(d, await readTarget(d)) as WrittenResource, {
        complete: true,
        matches: 1,
        foreignMarkers: 0,
        duplicates: [],
      });
    if (status === "applicable") {
      // Not applied, and the target is as authorized: a later execute may send it again.
      await settle(owned, {
        state: "failed",
        leaseUntil: null,
        outcome: null,
        failure: {
          code: "incomplete",
          message: "The update was not applied",
          retryable: true,
          notBefore: null,
        },
      });
      return {
        ...outcome(owned, "indeterminate", { reason: "not applied; execute again to resend" }),
        replayed: false,
        recorded: true,
      };
    }
    return markIndeterminate(
      owned,
      "the target changed after the attempt; inspect it, then abandon",
    );
  }

  async function abandon(operationId: string, reason: string): Promise<void> {
    if (
      typeof reason !== "string" ||
      reason.trim().length === 0 ||
      reason.length > 500 ||
      CONTROL.test(reason.replace(/\n/g, " "))
    )
      fail("invalid-input", "An abandonment needs a one-line reason");
    const record = await store(() => ledger.get(operationId));
    if (!record || record.repository !== repository)
      fail("not-found", "No such operation in the ledger");
    if (record.state === "succeeded")
      fail("conflict", "A succeeded operation cannot be abandoned", { reason: "succeeded" });
    if (record.state === "abandoned") return;
    if (
      (record.state === "sending" || record.state === "reserved") &&
      record.leaseUntil !== null &&
      record.leaseUntil > now()
    )
      fail("conflict", "This operation is in progress elsewhere", { reason: "in-progress" });
    if (!(await advance(record, { state: "abandoned", leaseUntil: null, note: reason.trim() })))
      fail("conflict", "Another caller changed this operation", { reason: "in-progress" });
  }

  return Object.freeze({
    repository,
    capabilities,
    prepare: (operation: WriteOperation) => describe(repository, operation),
    execute,
    reconcile,
    abandon,
  });
}
