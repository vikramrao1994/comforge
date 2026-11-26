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

export type SQLiteValue = string | number | bigint | null;
type Row = Record<string, unknown>;

/** The three calls the ledger makes on a connection. */
export interface SQLiteDriver {
  get(sql: string, params: readonly SQLiteValue[]): Row | null | undefined;
  all(sql: string, params: readonly SQLiteValue[]): Row[];
  run(sql: string, params: readonly SQLiteValue[]): { changes: number | bigint };
}

/** A connection whose prepared statements take positional parameters. */
export interface PreparedDatabase {
  prepare(sql: string): {
    // biome-ignore lint/suspicious/noExplicitAny: each driver types its own parameters
    get(...params: any[]): unknown;
    // biome-ignore lint/suspicious/noExplicitAny: each driver types its own parameters
    all(...params: any[]): unknown[];
    // biome-ignore lint/suspicious/noExplicitAny: each driver types its own parameters
    run(...params: any[]): { changes: number | bigint };
  };
}

/** Wraps a `bun:sqlite` or `node:sqlite` connection (tested), or another with the same calls (untested). */
export function statementDriver(db: PreparedDatabase): SQLiteDriver {
  return {
    get: (sql, params) => (db.prepare(sql).get(...params) as Row | null | undefined) ?? null,
    all: (sql, params) => db.prepare(sql).all(...params) as Row[],
    run: (sql, params) => db.prepare(sql).run(...params),
  };
}

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
  compact(options: RetentionOptions<R> & { rewrite: (record: R) => R }): Promise<RetentionReport>;
  /** Deletes selected old records; their identities can be created again (see the module notes). */
  purge(options: RetentionOptions<R>): Promise<RetentionReport>;
  /** Read-only summary of this namespace. */
  inspect(options?: { classify?: (record: R) => string; limit?: number }): Promise<{
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

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const CORE_COLUMNS = ["operation_id", "version", "record_json", "created_at", "updated_at"];

function identifier(name: string, what: string): string {
  if (!IDENTIFIER.test(name))
    throw new LedgerError("invalid-record", `${what} is not a plain SQL identifier: ${name}`);
  return name;
}

/**
 * The statements that create the default table for `options` (run each through the driver,
 * inside the caller's own migration). `columns` are the extra columns' SQL types.
 */
export function ledgerTableStatements(options: {
  table?: string;
  namespaceColumn?: string;
  columns?: Record<string, "TEXT" | "INTEGER">;
}): string[] {
  const table = identifier(options.table ?? "comforge_ledger", "the table");
  const ns = identifier(options.namespaceColumn ?? "namespace", "the namespace column");
  const extra = Object.entries(options.columns ?? {}).map(([name, type]) => {
    identifier(name, "a column");
    if (type !== "TEXT" && type !== "INTEGER")
      throw new LedgerError("invalid-record", "a column is TEXT or INTEGER");
    return `  ${name} ${type} NOT NULL,`;
  });
  return [
    [
      `CREATE TABLE IF NOT EXISTS ${table} (`,
      "  operation_id TEXT PRIMARY KEY,",
      `  ${ns} TEXT NOT NULL,`,
      ...extra,
      `  version INTEGER NOT NULL CHECK (version >= ${INITIAL_VERSION}),`,
      "  record_json TEXT NOT NULL,",
      "  created_at TEXT NOT NULL,",
      "  updated_at TEXT NOT NULL",
      ")",
    ].join("\n"),
    `CREATE INDEX IF NOT EXISTS ${table}_${ns}_updated ON ${table} (${ns}, updated_at)`,
  ];
}

export function createSQLiteLedger<R extends LedgerRecord>(
  options: SQLiteLedgerOptions<R>,
): SQLiteLedger<R> {
  const { driver, namespace, validate } = options;
  if (typeof namespace !== "string" || namespace.length === 0)
    throw new LedgerError("invalid-record", "the ledger needs a namespace");
  const table = identifier(options.table ?? "comforge_ledger", "the table");
  const nsColumn = identifier(options.namespaceColumn ?? "namespace", "the namespace column");
  const fixed = (options.fixedColumns ?? []).map((c) => identifier(c, "a fixed column"));
  const clock = options.clock ?? (() => new Date());
  const reserved = new Set([...CORE_COLUMNS, nsColumn]);

  const extraColumns = (record: R): [string, SQLiteValue][] => {
    const entries = Object.entries(options.columns?.(record) ?? {});
    for (const [name] of entries)
      if (reserved.has(identifier(name, "a column")))
        throw new LedgerError("invalid-record", `the column ${name} is the ledger's own`);
    for (const name of fixed)
      if (!entries.some(([n]) => n === name))
        throw new LedgerError(
          "invalid-record",
          `the fixed column ${name} is not among the record's columns`,
        );
    return entries;
  };

  const stored = (record: R): string => {
    const form = options.encode ? options.encode(record) : record;
    if (form.operationId !== record.operationId || form.version !== record.version)
      throw new LedgerError(
        "invalid-record",
        "the stored form keeps the record's identity and version",
      );
    return encodeRecord(form);
  };

  const call = <T>(what: string, run: () => T): T => {
    try {
      return run();
    } catch (cause) {
      if (cause instanceof LedgerError) throw cause;
      const message = cause instanceof Error ? cause.message : String(cause);
      throw new LedgerError(
        /constraint/i.test(message) ? "invalid-record" : "io",
        `${what} failed: ${message}`,
        {},
        { cause },
      );
    }
  };

  const changes = (r: { changes: number | bigint }) => Number(r.changes);

  const rowOf = (operationId: string): Row | null =>
    call(
      "reading the ledger",
      () =>
        driver.get(
          `SELECT ${nsColumn} AS ns, version, record_json FROM ${table} WHERE operation_id = ?`,
          [operationId],
        ) ?? null,
    );

  const assertOwn = (row: Row, operationId: string) => {
    if (row.ns !== namespace)
      throw new LedgerError("foreign", "the operation id is held by another namespace", {
        operationId,
      });
  };

  const decodeRow = (row: Row, operationId: string): R => {
    if (typeof row.record_json !== "string")
      throw new LedgerError("corrupt", "the stored record is not text", { operationId });
    return assertStored<R>(
      decodeRecord(row.record_json, operationId),
      operationId,
      Number(row.version),
      validate,
    );
  };

  /** Pages of this namespace's records last written before `before`, oldest first. */
  function* oldRows(before: Date, scanLimit: number): Generator<Row> {
    let cursor: [string, string] = ["", ""];
    let scanned = 0;
    while (scanned < scanLimit) {
      const page = call("scanning the ledger", () =>
        driver.all(
          `SELECT operation_id, version, record_json, updated_at FROM ${table} WHERE ${nsColumn} = ? AND updated_at < ? AND (updated_at > ? OR (updated_at = ? AND operation_id > ?)) ORDER BY updated_at, operation_id LIMIT ?`,
          [
            namespace,
            before.toISOString(),
            cursor[0],
            cursor[0],
            cursor[1],
            Math.min(100, scanLimit - scanned),
          ],
        ),
      );
      if (page.length === 0) return;
      for (const row of page) {
        scanned += 1;
        cursor = [String(row.updated_at), String(row.operation_id)];
        yield row;
      }
    }
  }

  const retention = async (
    o: RetentionOptions<R>,
    change: (row: Row, record: R) => boolean,
  ): Promise<RetentionReport> => {
    if (!(o.updatedBefore instanceof Date) || !Number.isSafeInteger(o.limit) || o.limit < 1)
      throw new LedgerError("invalid-record", "retention needs updatedBefore and a positive limit");
    const report: RetentionReport = { changed: 0, scanned: 0, unreadable: 0 };
    for (const row of oldRows(o.updatedBefore, o.scanLimit ?? o.limit * 20)) {
      report.scanned += 1;
      let record: R;
      try {
        record = decodeRow(row, String(row.operation_id));
      } catch {
        report.unreadable += 1;
        continue;
      }
      if (o.select(record) && change(row, record)) report.changed += 1;
      if (report.changed >= o.limit) break;
    }
    return report;
  };

  return {
    async get(operationId) {
      assertOperationId(operationId);
      const row = rowOf(operationId);
      if (!row) return null;
      assertOwn(row, operationId);
      return decodeRow(row, operationId);
    },

    async create(record) {
      assertStorable(record, validate);
      if (record.version !== INITIAL_VERSION)
        throw new LedgerError("invalid-record", `a first record is version ${INITIAL_VERSION}`, {
          operationId: record.operationId,
        });
      const extra = extraColumns(record);
      const now = clock().toISOString();
      const names = [
        "operation_id",
        nsColumn,
        ...extra.map(([n]) => n),
        "version",
        "record_json",
        "created_at",
        "updated_at",
      ];
      const inserted = changes(
        call("creating a ledger record", () =>
          driver.run(
            `INSERT INTO ${table} (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")}) ON CONFLICT(operation_id) DO NOTHING`,
            [
              record.operationId,
              namespace,
              ...extra.map(([, v]) => v),
              record.version,
              stored(record),
              now,
              now,
            ],
          ),
        ),
      );
      if (inserted === 1) return true;
      const existing = rowOf(record.operationId);
      if (existing) assertOwn(existing, record.operationId);
      return false;
    },

    async replace(operationId, expectedVersion, next) {
      assertReplacement(operationId, expectedVersion, next, validate);
      const extra = extraColumns(next);
      const fixedValues = fixed.map((name) => extra.find(([n]) => n === name)?.[1] ?? null);
      const updated = changes(
        call("replacing a ledger record", () =>
          driver.run(
            `UPDATE ${table} SET version = ?, record_json = ?, updated_at = ?${extra.map(([n]) => `, ${n} = ?`).join("")} WHERE operation_id = ? AND version = ? AND ${nsColumn} = ?${fixed.map((n) => ` AND ${n} = ?`).join("")}`,
            [
              next.version,
              stored(next),
              clock().toISOString(),
              ...extra.map(([, v]) => v),
              operationId,
              expectedVersion,
              namespace,
              ...fixedValues,
            ],
          ),
        ),
      );
      if (updated === 1) return true;
      const row = rowOf(operationId);
      if (row) {
        assertOwn(row, operationId);
        if (Number(row.version) === expectedVersion)
          throw new LedgerError("invalid-record", "a replacement cannot change a fixed column", {
            operationId,
            fixedColumns: fixed,
          });
      }
      return false;
    },

    compact(o) {
      return retention(o, (row, record) => {
        const next = o.rewrite(record);
        assertStored(next, record.operationId, record.version, validate);
        const text = stored(next);
        if (text === row.record_json) return false;
        return (
          changes(
            call("compacting a ledger record", () =>
              driver.run(
                `UPDATE ${table} SET record_json = ? WHERE operation_id = ? AND version = ? AND record_json = ? AND ${nsColumn} = ?`,
                [text, record.operationId, record.version, row.record_json as string, namespace],
              ),
            ),
          ) === 1
        );
      });
    },

    purge(o) {
      return retention(
        o,
        (_row, record) =>
          changes(
            call("purging a ledger record", () =>
              driver.run(
                `DELETE FROM ${table} WHERE operation_id = ? AND version = ? AND ${nsColumn} = ?`,
                [record.operationId, record.version, namespace],
              ),
            ),
          ) === 1,
      );
    },

    async inspect({ classify, limit = 10_000 } = {}) {
      const total = call("counting the ledger", () =>
        driver.get(`SELECT count(*) AS n FROM ${table} WHERE ${nsColumn} = ?`, [namespace]),
      );
      const rows = call("reading the ledger", () =>
        driver.all(
          `SELECT operation_id, version, record_json FROM ${table} WHERE ${nsColumn} = ? ORDER BY updated_at LIMIT ?`,
          [namespace, limit],
        ),
      );
      const classes: Record<string, number> = {};
      let unreadable = 0;
      for (const row of rows) {
        try {
          const record = decodeRow(row, String(row.operation_id));
          const name = classify ? classify(record) : "record";
          classes[name] = (classes[name] ?? 0) + 1;
        } catch {
          unreadable += 1;
        }
      }
      return { operations: Number(total?.n ?? 0), classes, unreadable };
    },
  };
}
