import { Database } from "bun:sqlite";
import { afterAll, describe, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { type ConformanceRecord, ledgerConformance } from "../src/conformance.ts";
import { createFileLedger } from "../src/file.ts";
import { createMemoryLedger } from "../src/index.ts";
import {
  createSQLiteLedger,
  ledgerTableStatements,
  type PreparedDatabase,
  statementDriver,
} from "../src/sqlite.ts";

// node:sqlite loaded by name: the repository's @types/node (20) does not declare it.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: new (location: string) => PreparedDatabase;
};

// Every adapter against the same shared cases.

const dir = mkdtempSync(path.join(tmpdir(), "ledger-conformance-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const memories = new Map<string, ReturnType<typeof createMemoryLedger<ConformanceRecord>>>();
// One database per case (the shared cases reuse operation ids, and in one SQLite table an id
// is global), shared by that case's two namespaces as a consumer's one database would be.
const databases = new Map<string, { bun: Database; node: PreparedDatabase }>();
const databaseOf = (ns: string) => {
  const key = ns.replace(/^conformance-[ab]/, "");
  if (!databases.has(key)) {
    const pair = { bun: new Database(":memory:"), node: new DatabaseSync(":memory:") };
    for (const db of [pair.bun, pair.node])
      for (const sql of ledgerTableStatements({ columns: { state: "TEXT" } }))
        db.prepare(sql).run();
    databases.set(key, pair);
  }
  return databases.get(key) as { bun: Database; node: PreparedDatabase };
};

const adapters = {
  memory: (ns: string) => {
    // A memory ledger has no shared storage; one per namespace is the equivalent.
    if (!memories.has(ns)) memories.set(ns, createMemoryLedger<ConformanceRecord>());
    return memories.get(ns) as ReturnType<typeof createMemoryLedger<ConformanceRecord>>;
  },
  file: (ns: string) => createFileLedger<ConformanceRecord>({ directory: dir, namespace: ns }),
  "sqlite (bun:sqlite)": (ns: string) =>
    createSQLiteLedger<ConformanceRecord>({
      driver: statementDriver(databaseOf(ns).bun),
      namespace: ns,
      columns: (r) => ({ state: r.state }),
    }),
  "sqlite (node:sqlite)": (ns: string) =>
    createSQLiteLedger<ConformanceRecord>({
      driver: statementDriver(databaseOf(ns).node),
      namespace: ns,
      columns: (r) => ({ state: r.state }),
    }),
};

for (const [name, open] of Object.entries(adapters))
  describe(`${name} ledger conformance`, () => {
    for (const c of ledgerConformance(open)) test(c.name, () => c.run());
  });
