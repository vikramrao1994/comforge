// One independent process for processes.test.ts, run under any Node or Bun. Modes:
// - write (default): create the contended operation (one process wins), then keep replacing it
//   from the version it last read; `forever` does so until killed.
// - compact: keep compacting the operation (file: compactHistory; SQLite: compact every row).
// - read: keep reading it; counts any read that is missing, goes backwards or fails.
// - stalled: read the version once, print it, wait for STALL_FLAG to exist, then try to
//   replace from that version and print whether it won.
// Prints one JSON line with its counts (not in `forever`).
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { createFileLedger } from "../../../packages/ledger/src/file.ts";
import { createSQLiteLedger, type PreparedDatabase, statementDriver } from "../../../packages/ledger/src/sqlite.ts";

type Rec = { operationId: string; version: number; writer: number; pad: string };
const [adapter, target, roundsArg, mode = "write"] = process.argv.slice(2) as [string, string, string, string?];
const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
const runtime = isBun ? `bun ${(globalThis as unknown as { Bun: { version: string } }).Bun.version}` : `node ${process.versions.node}`;

async function open() {
  if (adapter === "file") return { file: createFileLedger<Rec>({ directory: target, namespace: "contended" }) };
  // node:sqlite loaded by name: the repository's @types/node (20) does not declare it.
  const db: PreparedDatabase = isBun
    ? new (await import("bun:sqlite")).Database(target)
    : new (createRequire(import.meta.url)("node:sqlite") as { DatabaseSync: new (f: string) => PreparedDatabase }).DatabaseSync(target);
  db.prepare("PRAGMA busy_timeout = 10000").get();
  return { sqlite: createSQLiteLedger<Rec>({ driver: statementDriver(db), namespace: "contended" }) };
}

const opened = await open();
const ledger = (opened.file ?? opened.sqlite) as NonNullable<typeof opened.file | typeof opened.sqlite>;
const id = "contended-op";
// A few KB per version, so a kill can land mid-write.
const rec = (version: number): Rec => ({ operationId: id, version, writer: process.pid, pad: "x".repeat(4096) });
const rounds = Number(roundsArg);
const out: Record<string, unknown> = { runtime, mode };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

if (mode === "write" || mode === "forever") {
  let created = 0,
    replaced = 0,
    lost = 0,
    errors = 0;
  if (await ledger.create(rec(1))) created += 1;
  for (let i = 0; mode === "forever" || i < rounds; i++) {
    try {
      const current = await ledger.get(id);
      if (!current) continue;
      if (await ledger.replace(id, current.version, rec(current.version + 1))) replaced += 1;
      else lost += 1;
    } catch {
      errors += 1;
    }
  }
  Object.assign(out, { created, replaced, lost, errors });
} else if (mode === "compact") {
  let rewritten = 0,
    errors = 0;
  for (let i = 0; i < rounds; i++) {
    try {
      if (opened.file) rewritten += await opened.file.compactHistory(id);
      else
        rewritten += (
          await (opened.sqlite as NonNullable<typeof opened.sqlite>).compact({
            updatedBefore: new Date(Date.now() + 60_000),
            limit: 10,
            select: (r) => r.pad.length > 0,
            rewrite: (r) => ({ ...r, pad: "" }),
          })
        ).changed;
    } catch {
      errors += 1;
    }
  }
  Object.assign(out, { rewritten, errors });
} else if (mode === "read") {
  let reads = 0,
    missing = 0,
    backwards = 0,
    errors = 0,
    last = 0;
  for (let i = 0; i < rounds; i++) {
    try {
      const current = await ledger.get(id);
      reads += 1;
      if (!current) missing += 1;
      else {
        if (current.version < last) backwards += 1;
        last = current.version;
      }
    } catch {
      errors += 1;
    }
  }
  Object.assign(out, { reads, missing, backwards, errors });
} else if (mode === "stalled") {
  const seen = (await ledger.get(id))?.version ?? 0;
  process.stdout.write(`${JSON.stringify({ seen })}\n`);
  const flag = process.env.STALL_FLAG ?? "";
  while (!existsSync(flag)) await sleep(20);
  out.won = await ledger.replace(id, seen, rec(seen + 1));
  out.seen = seen;
}
process.stdout.write(`${JSON.stringify(out)}\n`);
