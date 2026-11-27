import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import { createGitHubWriter } from "@comforge/github";
import { createFileLedger } from "@comforge/ledger/file";
import { requireResolved } from "../src/commands/delivery.ts";
import { migrate } from "../src/commands/migrate.ts";
import { loadInitiative, openContext } from "../src/context.ts";
import { CliError } from "../src/errors.ts";
import { baseConfig, createWorld, TOKEN, type World } from "./harness.ts";

// R1: importing an earlier lifecycle's state without losing a record, an identity or the
// exclusive ownership of an initiative. Synthetic legacy records in the exact earlier format.

let world: World;
afterEach(() => world?.dispose());

const SHA = (c: string) => c.repeat(40);
const migratingConfig = (extra: Record<string, unknown> = {}) =>
  baseConfig({
    state: {
      writeLedgerDirectory: "agent-lifecycle",
      legacy: { directory: "agent-lifecycle", format: "agent-lifecycle/v1" },
    },
    ...extra,
  });

function legacyRecord(ticket: string, fields: Record<string, unknown> = {}) {
  const [t, phase] = ticket.split(".");
  return {
    schemaVersion: 1,
    ticket,
    branch: `agent/${(t as string).toLowerCase()}${phase ? `.${phase}` : ""}`,
    baseSha: SHA("a"),
    specification: { issueNumber: 7, digest: "d".repeat(64), digestVerified: true },
    checkout: `/tmp/legacy/${ticket.toLowerCase()}`,
    createdAt: "2026-11-01T10:00:00.000Z",
    validations: [
      {
        commit: SHA("b"),
        tree: SHA("c"),
        status: "PASS",
        command: "bun run test:verify",
        startedAt: "2026-11-01T11:00:00.000Z",
        durationMs: 1000,
        provisioning: ["bun install --frozen-lockfile"],
        summary: { status: "PASS" },
      },
    ],
    publications: [
      { commit: SHA("b"), prNumber: 12, action: "created", at: "2026-11-01T12:00:00.000Z" },
    ],
    cleanup: null,
    deliveryPolicy: "automatic",
    completions: [],
    deliveries: [
      {
        commit: SHA("b"),
        prNumber: 12,
        issueNumber: 7,
        outcome: "completed",
        state: "complete",
        failedStage: null,
        commentId: 99,
        detail: null,
        at: "2026-11-01T12:05:00.000Z",
      },
    ],
    ...fields,
  };
}

