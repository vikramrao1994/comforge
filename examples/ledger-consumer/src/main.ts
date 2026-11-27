import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { createMemoryLedger, type Ledger, LedgerError, type LedgerRecord } from "@comforge/ledger";
import { type ConformanceRecord, ledgerConformance } from "@comforge/ledger/conformance";
import { createFileLedger } from "@comforge/ledger/file";
import {
  createSQLiteLedger,
  ledgerTableStatements,
  type PreparedDatabase,
  statementDriver,
} from "@comforge/ledger/sqlite";

// node:sqlite (Node 22.13+, Bun) loaded by name: @types/node 20 does not declare it.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: new (location: string) => PreparedDatabase;
};

export type Check = { id: string; pass: boolean };

const checks: Check[] = [];
const dir = mkdtempSync(path.join(tmpdir(), "acme-ledger-"));

async function check(id: string, run: () => Promise<boolean | void>) {
  try {
    checks.push({ id, pass: (await run()) !== false });
  } catch {
    checks.push({ id, pass: false });
  }
}

// One SQLite database per conformance case: an operation id is global within one table.
const databases = new Map<string, PreparedDatabase>();
const databaseOf = (ns: string) => {
  const key = ns.replace(/-[ab](\d+)$/, "$1");
  let db = databases.get(key);
  if (!db) {
    db = new DatabaseSync(":memory:");
    for (const sql of ledgerTableStatements({ columns: { state: "TEXT" } })) db.prepare(sql).run();
    databases.set(key, db);
  }
  return db;
};
const memories = new Map<string, Ledger<ConformanceRecord>>();

const adapters: Record<string, (ns: string) => Ledger<ConformanceRecord>> = {
  memory: (ns) => {
    if (!memories.has(ns)) memories.set(ns, createMemoryLedger<ConformanceRecord>());
    return memories.get(ns) as Ledger<ConformanceRecord>;
  },
  file: (ns) => createFileLedger<ConformanceRecord>({ directory: path.join(dir, "file"), namespace: ns }),
  sqlite: (ns) =>
    createSQLiteLedger<ConformanceRecord>({
      driver: statementDriver(databaseOf(ns)),
      namespace: ns,
      columns: (r) => ({ state: r.state }),
    }),
};

for (const [name, open] of Object.entries(adapters))
  for (const c of ledgerConformance(open, {
    namespaces: (() => {
      let n = 0;
      return () => {
        n += 1;
        return [`${name}-a${n}`, `${name}-b${n}`];
      };
    })(),
  }))
    await check(`${name}: ${c.name}`, () => c.run());

// A consumer's own record type, validated on every write and read.
interface Job extends LedgerRecord {
  state: "queued" | "done";
  body: string;
}
const jobs = createFileLedger<Job>({
  directory: path.join(dir, "jobs"),
  namespace: "acme-jobs",
  validate: (r) => {
    if (r.state !== "queued" && r.state !== "done") throw new Error("unknown state");
  },
});

await check("validator refuses an unknown state as invalid-record", async () => {
  try {
    await jobs.create({ operationId: "j0", version: 1, state: "lost" as Job["state"], body: "" });
    return false;
  } catch (error) {
    return error instanceof LedgerError && error.code === "invalid-record";
  }
});
await check("a job moves queued -> done under compare-and-swap", async () => {
  await jobs.create({ operationId: "j1", version: 1, state: "queued", body: "payload" });
  const won = await jobs.replace("j1", 1, { operationId: "j1", version: 2, state: "done", body: "payload" });
  const lost = await jobs.replace("j1", 1, { operationId: "j1", version: 2, state: "done", body: "other" });
  return won && !lost && (await jobs.get("j1"))?.state === "done";
});
await check("history compaction removes superseded bodies, keeps the record", async () => {
  const rewritten = await jobs.compactHistory("j1");
  return rewritten === 1 && (await jobs.get("j1"))?.body === "payload";
});
await check("inspection classifies records and reports no orphans", async () => {
  const report = await jobs.inspect({ classify: (r) => r.state });
  return report.classes.done === 1 && report.orphanTempFiles === 0 && report.unreadable.length === 0;
});
await check("orphan sweep on a clean ledger removes nothing", async () => {
  const swept = await jobs.sweepOrphans();
  return swept.removed === 0;
});
await check("probe confirms hard links on this filesystem", async () => {
  await jobs.probe();
});

rmSync(dir, { recursive: true, force: true });
const failed = checks.filter((c) => !c.pass).map((c) => c.id);
const runtime =
  typeof (globalThis as { Bun?: { version: string } }).Bun !== "undefined"
    ? `bun ${(globalThis as unknown as { Bun: { version: string } }).Bun.version}`
    : `node ${process.versions.node}`;
process.stdout.write(`${JSON.stringify({ runtime, checks, failed })}\n`);
process.exitCode = failed.length === 0 ? 0 : 1;
