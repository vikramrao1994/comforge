/**
 * The behaviour every `Ledger` adapter must show, as runner-agnostic cases: run each case's
 * `run()` from any test framework (or a plain script) against fresh, empty ledgers.
 *
 * These cases run in one process. Contention between independent processes, crashes and
 * filesystem faults need real processes and are adapter-specific; the package's own tests
 * cover them for the file and SQLite adapters.
 */
import { type Ledger, type LedgerRecord } from "./contract.ts";
export interface ConformanceRecord extends LedgerRecord {
    readonly state: string;
    readonly payload: {
        readonly items: readonly number[];
        readonly note: string | null;
    };
}
export interface ConformanceCase {
    readonly name: string;
    run(): Promise<void>;
}
/** Opens a fresh, empty ledger in `namespace`; two calls with the same namespace share storage. */
export type OpenLedger = (namespace: string) => Ledger<ConformanceRecord> | Promise<Ledger<ConformanceRecord>>;
export declare class ConformanceFailure extends Error {
    constructor(message: string);
}
export declare function record(operationId: string, version?: number, state?: string): ConformanceRecord;
/**
 * The cases. `namespaces` must give each call a namespace that no other run uses, so cases
 * never share records (for example a counter or random suffix).
 */
export declare function ledgerConformance(open: OpenLedger, options?: {
    namespaces?: () => [string, string];
}): ConformanceCase[];
