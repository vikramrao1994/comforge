import { type Ledger, type LedgerRecord, type RecordValidator } from "./contract.ts";
export interface MemoryLedgerOptions<R extends LedgerRecord> {
    validate?: RecordValidator<R>;
}
/**
 * A ledger held in this process's memory, for tests and examples. Atomic within one process
 * only, and lost when the process ends: never a production store.
 */
export declare function createMemoryLedger<R extends LedgerRecord>(options?: MemoryLedgerOptions<R>): Ledger<R> & {
    size(): number;
};
