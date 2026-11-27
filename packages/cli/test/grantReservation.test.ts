import { afterAll, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openState } from "../src/state.ts";

// Review M14: grant attempts are spent atomically across independent processes (Bun and Node,
// mixed), never more than maxAttempts between them, and an attempt spent by a process that then
// dies stays spent across a restart.

const work = mkdtempSync(path.join(tmpdir(), "grant-reservation-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));
const FIXTURE = path.join(import.meta.dir, "fixtures", "reserveGrant.ts");
const state = openState(work);
let seq = 0;

async function initiative() {
  const id = `RACE-${++seq}`;
  await state.create(
    {
      ticket: id,
      phase: null,
      branch: `agent/${id.toLowerCase()}`,
      checkout: "/nowhere",
      primary: work,
      base: { remote: "origin", branch: "main", sha: "b".repeat(40) },
      trustedConfig: "c".repeat(64),
      specification: { issueNumber: 1, digest: "e".repeat(64) },
      validations: [],
      revisions: [],
      publications: [],
      completions: [],
      operations: [],
      cleanedAt: null,
    },
    id,
  );
  return id;
}

function racer(runtime: string, env: Record<string, string>) {
  const child = spawn(runtime, [FIXTURE], {
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      COMMON_DIR: work,
      ...env,
    } as unknown as NodeJS.ProcessEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  child.stdout.on("data", (d) => {
    out += d;
  });
  child.stderr.on("data", (d) => {
    err += d;
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
  const done = new Promise<{
    ok: boolean;
    code?: string;
    attempt?: number;
    err: string;
    exit: number | null;
  }>((resolve) =>
    child.on("exit", (exit) => {
      clearTimeout(timer);
      resolve({
        ...(out.trim()
          ? JSON.parse(out.trim().split("\n")[0] as string)
          : { ok: false, code: "killed" }),
        err,
        exit,
      });
    }),
  );
  return { child, done, output: () => out };
}

const RUNTIMES = ["bun", "node"];

test.each([
  1, 3,
])("eight racers (bun and node mixed) on one grant with maxAttempts=%i: exactly that many succeed", async (max) => {
  const id = await initiative();
  const go = path.join(work, `go-${id}`);
  const racers = Array.from({ length: 8 }, (_, i) =>
    racer(RUNTIMES[i % 2] as string, {
      INITIATIVE: id,
      GRANT_ID: `grant-${id}`,
      MAX_ATTEMPTS: String(max),
      WAIT_FILE: go,
    }),
  );
  writeFileSync(go, "");
  const results = await Promise.all(racers.map((r) => r.done));
  expect(results.filter((r) => r.code === "unexpected" || r.code === "killed")).toEqual([]);
  expect(results.filter((r) => r.ok)).toHaveLength(max);
  expect(results.filter((r) => !r.ok).every((r) => r.code === "unauthorized")).toBe(true);
  expect((await state.get(id))?.grantUses?.length).toBe(max);
  expect(new Set(results.filter((r) => r.ok).map((r) => r.attempt))).toEqual(
    new Set(Array.from({ length: max }, (_, i) => i + 1)),
  );
}, 60_000);

test("a process killed after spending keeps the attempt spent; a restart cannot reuse it", async () => {
  const id = await initiative();
  const holder = racer("bun", { INITIATIVE: id, GRANT_ID: "g-hold", MAX_ATTEMPTS: "1", HOLD: "1" });
  while (!holder.output().includes('"ok":true')) await new Promise((r) => setTimeout(r, 10));
  holder.child.kill("SIGKILL");
  await holder.done;
  const again = await racer("node", { INITIATIVE: id, GRANT_ID: "g-hold", MAX_ATTEMPTS: "1" }).done;
  expect([again.ok, again.code]).toEqual([false, "unauthorized"]);
  // Another grant is counted on its own.
  expect(
    (await racer("bun", { INITIATIVE: id, GRANT_ID: "g-other", MAX_ATTEMPTS: "1" }).done).ok,
  ).toBe(true);
}, 60_000);

test("a process killed before spending spends nothing", async () => {
  const id = await initiative();
  const never = path.join(work, `never-${id}`);
  const waiting = racer("bun", {
    INITIATIVE: id,
    GRANT_ID: "g-wait",
    MAX_ATTEMPTS: "1",
    WAIT_FILE: never,
  });
  await new Promise((r) => setTimeout(r, 200));
  waiting.child.kill("SIGKILL");
  expect((await waiting.done).code).toBe("killed");
  expect((await state.get(id))?.grantUses ?? []).toEqual([]);
  expect(
    (await racer("node", { INITIATIVE: id, GRANT_ID: "g-wait", MAX_ATTEMPTS: "1" }).done).ok,
  ).toBe(true);
}, 60_000);
