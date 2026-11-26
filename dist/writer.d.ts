import { type GitHubErrorCode } from "./errors.ts";
import { type OperationDescriptor, type WriteCapability, type WriteKind, type WriteOperation } from "./operations.ts";
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
export type OperationState = "reserved" | "sending" | "succeeded" | "failed" | "indeterminate" | "abandoned";
export type WrittenResource = {
    type: "issue";
    number: number;
    url: string;
} | {
    type: "comment";
    id: number;
    issueNumber: number;
    url: string;
} | {
    type: "review";
    id: number;
    pullNumber: number;
    commitSha: string | null;
    state: string;
} | {
    type: "pull";
    number: number;
    url: string;
    headSha: string;
};
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
    /**
     * The written resource exactly as this call's verification read returned it, so a caller
     * needs no second GET for its body. Present only when this call read the resource back and
     * every authorized field matched (`verification: "matched"`, fresh or recovered); absent on a
     * replay (the ledger keeps no response), on `accepted` and on `indeterminate`. Bounded by
     * `maxBodyBytes`; untrusted JSON the caller still validates with its own schema. Never stored.
     */
    response?: VerifiedResponse;
}
/** A body the writer read back and matched against the authorized write in the same call. */
export interface VerifiedResponse {
    /** The GET it came from: the resource itself (an issue, comment, review or pull request). */
    source: "verification-read";
    body: unknown;
}
/** An outcome as the ledger keeps it: no per-call flags and never a response body. */
export type StoredOutcome = Omit<WriteOutcome, "replayed" | "recorded" | "response">;
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
    outcome: StoredOutcome | null;
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
export type AuthorizationDecision = {
    allow: true;
    descriptorDigest: string;
    expiresAt: number;
    reference?: string;
} | {
    allow: false;
    reason?: string;
};
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
export declare const DEFAULT_WRITER_LIMITS: WriterLimits;
export interface GitHubWriterOptions {
    repository: {
        owner: string;
        name: string;
    };
    /** A token, or a function returning one per request. Never stored, logged or returned. */
    token: string | (() => string | Promise<string>);
    /** The only writes this writer performs, whatever the token permits. */
    capabilities: readonly WriteCapability[];
    /** The consumer's policy decision for one exact descriptor. */
    authorize: (descriptor: OperationDescriptor) => AuthorizationDecision | Promise<AuthorizationDecision>;
    ledger: OperationLedger;
    /** Milliseconds since the epoch. Injected: the package reads no ambient clock. */
    clock: () => number;
    /**
     * Correlation markers appended to created bodies, so an uncertain create can be found.
     * `false` disables them; an uncertain create then stays `indeterminate` until you resolve it.
     */
    markers?: {
        namespace?: string;
    } | false;
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
export declare function createGitHubWriter(options: GitHubWriterOptions): GitHubWriter;