function legacyDir(w: World) {
  const dir = path.join(w.primary, ".git", "agent-lifecycle");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeLegacy(w: World, record: Record<string, unknown>) {
  const file = path.join(legacyDir(w), `${record.ticket as string}.json`);
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
  return file;
}

async function legacyWrite(
  w: World,
  id: string,
  state: string,
  target: Record<string, unknown>,
  kind = "pull.update",
) {
  const ledger = createFileLedger({ directory: legacyDir(w), namespace: "writes" });
  const ok = await ledger.create({
    schema: "comforge-github-operation/v1",
    operationId: id,
    version: 1,
    repository: "acme/widgets",
    kind,
    capability: kind === "issue.comment" ? "issues:comment" : "pulls:update",
    fingerprint: `sha256:${"0".repeat(64)}`,
    descriptor: { schema: "comforge-github-write/v1", operationId: id, kind, target, payload: {} },
    state,
    leaseUntil: null,
    attempts: 1,
    firstSentAt: 1,
    changedAt: 1,
    authorizationReference: null,
    marker: null,
    outcome: null,
    failure: null,
    note: null,
  } as never);
  expect(ok).toBe(true);
}

const sha = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

describe("R1: comforge migrate", () => {
  test("a dry run plans the import and changes nothing", async () => {
    world = createWorld({ config: migratingConfig() });
    const file = writeLegacy(world, legacyRecord("DEMO-001"));
    const before = sha(file);
    const r = await world.cli(["migrate"]);
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({
      executed: false,
      records: 1,
      plan: [{ id: "DEMO-001", action: "import" }],
    });
    expect(existsSync(path.join(legacyDir(world), ".migrated"))).toBe(false);
    expect((await world.cli(["status"])).json.initiatives).toEqual([]);
    expect(sha(file)).toBe(before);
  });

  test("before migrating, start refuses a legacy ticket instead of opening a second initiative", async () => {
    world = createWorld({ config: migratingConfig() });
    writeLegacy(world, legacyRecord("DEMO-001"));
    const issue = world.specIssue("DEMO-001");
    const r = await world.cli(["start", "DEMO-001", "--issue", String(issue)]);
    expect(r.code).toBe(1);
    expect(r.json).toMatchObject({ error: "conflict" });
    expect(r.json.message).toContain("comforge migrate");
  });

  test("--execute imports every record exactly, backs it up, and locks the earlier lifecycle out", async () => {
    world = createWorld({ config: migratingConfig() });
    const file = writeLegacy(world, legacyRecord("DEMO-001"));
    writeLegacy(world, legacyRecord("DEMO-001.b", { publications: [], deliveries: [] }));
    const before = sha(file);
    const r = await world.cli(["migrate", "--execute"]);
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ executed: true, state: "cut-over", records: 2 });
    expect(existsSync(path.join(legacyDir(world), ".migrated"))).toBe(true);
    expect(sha(file)).toBe(before);
    expect(sha(path.join(r.json.backup, "DEMO-001.json"))).toBe(before);

    const s = await world.cli(["status", "DEMO-001"]);
    expect(s.json).toMatchObject({
      initiative: "DEMO-001",
      stage: "published",
      branch: "agent/demo-001",
      specification: { issueNumber: 7, digest: "d".repeat(64) },
      lastPublication: { prNumber: 12, url: "https://github.com/acme/widgets/pull/12" },
      lastValidation: { status: "PASS", snapshot: true, commit: SHA("b") },
    });
    const phase = await world.cli(["status", "DEMO-001.b"]);
    expect(phase.json).toMatchObject({ initiative: "DEMO-001.b", stage: "verified" });

    // Rerunning after the cutover is a no-op; starting an imported ticket is "already started".
    expect((await world.cli(["migrate", "--execute"])).json).toMatchObject({
      state: "cut-over",
      executed: false,
    });
    const again = await world.cli([
      "start",
      "DEMO-001",
      "--issue",
      String(world.specIssue("DEMO-001")),
    ]);
    expect(again.json).toMatchObject({ error: "conflict" });
    expect(again.json.message).toContain("already started");
  });

  test("interrupted at every stage, a rerun resumes without duplicating or losing a record", async () => {
    // Checkpoints: before the sentinel, after quiescence, after the backup, before each of the
    // three records, before the cutover.
    for (let stop = 1; stop <= 7; stop++) {
      world = createWorld({ config: migratingConfig() });
      for (const t of ["DEMO-001", "DEMO-002", "DEMO-003"]) writeLegacy(world, legacyRecord(t));
      let checks = 0;
      const signal = {
        get aborted() {
          return ++checks >= stop;
        },
        reason: `interrupted at checkpoint ${stop}`,
      } as unknown as AbortSignal;
      await expect(
        migrate(openContext(world.rt(), { signal }), { execute: true }),
      ).rejects.toMatchObject({
        code: "cancelled",
      });
      // Once the sentinel exists the earlier lifecycle stays locked out while incomplete.
      expect(existsSync(path.join(legacyDir(world), ".migrated"))).toBe(stop >= 2);
      const r = await world.cli(["migrate", "--execute"]);
      expect([stop, r.json.state]).toEqual([stop, "cut-over"]);
      const ids = (await world.cli(["status"])).json.initiatives.map(
        (i: { initiative: string }) => i.initiative,
      );
      expect([stop, ids]).toEqual([stop, ["DEMO-001", "DEMO-002", "DEMO-003"]]);
      world.dispose();
    }
    world = createWorld();
  }, 120_000);

  test("the writer fence: live or foreign writers fail closed, dead ones are reported", async () => {
    world = createWorld({ config: migratingConfig() });
    writeLegacy(world, legacyRecord("DEMO-001"));
    const writers = path.join(legacyDir(world), ".writers");
    mkdirSync(writers, { recursive: true });
    const sleeper = spawn("sleep", ["30"]);
    try {
      writeFileSync(
        path.join(writers, "live.json"),
        JSON.stringify({ pid: sleeper.pid, host: hostname(), label: "publish" }),
      );
      const r = await world.cli(["migrate", "--execute", "--wait", "1"]);
      expect([r.code, r.json.error]).toEqual([1, "conflict"]);
      expect(r.json.detail.live).toEqual([
        { pid: sleeper.pid, host: hostname(), label: "publish" },
      ]);
      // Nothing imported, and the sentinel this run wrote is withdrawn: the earlier lifecycle keeps working.
      expect(existsSync(path.join(legacyDir(world), ".migrated"))).toBe(false);
      expect((await world.cli(["status"])).json.initiatives).toEqual([]);
    } finally {
      sleeper.kill();
    }
    rmSync(path.join(writers, "live.json"));
    writeFileSync(
      path.join(writers, "remote.json"),
      JSON.stringify({ pid: 1, host: "another-host", label: "x" }),
    );
    expect((await world.cli(["migrate", "--execute", "--wait", "1"])).json.error).toBe("conflict");
    rmSync(path.join(writers, "remote.json"));
    writeFileSync(
      path.join(writers, "dead.json"),
      JSON.stringify({ pid: 999_999, host: hostname(), label: "x" }),
    );
    const done = await world.cli(["migrate", "--execute", "--wait", "1"]);
    expect(done.json).toMatchObject({ state: "cut-over", staleWriters: 1 });
  }, 60_000);

  test("concurrent migrations leave each record imported once", async () => {
    world = createWorld({ config: migratingConfig() });
    for (const t of ["DEMO-001", "DEMO-002"]) writeLegacy(world, legacyRecord(t));
    const runs = await Promise.allSettled([
      migrate(openContext(world.rt()), { execute: true }),
      migrate(openContext(world.rt()), { execute: true }),
    ]);
    expect(runs.some((r) => r.status === "fulfilled")).toBe(true);
    for (const r of runs) if (r.status === "rejected") expect(r.reason).toBeInstanceOf(CliError);
    const final = await world.cli(["migrate", "--execute"]);
    expect(final.json.state).toBe("cut-over");
    expect((await world.cli(["status"])).json.initiatives).toHaveLength(2);
  });

  test("refuses records it cannot map exactly: unknown fields, unknown schema, foreign state, unverified specs", async () => {
    world = createWorld({ config: migratingConfig() });
    writeLegacy(world, legacyRecord("DEMO-001", { surprise: true }));
    let r = await world.cli(["migrate"]);
    expect(r.json).toMatchObject({ error: "conflict" });
    expect(r.json.message).toContain("agent-lifecycle/v1");

    writeLegacy(world, legacyRecord("DEMO-001", { schemaVersion: 2 }));
    expect((await world.cli(["migrate"])).json.error).toBe("conflict");

    writeLegacy(
      world,
      legacyRecord("DEMO-001", {
        specification: { issueNumber: 7, digest: "d".repeat(64), digestVerified: false },
      }),
    );
    r = await world.cli(["migrate"]);
    expect(r.json.message).toContain("unverified specification");

    writeLegacy(world, legacyRecord("DEMO-001"));
    const ctx = openContext(world.rt());
    await ctx.state.create(
      {
        ticket: "DEMO-001",
        phase: null,
        branch: "agent/demo-001",
        checkout: "/x",
        primary: world.primary,
        base: { remote: "origin", branch: "main", sha: SHA("a") },
        trustedConfig: "x",
        specification: null,
        validations: [],
        revisions: [],
        publications: [],
        completions: [],
        operations: [],
        cleanedAt: null,
      },
      "DEMO-001",
    );
    r = await world.cli(["migrate", "--execute"]);
    expect(r.json).toMatchObject({ error: "conflict" });
    expect(existsSync(path.join(legacyDir(world), ".migrated"))).toBe(false);
  });

  test("unresolved writes keep their identities: attached and guarded, or the migration refuses", async () => {
    world = createWorld({ config: migratingConfig() });
    writeLegacy(world, legacyRecord("DEMO-001"));
    await legacyWrite(world, "cli-pull-update-12-x", "indeterminate", { type: "pull", number: 12 });
    await legacyWrite(
      world,
      "cli-comment-7-x",
      "succeeded",
      { type: "issue", number: 7 },
      "issue.comment",
    );
    await legacyWrite(
      world,
      "cli-comment-404-x",
      "succeeded",
      { type: "issue", number: 404 },
      "issue.comment",
    );
    const r = await world.cli(["migrate", "--execute"]);
    expect(r.code).toBe(0);
    expect(r.json.unresolvedWrites).toEqual(["cli-pull-update-12-x"]);
    expect(r.json.unassignedFinishedWrites).toBe(1);
    const s = await world.cli(["status", "DEMO-001"]);
    expect(s.json.operations.sort()).toEqual(["cli-comment-7-x", "cli-pull-update-12-x"]);
    // recover sees the earlier write under its own identity, in the shared ledger.
    const rec = await world.cli(["recover", "DEMO-001"]);
    expect(rec.json).toMatchObject({ executed: false, unresolved: ["cli-pull-update-12-x"] });
    // And no new write is sent for the initiative until it is resolved.
    const ctx = openContext(world.rt());
    const record = await ctx.state.get("DEMO-001");
    const { trusted: config } = await loadInitiative(ctx, "DEMO-001");
    await expect(requireResolved(ctx.github(config), record, Date.now())).rejects.toMatchObject({
      code: "ambiguous",
    });

    // An unresolved write that belongs to no initiative cannot be reconciled by anyone: refused.
    world.dispose();
    world = createWorld({ config: migratingConfig() });
    writeLegacy(world, legacyRecord("DEMO-001"));
    await legacyWrite(world, "cli-pull-update-55-x", "sending", { type: "pull", number: 55 });
    const refused = await world.cli(["migrate", "--execute"]);
    expect(refused.json).toMatchObject({ error: "conflict" });
    expect(refused.json.message).toContain("belongs to no legacy initiative");
  });

  test("a real unresolved legacy write is reconciled under its own identity after migration, never sent twice", async () => {
    world = createWorld({
      config: migratingConfig({
        security: {
          credentials: { source: "env", variable: "ACME_TOKEN" },
          authorization: { mode: "operator" },
          markerNamespace: "portfolio-cli",
        },
      }),
    });
    const issue = world.specIssue("DEMO-001");
    writeLegacy(
      world,
      legacyRecord("DEMO-001", {
        specification: { issueNumber: issue, digest: "d".repeat(64), digestVerified: true },
      }),
    );
    // The earlier lifecycle's own writer (the published @comforge/github), with its marker
    // namespace and the shared ledger: GitHub stores the comment, the answer is lost.
    const writer = createGitHubWriter({
      repository: { owner: "acme", name: "widgets" },
      token: () => TOKEN,
      capabilities: ["issues:comment"],
      authorize: (d) => ({
        allow: true,
        descriptorDigest: d.digest,
        expiresAt: world.clock.now + 60_000,
      }),
      ledger: createFileLedger({ directory: legacyDir(world), namespace: "writes" }) as never,
      clock: () => world.clock.now,
      markers: { namespace: "portfolio-cli" },
      // While the earlier process runs, its own search for the lost comment fails too, so the
      // write stays unresolved, as after a crash.
      fetchImpl: (async (input: string | URL | Request, init?: RequestInit) =>
        (init?.method ?? "GET") === "GET" && String(input).includes("/comments")
          ? new Response("{}", { status: 503 })
          : world.gh.fetchImpl(input, init)) as typeof fetch,
    });
    const op = {
      kind: "issue.comment" as const,
      operationId: "cli-comment-legacy-1",
      issueNumber: issue,
      body: "Legacy completion.",
    };
    world.gh.faults.push("500-after");
    const lost = await writer.execute(op).catch((e: unknown) => e);
    const recorded = await createFileLedger({
      directory: legacyDir(world),
      namespace: "writes",
    }).get("cli-comment-legacy-1");
    expect((recorded as { state: string } | null)?.state).toBe("indeterminate");
    expect(lost).toBeDefined();
    const commentsBefore = [...world.gh.comments.values()].filter((c) => c.issue === issue).length;
    expect(commentsBefore).toBe(1);

    const migrated = await world.cli(["migrate", "--execute"]);
    expect(migrated.json).toMatchObject({
      state: "cut-over",
      unresolvedWrites: ["cli-comment-legacy-1"],
    });
    const rec = await world.cli(["recover", "DEMO-001", "--execute"]);
    expect(rec.json.reconciled).toEqual([
      expect.objectContaining({ operationId: "cli-comment-legacy-1", status: "verified" }),
    ]);
    expect([...world.gh.comments.values()].filter((c) => c.issue === issue)).toHaveLength(1);
    expect(world.gh.writes().filter((w) => w.method === "POST")).toHaveLength(1);
  });

  test("writes must stay in their ledger: a configuration with a separate ledger is refused", async () => {
    world = createWorld({
      config: baseConfig({
        state: { legacy: { directory: "agent-lifecycle", format: "agent-lifecycle/v1" } },
      }),
    });
    writeLegacy(world, legacyRecord("DEMO-001"));
    await legacyWrite(world, "cli-pull-update-12-x", "succeeded", { type: "pull", number: 12 });
    const r = await world.cli(["migrate"]);
    expect(r.json).toMatchObject({ error: "conflict" });
    expect(r.json.message).toContain("state.writeLedgerDirectory");
  });

  test("rollback is allowed only while nothing changed, and a retired import can be imported again", async () => {
    world = createWorld({ config: migratingConfig() });
    writeLegacy(world, legacyRecord("DEMO-001"));
    await world.cli(["migrate", "--execute"]);
    const plan = await world.cli(["migrate", "--rollback"]);
    expect(plan.json).toMatchObject({ executed: false, rollback: { retire: ["DEMO-001"] } });
    const done = await world.cli(["migrate", "--rollback", "--execute"]);
    expect(done.json.executed).toBe(true);
    expect(existsSync(path.join(legacyDir(world), ".migrated"))).toBe(false);
    expect((await world.cli(["status", "DEMO-001"])).json.stage).toBe("cleaned");
    const re = await world.cli(["migrate", "--execute"]);
    expect(re.json).toMatchObject({ state: "cut-over", plan: [{ action: "import" }] });
    expect((await world.cli(["status", "DEMO-001"])).json.stage).toBe("published");

    // After a change since the import, rollback would discard it: refused.
    await openContext(world.rt()).state.update("DEMO-001", (r) => {
      r.revisions.push({ prNumber: 12, reviewedHead: SHA("b"), at: "2026-11-02T00:00:00.000Z" });
    });
    const refused = await world.cli(["migrate", "--rollback", "--execute"]);
    expect(refused.json).toMatchObject({ error: "conflict" });
    expect(existsSync(path.join(legacyDir(world), ".migrated"))).toBe(true);
  });
});
