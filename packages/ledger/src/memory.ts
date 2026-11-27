import {
  assertOperationId,
  assertReplacement,
  assertStorable,
  assertStored,
  decodeRecord,
  encodeRecord,
  INITIAL_VERSION,
  type Ledger,
  LedgerError,
  type LedgerRecord,
  type RecordValidator,
} from "./contract.ts";

export interface MemoryLedgerOptions<R extends LedgerRecord> {
  validate?: RecordValidator<R>;
}

/**
 * A ledger held in this process's memory, for tests and examples. Atomic within one process
 * only, and lost when the process ends: never a production store.
 */
export function createMemoryLedger<R extends LedgerRecord>(
  options: MemoryLedgerOptions<R> = {},
): Ledger<R> & { size(): number } {
  const rows = new Map<string, { version: number; text: string }>();
  return {
    async get(operationId) {
      assertOperationId(operationId);
      const row = rows.get(operationId);
      if (!row) return null;
      return assertStored(
        decodeRecord(row.text, operationId),
        operationId,
        row.version,
        options.validate,
      );
    },
    async create(record) {
      assertStorable(record, options.validate);
      if (record.version !== INITIAL_VERSION)
        throw new LedgerError("invalid-record", `a first record is version ${INITIAL_VERSION}`, {
          operationId: record.operationId,
        });
      if (rows.has(record.operationId)) return false;
      rows.set(record.operationId, { version: record.version, text: encodeRecord(record) });
      return true;
    },
    async replace(operationId, expectedVersion, next) {
      assertReplacement(operationId, expectedVersion, next, options.validate);
      const row = rows.get(operationId);
      if (!row || row.version !== expectedVersion) return false;
      rows.set(operationId, { version: next.version, text: encodeRecord(next) });
      return true;
    },
    size: () => rows.size,
  };
}
