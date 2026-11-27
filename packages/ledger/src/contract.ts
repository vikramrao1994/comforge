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
export const INITIAL_VERSION = 1;

/** Longest accepted operation id, in UTF-16 code units. */
export const MAX_OPERATION_ID_LENGTH = 512;

export type LedgerErrorCode =
  /** The record or request breaks the contract (identity, version, shape); nothing was stored. */
  | "invalid-record"
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
export class LedgerError extends Error {
  readonly code: LedgerErrorCode;
  readonly detail: Readonly<Record<string, unknown>>;
  constructor(
    code: LedgerErrorCode,
    message: string,
    detail: Record<string, unknown> = {},
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "LedgerError";
    this.code = code;
    this.detail = Object.freeze({ ...detail });
  }
}

export const isLedgerError = (error: unknown): error is LedgerError => error instanceof LedgerError;

/** A caller-owned check run on every record stored and every record read; it throws to refuse. */
export type RecordValidator<R extends LedgerRecord> = (record: R) => void;

export function assertOperationId(operationId: unknown): asserts operationId is string {
  if (
    typeof operationId !== "string" ||
    operationId.length === 0 ||
    operationId.length > MAX_OPERATION_ID_LENGTH
  )
    throw new LedgerError(
      "invalid-record",
      `an operation id is a non-empty string of at most ${MAX_OPERATION_ID_LENGTH} characters`,
    );
}

const isVersion = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= INITIAL_VERSION;

/** The shape every adapter requires of a record it is asked to store. */
export function assertStorable<R extends LedgerRecord>(
  record: R,
  validate?: RecordValidator<R>,
): void {
  if (record === null || typeof record !== "object" || Array.isArray(record))
    throw new LedgerError("invalid-record", "a record is a JSON object");
  assertOperationId(record.operationId);
  if (!isVersion(record.version))
    throw new LedgerError("invalid-record", "a record version is an integer of at least 1", {
      operationId: record.operationId,
    });
  runValidator(record, validate, "invalid-record");
}

/** Checks a record read back from storage against the identity and version it was stored under. */
export function assertStored<R extends LedgerRecord>(
  value: unknown,
  operationId: string,
  version: number,
  validate?: RecordValidator<R>,
): R {
  const record = value as R;
  if (
    record === null ||
    typeof record !== "object" ||
    Array.isArray(record) ||
    record.operationId !== operationId ||
    record.version !== version
  )
    throw new LedgerError("corrupt", "the stored record is not this operation's", {
      operationId,
      version,
    });
  runValidator(record, validate, "corrupt");
  return record;
}

function runValidator<R extends LedgerRecord>(
  record: R,
  validate: RecordValidator<R> | undefined,
  code: "invalid-record" | "corrupt",
): void {
  if (!validate) return;
  try {
    validate(record);
  } catch (cause) {
    if (cause instanceof LedgerError) throw cause;
    throw new LedgerError(
      code,
      `the record failed the caller's validation: ${cause instanceof Error ? cause.message : String(cause)}`,
      { operationId: record.operationId },
      { cause },
    );
  }
}

/** The checks shared by every `replace`, before any storage is touched. */
export function assertReplacement<R extends LedgerRecord>(
  operationId: string,
  expectedVersion: number,
  next: R,
  validate?: RecordValidator<R>,
): void {
  assertOperationId(operationId);
  if (!isVersion(expectedVersion))
    throw new LedgerError("invalid-record", "the expected version is an integer of at least 1", {
      operationId,
    });
  assertStorable(next, validate);
  if (next.operationId !== operationId || next.version !== expectedVersion + 1)
    throw new LedgerError(
      "invalid-record",
      "a replacement is the next version of the same operation",
      { operationId, expectedVersion, nextVersion: next.version },
    );
}

/** A JSON round trip: the stored form, and a copy no caller can mutate the store through. */
export function encodeRecord<R extends LedgerRecord>(record: R): string {
  let text: string | undefined;
  try {
    text = JSON.stringify(record);
  } catch (cause) {
    throw new LedgerError(
      "invalid-record",
      "the record is not serializable as JSON",
      {},
      { cause },
    );
  }
  if (text === undefined)
    throw new LedgerError("invalid-record", "the record is not serializable as JSON");
  return text;
}

export function decodeRecord(text: string, operationId: string): unknown {
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new LedgerError(
      "corrupt",
      "the stored record is not valid JSON",
      { operationId },
      { cause },
    );
  }
}
