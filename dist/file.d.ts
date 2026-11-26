import * as nodeFs from "node:fs";
import { type Ledger, type LedgerRecord, type RecordValidator } from "./contract.ts";
/** The `node:fs` functions the adapter uses; replaceable for fault injection in tests. */
export type FileSystem = Pick<typeof nodeFs, "closeSync" | "fsyncSync" | "linkSync" | "lstatSync" | "mkdirSync" | "openSync" | "readdirSync" | "readFileSync" | "renameSync" | "unlinkSync" | "writeSync">;
export interface FileLedgerOptions<R extends LedgerRecord> {
    /** An existing or creatable directory; it must not be a symbolic link or writable by others. */
    directory: string;
    /** This ledger's subdirectory: `[a-z0-9][a-z0-9._-]{0,63}`. Ledgers in other namespaces never see its records. */
    namespace: string;
    /** Run on every record stored and read; throw to refuse it. */
    validate?: RecordValidator<R>;
    /** Milliseconds since the epoch; used only to age orphaned temp files. */
    clock?: () => number;
    /** Fault injection for tests: replaces individual `node:fs` functions. */
    fs?: Partial<FileSystem>;
}
export interface FileLedgerInspection {
    operations: number;
    /** Operations by `classify(record)` of their current record. */
    classes: Record<string, number>;
    /** Operation directories without any version (a create interrupted before its link). */
    empty: number;
    /** Operations whose current record could not be read; named by directory, never by content. */
    unreadable: {
        directory: string;
        code: string;
        message: string;
    }[];
    orphanTempFiles: number;
}
export interface FileLedger<R extends LedgerRecord> extends Ledger<R> {
    /** Read-only summary of the namespace. Never repairs, moves or removes anything. */
    inspect(options?: {
        classify?: (record: R) => string;
    }): Promise<FileLedgerInspection>;
    /**
     * Removes temp files left by writers that died: older than `olderThanMs` and named after a
     * process id that no longer runs on this machine. A writer whose temp file is removed anyway
     * fails at its link with an `io` error and publishes nothing.
     */
    sweepOrphans(options?: {
        olderThanMs?: number;
    }): Promise<{
        removed: number;
        kept: number;
    }>;
    /**
     * Replaces every version below the current one with a stub, in place: superseded request
     * bodies leave the disk while each version's name stays, so no stalled writer can recreate
     * one. Each stub is written to a flushed temp file and renamed over the version (atomic: the
     * name is never absent); the directory is flushed once at the end. Interrupted at any point,
     * a version holds either its record or its stub. Safe to run concurrently with writers,
     * readers and other compactors. Returns how many versions were rewritten.
     */
    compactHistory(operationId: string): Promise<number>;
    /**
     * Checks that the namespace is safe (`unsafe-path`) and supports exclusive hard links
     * (`unsupported`), and reports whether directories can be flushed. It cannot detect a network
     * filesystem whose `link` or `fsync` is weaker than it claims.
     */
    probe(): Promise<{
        directorySync: boolean;
    }>;
}
export declare function createFileLedger<R extends LedgerRecord>(options: FileLedgerOptions<R>): FileLedger<R>;
