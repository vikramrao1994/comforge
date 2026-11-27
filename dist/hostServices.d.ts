import { type AdvisoryReview, type AuthorizationDecision, type EvidenceLimits, type FetchTransportOptions, type FileBytesEvidence, GitHubAdapterError, type GitHubEvidence, type GitHubTransport, type IssueCommentEvidence, listAdvisoryReviews, type OperationDescriptor, type OperationLedger, type OperationRecord, type UntrustedText, type WriteCapability, type WriteOperation, type WriteOutcome, type WrittenResource } from "@comforge/github";
import { type PreparedDatabase, type RetentionReport } from "@comforge/ledger/sqlite";
import type { TrustedConfigSnapshot } from "./host.ts";
export declare const HOST_SERVICES_SCHEMA: "comforge-host-services/v1";
/** One GitHub read: `get(path, query)`. The host's own client, or `fetchTransport`. */
export type HostTransport = GitHubTransport;
/** Exact-commit, complete-or-refuse reads of one repository. */
export type HostEvidence = GitHubEvidence;
/** The host's SQLite handle: `prepare(sql)` returning a statement with `run`, `get` and `all`. */
export type HostDatabase = PreparedDatabase;
/** Durable operation records with insert-if-absent and version-checked replace. */
export type OperationStore = OperationLedger;
/**
 * Every refusal of these services: `code` is stable, `detail` carries no credential or body.
 * One class for reads, writes and stores, so a host maps it once.
 */
export declare const HostServiceError: typeof GitHubAdapterError;
export type HostServiceError = GitHubAdapterError;
export type { AdvisoryReview, AuthorizationDecision, FileBytesEvidence, IssueCommentEvidence, OperationDescriptor, OperationRecord, TrustedConfigSnapshot, UntrustedText, WriteCapability, WriteOperation, WriteOutcome, WrittenResource, };
/** A transport over `fetch` with a server-owned token; GitHub's API origin unless overridden. */
export declare function fetchTransport(options: FetchTransportOptions): HostTransport;
export interface HostWriteOptions {
    /** Server-owned. Never stored, logged or returned. */
    token: string | (() => string | Promise<string>);
    /** The only writes performed, whatever the token permits. */
    capabilities: readonly WriteCapability[];
    /** The host's decision for one exact descriptor. Policy stays with the host. */
    authorize: (descriptor: OperationDescriptor) => AuthorizationDecision | Promise<AuthorizationDecision>;
    operations: OperationStore;
    /** Milliseconds since the epoch. */
    clock: () => number;
    markers?: {
        namespace?: string;
    } | false;
    /** The login the token writes as; reconciliation trusts only its markers. */
    expectedAuthor?: string;
    fetchImpl?: typeof fetch;
    apiOrigin?: string;
    timeoutMs?: number;
    maxBodyBytes?: number;
    userAgent?: string;
}
export interface EngineeringHostOptions {
    repository: {
        owner: string;
        name: string;
    };
    transport: HostTransport;
    /** Paging and text bounds of the evidence reads; the package defaults otherwise. */
    evidenceLimits?: Partial<EvidenceLimits>;
    writes?: HostWriteOptions;
}
export interface HostWrites {
    /** The exact descriptor `operation` would send; sends nothing. */
    prepare(operation: WriteOperation): Promise<OperationDescriptor>;
    /** Sends once per operation id; a repeat is answered from the operation store. */
    execute(operation: WriteOperation): Promise<WriteOutcome>;
    /** Settles an uncertain write against GitHub without sending it again. */
    reconcile(operationId: string): Promise<WriteOutcome>;
    abandon(operationId: string, reason: string): Promise<void>;
}
export interface EngineeringHost {
    readonly schema: typeof HOST_SERVICES_SCHEMA;
    /** `owner/name`. */
    readonly repository: string;
    readonly profile: "read-only" | "governed-writes";
    readonly evidence: HostEvidence;
    /**
     * Advisory reviews on a pull request, decoded under the host's review protocol. Author trust
     * comes from the forge's authenticated comment author and `trustedAuthors`, never from text.
     */
    advisoryReviews(protocol: Parameters<typeof listAdvisoryReviews>[1], pullRequest: {
        number: number;
        headSha: string;
    }, options: {
        trustedAuthors: readonly string[];
    }): Promise<AdvisoryReview[]>;
    /** `comforge.config.json` at the head of `branch`, as bytes at one immutable revision. */
    trustedConfig(options: {
        branch: string;
        now?: () => number;
        maxBytes?: number;
    }): Promise<TrustedConfigSnapshot>;
    /** Whether GitHub holds exactly `snapshot.text` at `snapshot.revision`. */
    confirmTrustedConfig(snapshot: Pick<TrustedConfigSnapshot, "revision" | "text">): Promise<"match" | "mismatch" | "absent">;
    readonly writes: HostWrites;
}
export declare function createEngineeringHost(options: EngineeringHostOptions): EngineeringHost;
/** An operation that can never be sent again: succeeded, abandoned, or failed without retry. */
export declare function isFinished(record: OperationRecord): boolean;
/**
 * The stored form of a record: a finished one keeps a digest of its body instead of the body.
 * Identity, version, fingerprint, descriptor digest, outcome and failure are untouched.
 */
export declare function minimizeFinished(record: OperationRecord): OperationRecord;
export type RetentionClass = "retryable" | "unresolved" | "finished-compact" | "finished-compactable";
export declare function retentionClass(record: OperationRecord): RetentionClass;
export interface SqliteOperationStoreOptions {
    /** The host's database. `prepare` is called on first use, never at construction. */
    database: HostDatabase;
    /** The repository (`owner/name`) whose records this store holds; others are refused. */
    repository: string;
    /** Default `comforge_ledger`. An existing table keeps its name, columns and rows. */
    table?: string;
    /** The column holding the repository. Default `namespace`. */
    repositoryColumn?: string;
    /** Write `kind` and `state` beside each record (`kind` can never change). Default false. */
    kindAndStateColumns?: boolean;
    clock?: () => Date;
}
export interface SqliteOperationStore extends OperationStore {
    /** Read-only: how many of this repository's records are in each retention class. */
    inspect(): Promise<{
        operations: number;
        classes: Record<string, number>;
        unreadable: number;
    }>;
    /**
     * Identity-preserving: finished records last written before `before` are rewritten in their
     * minimized form, at most `limit` per call. Unresolved and retryable records are never touched.
     */
    compact(options: {
        before: Date;
        limit: number;
    }): Promise<RetentionReport>;
}
/**
 * The operation store over the host's SQLite database. Atomic across processes and restarts
 * (insert-if-absent, version-checked replace). A record never holds a credential, a finished
 * one is stored minimized, and one that is malformed, of another repository or inconsistent
 * with its state is refused, so the writer reports a store failure and sends nothing.
 */
export declare function sqliteOperationStore(options: SqliteOperationStoreOptions): SqliteOperationStore;
