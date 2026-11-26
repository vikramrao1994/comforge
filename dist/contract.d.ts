/**
 * The storage contract every adapter implements: a record per operation identity, created once
 * and then replaced only as its next version, under a compare-and-swap on the version.
 *
 * The contract is generic over the record. It is structurally the `OperationLedger` of
 * `@comforge/github`, so `Ledger<OperationRecord>` can be passed to its writer without this
 * package depending on it.
 */
/** What every stored record carries; the rest of the record belongs to the caller. */
export interface LedgerRecord {
    readonly operationId: string;
    readonly version: number;
}
export interface Ledger<R extends LedgerRecord> {
    /** The current record of `operationId`, as a copy; `null` when none exists. */
    get(operationId: string): Promise<R | null>;
    /**
     * Stores `record` as the first version of its operation, atomically and only when no record
     * of that operation exists. `false` when one already does: the existing record is unchanged.
     */
    create(record: R): Promise<boolean>;
    /**
     * Stores `next` (version `expectedVersion + 1`), atomically and only when the current version
     * is `expectedVersion`. `false` when it is not: the current record is unchanged.
     */
    replace(operationId: string, expectedVersion: number, next: R): Promise<boolean>;
}
/** The version of an operation's first record, in every adapter. */
export declare const INITIAL_VERSION = 1;
/** Longest accepted operation id, in UTF-16 code units. */
export declare const MAX_OPERATION_ID_LENGTH = 512;
export type LedgerErrorCode = 
/** The record or request breaks the contract (identity, version, shape); nothing was stored. */
"invalid-record"
/** A stored record cannot be read as a record of this operation (unparseable or inconsistent). */
 | "corrupt"
/** The stored record belongs to another namespace. */
 | "foreign"
/** A path is a symbolic link, not a directory, or open to other users. */
 | "unsafe-path"
/** The filesystem or driver lacks an operation the adapter needs (for example hard links). */
 | "unsupported"
/** The storage failed (I/O, fsync, busy database). Whether a write took effect is unknown. */
 | "io";
/**
 * Every refusal and failure of an adapter. A caller that cannot tell what happened must treat
 * the operation as not recorded: in particular, an `io` error from `create` or `replace` can
 * follow a write that did take effect, exactly like a crash after it.
 */
export declare class LedgerError extends Error {
    readonly code: LedgerErrorCode;
    readonly detail: Readonly<Record<string, unknown>>;
    constructor(code: LedgerErrorCode, message: string, detail?: Record<string, unknown>, options?: {
        cause?: unknown;
    });
}
export declare const isLedgerError: (error: unknown) => error is LedgerError;
/** A caller-owned check run on every record stored and every record read; it throws to refuse. */
export type RecordValidator<R extends LedgerRecord> = (record: R) => void;
export declare function assertOperationId(operationId: unknown): asserts operationId is string;
/** The shape every adapter requires of a record it is asked to store. */
export declare function assertStorable<R extends LedgerRecord>(record: R, validate?: RecordValidator<R>): void;
/** Checks a record read back from storage against the identity and version it was stored under. */
export declare function assertStored<R extends LedgerRecord>(value: unknown, operationId: string, version: number, validate?: RecordValidator<R>): R;
/** The checks shared by every `replace`, before any storage is touched. */
export declare function assertReplacement<R extends LedgerRecord>(operationId: string, expectedVersion: number, next: R, validate?: RecordValidator<R>): void;
/** A JSON round trip: the stored form, and a copy no caller can mutate the store through. */
export declare function encodeRecord<R extends LedgerRecord>(record: R): string;
export declare function decodeRecord(text: string, operationId: string): unknown;
