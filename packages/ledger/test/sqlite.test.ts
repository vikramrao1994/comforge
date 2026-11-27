import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { record } from "../src/conformance.ts";
import { LedgerError } from "../src/contract.ts";
import {
  createSQLiteLedger,
  ledgerTableStatements,
  type SQLiteLedgerOptions,
  statementDriver,
} from "../src/sqlite.ts";

// The SQLite adapter beyond the shared cases: namespaces, fixed columns, the stored form,
// driver failures and the two retention mechanisms.

type R = ReturnType<typeof record>;

function setup(extra: Partial<SQLiteLedgerOptions<R>> = {}) {
  const db = new Database(":memory:");
  for (const sql of ledgerTableStatements({
    table: "ops",
    namespaceColumn: "repo",
    columns: { kind: "TEXT", state: "TEXT" },
  }))
    db.prepare(sql).run();
  let now = Date.parse("2026-01-01T00:00:00Z");
  const open = (namespace = "acme/widgets", more: Partial<SQLiteLedgerOptions<R>> = {}) =>
    createSQLiteLedger<R>({
      driver: statementDriver(db),
      namespace,
      table: "ops",
      namespaceColumn: "repo",
      columns: (r) => ({ kind: (r as R & { kind?: string }).kind ?? "comment", state: r.state }),
      fixedColumns: ["kind"],
      clock: () => new Date(now),
      ...extra,
      ...more,
    });
  return {
    db,
    open,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

async function refusal(p: Promise<unknown>): Promise<LedgerError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof LedgerError) return e;
    throw e;
  }
  throw new Error("expected a LedgerError");
}

describe("namespaces", () => {
  test("an id held by another namespace is refused as foreign on read, create and replace", async () => {
    const { open } = setup();
    await open("a/a").create(record("op", 1, "a"));
    const b = open("b/b");
    expect((await refusal(b.get("op"))).code).toBe("foreign");
    expect((await refusal(b.create(record("op", 1, "b")))).code).toBe("foreign");
    expect((await refusal(b.replace("op", 1, record("op", 2, "b")))).code).toBe("foreign");
    expect((await open("a/a").get("op"))?.state).toBe("a");
  });
});

describe("columns", () => {
  test("extra columns follow the record; a replacement cannot change a fixed column", async () => {
    const { db, open } = setup();
    const ledger = open();
    await ledger.create({ ...record("op"), kind: "comment" } as R);
    await ledger.replace("op", 1, { ...record("op", 2, "succeeded"), kind: "comment" } as R);
    expect(db.prepare("SELECT kind, state, version, repo FROM ops").get()).toEqual({
      kind: "comment",
      state: "succeeded",
      version: 2,
      repo: "acme/widgets",
    });
    expect(
      (await refusal(ledger.replace("op", 2, { ...record("op", 3), kind: "issue" } as R))).code,
    ).toBe("invalid-record");
    expect((await ledger.get("op"))?.version).toBe(2);
  });

  test("identifiers are plain names; the ledger's own columns cannot be overridden", () => {
    const { db } = setup();
    expect(() =>
      createSQLiteLedger({
        driver: statementDriver(db),
        namespace: "n",
        table: "ops; DROP TABLE ops",
      }),
    ).toThrow(LedgerError);
    const { open } = setup();
    expect(
      refusal(open("n", { columns: () => ({ version: 9 }) }).create(record("op"))),
    ).resolves.toMatchObject({ code: "invalid-record" });
  });

  test("a CHECK constraint of the caller's table is invalid-record; a closed connection is io", async () => {
    const db = new Database(":memory:");
    db.prepare(
      "CREATE TABLE comforge_ledger (operation_id TEXT PRIMARY KEY, namespace TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('reserved')), version INTEGER NOT NULL, record_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
    ).run();
    const ledger = createSQLiteLedger<R>({
      driver: statementDriver(db),
      namespace: "n",
      columns: (r) => ({ state: r.state }),
    });
    expect((await refusal(ledger.create(record("op", 1, "other")))).code).toBe("invalid-record");
    db.close();
    expect((await refusal(ledger.get("op"))).code).toBe("io");
  });
});

