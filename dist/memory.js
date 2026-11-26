import { assertOperationId, assertReplacement, assertStorable, assertStored, decodeRecord, encodeRecord, INITIAL_VERSION, LedgerError, } from "./contract.js";
/**
 * A ledger held in this process's memory, for tests and examples. Atomic within one process
 * only, and lost when the process ends: never a production store.
 */
export function createMemoryLedger(options = {}) {
    const rows = new Map();
    return {
        async get(operationId) {
            assertOperationId(operationId);
            const row = rows.get(operationId);
            if (!row)
                return null;
            return assertStored(decodeRecord(row.text, operationId), operationId, row.version, options.validate);
        },
        async create(record) {
            assertStorable(record, options.validate);
            if (record.version !== INITIAL_VERSION)
                throw new LedgerError("invalid-record", `a first record is version ${INITIAL_VERSION}`, {
                    operationId: record.operationId,
                });
            if (rows.has(record.operationId))
                return false;
            rows.set(record.operationId, { version: record.version, text: encodeRecord(record) });
            return true;
        },
        async replace(operationId, expectedVersion, next) {
            assertReplacement(operationId, expectedVersion, next, options.validate);
            const row = rows.get(operationId);
            if (!row || row.version !== expectedVersion)
                return false;
            rows.set(operationId, { version: next.version, text: encodeRecord(next) });
            return true;
        },
        size: () => rows.size,
    };
}
