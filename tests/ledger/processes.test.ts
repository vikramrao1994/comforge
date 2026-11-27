import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFileLedger } from "../../packages/ledger/src/file.ts";
import { createSQLiteLedger, ledgerTableStatements, statementDriver } from "../../packages/ledger/src/sqlite.ts";

// independent OS processes contending for
// one operation through the file and SQLite adapters: writers, history compactors, readers and
// a stalled writer at once, and SIGKILL mid-write and mid-compaction. The pass condition is the
// ledger's whole contract: exactly one creator, every successful replace a distinct version,
// versions contiguous, the current record never a stub, nothing missing or going backwards.
//
// Runtimes: `node` and `bun` from PATH; LEDGER_TEST_RUNTIMES (comma-separated executables, for
// example several Node binaries) replaces that list, and "mixed" then runs all of them at once.

const WORKER = path.join(import.meta.dir, "fixtures", "ledgerWorker.ts");
const RUNTIMES = (process.env.LEDGER_TEST_RUNTIMES ?? "node,bun").split(",").filter(Boolean);
const ID = "contended-op";
const work: string[] = [];
afterEach(() => {
  for (const dir of work.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type Out = Record<string, number | string | boolean>;
type Rec = { operationId: string; version: number; pad?: string };

function target(adapter: "file" | "sqlite"): string {
  const dir = mkdtempSync(path.join(tmpdir(), `ledger-procs-${adapter}-`));
  work.push(dir);
  if (adapter === "file") return dir;
  const file = path.join(dir, "ledger.db");
  const db = new Database(file);
  db.prepare("PRAGMA journal_mode = WAL").get();
  for (const sql of ledgerTableStatements({})) db.prepare(sql).run();
  db.close();
  return file;
}

function start(runtime: string, args: string[], env: Record<string, string> = {}) {
  const child = spawn(runtime, [WORKER, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...env },
  });
  let out = "";
  let err = "";
  const waiting: ((line: Out) => void)[] = [];
  child.stdout.on("data", (d) => {
    out += d;
    if (out.includes("\n")) for (const resolve of waiting.splice(0)) resolve(JSON.parse(out.split("\n")[0] as string));
  });
  child.stderr.on("data", (d) => {
    err += d;
  });
  const done = new Promise<{ code: number | null; out: Out | null; err: string }>((resolve) =>
    child.on("exit", (code) => {
      const last = out.trim().split("\n").filter(Boolean).at(-1);
      resolve({ code, out: last ? (JSON.parse(last) as Out) : null, err });
    }),
  );
  const firstLine = () => new Promise<Out>((resolve) => (out.includes("\n") ? resolve(JSON.parse(out.split("\n")[0] as string)) : waiting.push(resolve)));
  return { child, done, firstLine };
}

/** stderr without Node's notice that node:sqlite is experimental (Node 22 and 24). */
const quiet = (err: string) =>
  err
    .split("\n")
    .filter((l) => l.trim() && !/ExperimentalWarning|--trace-warnings/.test(l))
    .join("\n");

const fileLedger = (dir: string) => createFileLedger<Rec>({ directory: dir, namespace: "contended" });
const sqliteLedger = (file: string) => createSQLiteLedger<Rec>({ driver: statementDriver(new Database(file)), namespace: "contended" });
const ledgerOf = (adapter: "file" | "sqlite", t: string) => (adapter === "file" ? fileLedger(t) : sqliteLedger(t));
const record = (version: number): Rec => ({ operationId: ID, version, pad: "x".repeat(4096) });
const kind = (runtime: string) => (path.basename(runtime).startsWith("bun") ? "bun" : "node");
const mixes = [...RUNTIMES.map((r) => [r]), ...(RUNTIMES.length > 1 ? [RUNTIMES] : [])];
const label = (mix: string[]) => (mix.length > 1 ? `mixed (${mix.join(" + ")})` : (mix[0] as string));

async function settle(runs: ReturnType<typeof start>[]) {
  const results = await Promise.all(runs.map((r) => r.done));
  for (const r of results) expect({ code: r.code, err: quiet(r.err) }).toEqual({ code: 0, err: "" });
  return results.map((r) => r.out as Out);
}
const sum = (outs: Out[], key: string) => outs.reduce((a, o) => a + Number(o[key] ?? 0), 0);

/** File ledger on disk: versions 1..n contiguous; every one below n a stub or its own record. */
function fileHistory(dir: string) {
  const op = path.join(dir, "contended", readdirSync(path.join(dir, "contended"))[0] as string);
  const names = readdirSync(op);
  const versions = names
    .filter((f) => /^\d+\.json$/.test(f))
    .map((f) => Number(f.slice(0, -5)))
    .sort((a, b) => a - b);
  const contents = versions.map((v) => JSON.parse(readFileSync(path.join(op, `${v}.json`), "utf8")) as Record<string, unknown>);
  const last = contents.at(-1);
  return {
    versions,
    contiguous: versions.every((v, i) => v === i + 1),
    stubs: contents.filter((c) => c.ledger === "comforge-ledger/superseded").length,
    consistent: contents.every((c, i) => c.version === versions[i] && c.operationId === ID),
    currentIsRecord: typeof last?.pad === "string" && last?.ledger === undefined,
    temps: names.filter((f) => f.endsWith(".tmp")).length,
  };
}

describe.each(["file", "sqlite"] as const)("%s ledger across independent processes", (adapter) => {
  test.each(mixes.map((m) => [label(m), m] as const))(
    "%s writers: one creator, one winner per version, nothing lost",
    async (_name, mix) => {
      const t = target(adapter);
      const outs = await settle(Array.from({ length: 6 }, (_, i) => start(mix[i % mix.length] as string, [adapter, t, "60"])));
      expect(new Set(outs.map((o) => String(o.runtime).split(" ")[0]))).toEqual(new Set(mix.map(kind)));
      expect(sum(outs, "created")).toBe(1);
      expect(sum(outs, "errors")).toBe(0);
      expect((await ledgerOf(adapter, t).get(ID))?.version).toBe(1 + sum(outs, "replaced"));
      if (adapter === "file") expect(fileHistory(t)).toMatchObject({ contiguous: true, consistent: true, temps: 0, stubs: 0 });
    },
    180_000,
  );

  test(`writers, compactors and readers at once (${RUNTIMES.join(" + ")}): nothing missing, backwards or lost`, async () => {
    const t = target(adapter);
    await ledgerOf(adapter, t).create(record(1));
    const rt = (i: number) => RUNTIMES[i % RUNTIMES.length] as string;
    const writers = Array.from({ length: 4 }, (_, i) => start(rt(i), [adapter, t, "60", "write"]));
    const compactors = Array.from({ length: 2 }, (_, i) => start(rt(i + 1), [adapter, t, "150", "compact"]));
    const readers = Array.from({ length: 2 }, (_, i) => start(rt(i), [adapter, t, "300", "read"]));
    const [w, c, r] = await Promise.all([settle(writers), settle(compactors), settle(readers)]);
    expect(sum(w, "errors")).toBe(0);
    expect(sum(c, "errors")).toBe(0);
    expect({ missing: sum(r, "missing"), backwards: sum(r, "backwards"), errors: sum(r, "errors") }).toEqual({
      missing: 0,
      backwards: 0,
      errors: 0,
    });
    expect(sum(r, "reads")).toBe(600);
    const current = await ledgerOf(adapter, t).get(ID);
    expect(current?.version).toBe(1 + sum(w, "replaced"));
    if (adapter === "file") {
      const history = fileHistory(t);
      expect(history).toMatchObject({ contiguous: true, consistent: true, currentIsRecord: true });
      expect(sum(c, "rewritten")).toBeGreaterThan(0);
      await fileLedger(t).compactHistory(ID);
      expect(fileHistory(t).stubs).toBe(history.versions.length - 1);
    }
  }, 180_000);

  test("a stalled writer in another process loses after others advanced and compacted", async () => {
    const t = target(adapter);
    const ledger = ledgerOf(adapter, t);
    await ledger.create(record(1));
    // A flag in this test's own directory: a shared path would release a later run's worker early.
    const flagDir = mkdtempSync(path.join(tmpdir(), "ledger-stall-"));
    work.push(flagDir);
    const flag = path.join(flagDir, "go");
    const stalled = start(RUNTIMES.at(-1) as string, [adapter, t, "0", "stalled"], { STALL_FLAG: flag });
    expect(await stalled.firstLine()).toEqual({ seen: 1 });
    for (let v = 1; v < 4; v++) expect(await ledger.replace(ID, v, record(v + 1))).toBe(true);
    if (adapter === "file") expect(await fileLedger(t).compactHistory(ID)).toBe(3);
    else
      await sqliteLedger(t).compact({
        updatedBefore: new Date(Date.now() + 60_000),
        limit: 5,
        select: () => true,
        rewrite: (r) => ({ ...r, pad: "" }),
      });
    writeFileSync(flag, "");
    const [out] = await settle([stalled]);
    expect(out).toMatchObject({ seen: 1, won: false });
    expect((await ledger.get(ID))?.version).toBe(4);
    if (adapter === "file") expect(fileHistory(t)).toMatchObject({ versions: [1, 2, 3, 4], stubs: 3, currentIsRecord: true });
  }, 60_000);

  test(`SIGKILL of writers and compactors mid-write (${RUNTIMES.join(" + ")}): readable, writable, orphans swept`, async () => {
    const t = target(adapter);
    for (let round = 0; round < 3; round++) {
      const runs = [
        ...RUNTIMES.flatMap((rt) => [start(rt, [adapter, t, "0", "forever"]), start(rt, [adapter, t, "0", "forever"])]),
        ...RUNTIMES.map((rt) => start(rt, [adapter, t, "100000", "compact"])),
      ];
      await new Promise((r) => setTimeout(r, 600 + round * 150));
      for (const r of runs) r.child.kill("SIGKILL");
      await Promise.all(runs.map((r) => r.done));
    }
    const ledger = ledgerOf(adapter, t);
    const current = await ledger.get(ID);
    expect(current?.version).toBeGreaterThan(1);
    expect(await ledger.replace(ID, current?.version as number, record((current?.version as number) + 1))).toBe(true);
    if (adapter === "file") {
      const fl = fileLedger(t);
      await fl.sweepOrphans({ olderThanMs: 0 });
      const report = await fl.inspect();
      expect({ orphans: report.orphanTempFiles, unreadable: report.unreadable }).toEqual({ orphans: 0, unreadable: [] });
      expect(fileHistory(t)).toMatchObject({ contiguous: true, consistent: true, currentIsRecord: true });
    } else {
      expect(new Database(t).prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    }
  }, 120_000);
});