describe("stored form and validation", () => {
  test("encode stores a smaller form with the same identity; it may not change identity", async () => {
    const { open } = setup();
    const ledger = open("n", {
      encode: (r) => (r.state === "succeeded" ? { ...r, payload: { items: [], note: null } } : r),
    });
    await ledger.create(record("op"));
    await ledger.replace("op", 1, record("op", 2, "succeeded"));
    expect((await ledger.get("op"))?.payload).toEqual({ items: [], note: null });
    const bad = open("n2", { encode: (r) => ({ ...r, version: 7 }) });
    expect((await refusal(bad.create(record("x")))).code).toBe("invalid-record");
  });

  test("a row whose record names another operation or version is corrupt", async () => {
    const { db, open } = setup();
    await open().create(record("op"));
    db.prepare("UPDATE ops SET record_json = ? WHERE operation_id = 'op'").run(
      JSON.stringify(record("other")),
    );
    expect((await refusal(open().get("op"))).code).toBe("corrupt");
    db.prepare("UPDATE ops SET record_json = '{' WHERE operation_id = 'op'").run();
    expect((await refusal(open().get("op"))).code).toBe("corrupt");
  });
});

describe("retention", () => {
  const DAY = 86_400_000;
  async function seeded() {
    const s = setup();
    const ledger = s.open();
    await ledger.create(record("done-old", 1, "succeeded"));
    await ledger.create(record("open-old", 1, "reserved"));
    s.advance(40 * DAY);
    await ledger.create(record("done-new", 1, "succeeded"));
    return { ...s, ledger, cutoff: new Date(Date.parse("2026-01-01T00:00:00Z") + 30 * DAY) };
  }

  test("compact rewrites only selected old records, in place: the identity stays taken", async () => {
    const { ledger, cutoff, open } = await seeded();
    const report = await ledger.compact({
      updatedBefore: cutoff,
      limit: 10,
      select: (r) => r.state === "succeeded",
      rewrite: (r) => ({ ...r, payload: { items: [], note: null } }),
    });
    expect(report).toEqual({ changed: 1, scanned: 2, unreadable: 0 });
    expect((await ledger.get("done-old"))?.payload).toEqual({ items: [], note: null });
    expect((await ledger.get("open-old"))?.payload.items).toEqual([1, 2, 3]);
    expect((await ledger.get("done-new"))?.payload.items).toEqual([1, 2, 3]);
    expect(await open().create(record("done-old"))).toBe(false);
    expect(
      await ledger.compact({
        updatedBefore: cutoff,
        limit: 10,
        select: () => true,
        rewrite: (r) => r,
      }),
    ).toMatchObject({ changed: 0 });
  });

  test("compact may not change a record's identity or version", async () => {
    const { ledger, cutoff } = await seeded();
    expect(
      (
        await refusal(
          ledger.compact({
            updatedBefore: cutoff,
            limit: 1,
            select: () => true,
            rewrite: (r) => ({ ...r, version: 5 }),
          }),
        )
      ).code,
    ).toBe("corrupt");
  });

  test("purge deletes only selected old records; their identities can then be created again", async () => {
    const { ledger, cutoff } = await seeded();
    expect(
      await ledger.purge({
        updatedBefore: cutoff,
        limit: 10,
        select: (r) => r.state === "succeeded",
      }),
    ).toEqual({ changed: 1, scanned: 2, unreadable: 0 });
    expect(await ledger.get("done-old")).toBeNull();
    expect((await ledger.get("open-old"))?.state).toBe("reserved");
    expect(await ledger.create(record("done-old"))).toBe(true);
  });

  test("retention honours its limit, never touches unreadable rows or other namespaces", async () => {
    const { db, ledger, cutoff, open } = await seeded();
    await open("other/ns").create(record("foreign-old", 1, "succeeded"));
    db.prepare(
      "UPDATE ops SET updated_at = '2026-01-01T00:00:00.000Z' WHERE operation_id = 'foreign-old'",
    ).run();
    db.prepare("UPDATE ops SET record_json = '{' WHERE operation_id = 'open-old'").run();
    expect(await ledger.purge({ updatedBefore: cutoff, limit: 10, select: () => true })).toEqual({
      changed: 1,
      scanned: 2,
      unreadable: 1,
    });
    expect(
      db
        .prepare("SELECT count(*) AS n FROM ops WHERE operation_id IN ('open-old', 'foreign-old')")
        .get(),
    ).toEqual({ n: 2 });
  });

  test("inspect counts this namespace only and changes nothing", async () => {
    const { ledger, open } = await seeded();
    await open("other/ns").create(record("x"));
    expect(await ledger.inspect({ classify: (r) => r.state })).toEqual({
      operations: 3,
      classes: { succeeded: 2, reserved: 1 },
      unreadable: 0,
    });
  });
});
