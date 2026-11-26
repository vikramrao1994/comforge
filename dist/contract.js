/**
 * The storage contract every adapter implements: a record per operation identity, created once
 * and then replaced only as its next version, under a compare-and-swap on the version.
 *
 * The contract is generic over the record. It is structurally the `OperationLedger` of
 * `@comforge/github`, so `Ledger<OperationRecord>` can be passed to its writer without this
 * package depending on it.
 */
/** The version of an operation's first record, in every adapter. */
export const INITIAL_VERSION = 1;
/** Longest accepted operation id, in UTF-16 code units. */
export const MAX_OPERATION_ID_LENGTH = 512;
/**
 * Every refusal and failure of an adapter. A caller that cannot tell what happened must treat
 * the operation as not recorded: in particular, an `io` error from `create` or `replace` can
 * follow a write that did take effect, exactly like a crash after it.
 */
export class LedgerError extends Error {
    code;
    detail;
    constructor(code, message, detail = {}, options) {
        super(message, options);
        this.name = "LedgerError";
        this.code = code;
        this.detail = Object.freeze({ ...detail });
    }
}
export const isLedgerError = (error) => error instanceof LedgerError;
export function assertOperationId(operationId) {
    if (typeof operationId !== "string" ||
        operationId.length === 0 ||
        operationId.length > MAX_OPERATION_ID_LENGTH)
        throw new LedgerError("invalid-record", `an operation id is a non-empty string of at most ${MAX_OPERATION_ID_LENGTH} characters`);
}
const isVersion = (v) => typeof v === "number" && Number.isSafeInteger(v) && v >= INITIAL_VERSION;
/** The shape every adapter requires of a record it is asked to store. */
export function assertStorable(record, validate) {
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
export function assertStored(value, operationId, version, validate) {
    const record = value;
    if (record === null ||
        typeof record !== "object" ||
        Array.isArray(record) ||
        record.operationId !== operationId ||
        record.version !== version)
        throw new LedgerError("corrupt", "the stored record is not this operation's", {
            operationId,
            version,
        });
    runValidator(record, validate, "corrupt");
    return record;
}
function runValidator(record, validate, code) {
    if (!validate)
        return;
    try {
        validate(record);
    }
    catch (cause) {
        if (cause instanceof LedgerError)
            throw cause;
        throw new LedgerError(code, `the record failed the caller's validation: ${cause instanceof Error ? cause.message : String(cause)}`, { operationId: record.operationId }, { cause });
    }
}
/** The checks shared by every `replace`, before any storage is touched. */
export function assertReplacement(operationId, expectedVersion, next, validate) {
    assertOperationId(operationId);
    if (!isVersion(expectedVersion))
        throw new LedgerError("invalid-record", "the expected version is an integer of at least 1", {
            operationId,
        });
    assertStorable(next, validate);
    if (next.operationId !== operationId || next.version !== expectedVersion + 1)
        throw new LedgerError("invalid-record", "a replacement is the next version of the same operation", { operationId, expectedVersion, nextVersion: next.version });
}
/** A JSON round trip: the stored form, and a copy no caller can mutate the store through. */
export function encodeRecord(record) {
    let text;
    try {
        text = JSON.stringify(record);
    }
    catch (cause) {
        throw new LedgerError("invalid-record", "the record is not serializable as JSON", {}, { cause });
    }
    if (text === undefined)
        throw new LedgerError("invalid-record", "the record is not serializable as JSON");
    return text;
}
export function decodeRecord(text, operationId) {
    try {
        return JSON.parse(text);
    }
    catch (cause) {
        throw new LedgerError("corrupt", "the stored record is not valid JSON", { operationId }, { cause });
    }
}
