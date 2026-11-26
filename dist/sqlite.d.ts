/**
 * A ledger in one SQLite table, through a connection the caller owns.
 *
 * The package imports no SQLite module: `statementDriver` wraps any connection with
 * `prepare(sql).get/all/run` (tested: `bun:sqlite`, `node:sqlite`), so a Node consumer
 * never loads a Bun module and the caller keeps its connection's configuration, transactions and
 * migrations. Each ledger operation is one statement, atomic by SQLite:
 *
 * - `create` is `INSERT … ON CONFLICT(operation_id) DO NOTHING`;
 * - `replace` is `UPDATE … WHERE operation_id = ? AND version = ?` (a compare-and-swap);
 * - an operation id held by another namespace is never read or written: it is refused as `foreign`.
 *
 * Retention is two separate, explicit mechanisms with different guarantees:
 *
 * - `compact` rewrites an old record in place (same identity and version) into a smaller form
 *   the caller chooses, for example without request bodies. The identity stays taken, so a
 *   replay still finds it: idempotency is unlimited.
 * - `purge` deletes old records the caller declares finished. A deleted identity can be created
 *   again: idempotency for it ends at `updatedBefore`. Only a caller whose identities are never
 *   reused after that horizon may purge.
 */
import { type Ledger, type LedgerRecord, type RecordValidator } from "./contract.ts";
export type SQLiteValue = string | number | bigint | null;
type Row = Record<string, unknown>;
/** The three calls the ledger makes on a connection. */
export interface SQLiteDriver {
    get(sql: string, params: readonly SQLiteValue[]): Row | null | undefined;
    all(sql: string, params: readonly SQLiteValue[]): Row[];
    run(sql: string, params: readonly SQLiteValue[]): {
        changes: number | bigint;
    };
}
/** A connection whose prepared statements take positional parameters. */
export interface PreparedDatabase {
    prepare(sql: string): {
        get(...params: any[]): unknown;
        all(...params: any[]): unknown[];
        run(...params: any[]): {
            changes: number | bigint;
        };
    };
}
/** Wraps a `bun:sqlite` or `node:sqlite` connection (tested), or another with the same calls (untested). */
export declare function statementDriver(db: PreparedDatabase): SQLiteDriver;
export interface SQLiteLedgerOptions<R extends LedgerRecord> {
    driver: SQLiteDriver;
    /** Stored in `namespaceColumn` with every record; records of other namespaces are refused. */
    namespace: string;
    /** Default `comforge_ledger`. */
    table?: string;
    /** Default `namespace`. */
    namespaceColumn?: string;
    /** Further columns written with every version, derived from the record (for example its state). */
    columns?: (record: R) => Record<string, SQLiteValue>;
    /** Columns of `columns` a replacement may not change (for example the operation's kind). */
    fixedColumns?: readonly string[];
    /** Run on every record stored and read; throw to refuse it. */
    validate?: RecordValidator<R>;
    /** The form stored, for example without a finished operation's body; keeps id and version. */
    encode?: (record: R) => R;
    /** Timestamps for `created_at` and `updated_at`. */
    clock?: () => Date;
}
export interface RetentionOptions<R> {
    /** Only records last written before this time. */
    updatedBefore: Date;
    /** At most this many records changed. */
    limit: number;
    /** At most this many records read (default 20 × limit). */
    scanLimit?: number;
    /** Rewrite or delete only what this accepts. */
    select: (record: R) => boolean;
}
export interface SQLiteLedger<R extends LedgerRecord> extends Ledger<R> {
    /** Rewrites selected old records as `rewrite(record)`, keeping their identity and version. */
    compact(options: RetentionOptions<R> & {
        rewrite: (record: R) => R;
    }): Promise<RetentionReport>;
    /** Deletes selected old records; their identities can be created again (see the module notes). */
    purge(options: RetentionOptions<R>): Promise<RetentionReport>;
    /** Read-only summary of this namespace. */
    inspect(options?: {
        classify?: (record: R) => string;
        limit?: number;
    }): Promise<{
        operations: number;
        classes: Record<string, number>;
        unreadable: number;
    }>;
}
export interface RetentionReport {
    changed: number;
    scanned: number;
    /** Records that could not be read; never changed. */
    unreadable: number;
}
/**
 * The statements that create the default table for `options` (run each through the driver,
 * inside the caller's own migration). `columns` are the extra columns' SQL types.
 */
export declare function ledgerTableStatements(options: {
    table?: string;
    namespaceColumn?: string;
    columns?: Record<string, "TEXT" | "INTEGER">;
}): string[];
export declare function createSQLiteLedger<R extends LedgerRecord>(options: SQLiteLedgerOptions<R>): SQLiteLedger<R>;
export {};
