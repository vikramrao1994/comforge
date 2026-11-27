import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import path from "node:path";
import type { OperationRecord } from "@comforge/github";
import { createMemoryLedger } from "@comforge/ledger";
import { stableJson } from "../src/json.ts";
import { createLifecycleServices } from "../src/services.ts";
import { type StoredRecord, stateStoreOn } from "../src/state.ts";
import { baseConfig, createWorld, TOKEN, type World } from "./harness.ts";

// R10: the lifecycle as injected, transport-neutral services. Same results and errors as the
// CLI, nothing taken from the process, nothing shared between calls or repositories.

const worlds: World[] = [];
afterEach(() => {
  for (const w of worlds.splice(0)) w.dispose();
});
const make = (config?: Record<string, unknown>) => {
  const w = createWorld(config ? { config } : {});
  worlds.push(w);
  return w;
};
const TICKET = "DEMO-001";
const repository = (w: World) => ({ root: w.primary, commonDir: path.join(w.primary, ".git") });
/** A runtime whose cwd is not the repository and which carries no credential. */
const detached = (w: World) => ({ ...w.rt("/"), env: { ...w.env } });

describe("R10: lifecycle services", () => {
  test("injected repository and credential provider; no cwd discovery, no process state touched", async () => {
    const w = make();
    const envBefore = stableJson(process.env);
    const cwdBefore = process.cwd();
    const seen: string[] = [];
    const services = createLifecycleServices({
      runtime: detached(w),
      repository: repository(w),
      credentials: (config) => {
        seen.push(`${config.repository.owner}/${config.repository.name}`);
        return TOKEN;
      },
    });
    const issue = w.specIssue(TICKET);
    const started = await services.start({ id: TICKET, issue });
    expect(started.ok).toBe(true);
    if (started.ok)
      expect(started.value).toMatchObject({ initiative: TICKET, branch: "agent/demo-001" });
    expect(seen).toContain("acme/widgets");
    expect(stableJson(process.env)).toBe(envBefore);
    expect(process.cwd()).toBe(cwdBefore);

    // Without the provider the same runtime has no credential: a structured refusal, no throw.
    const bare = createLifecycleServices({ runtime: detached(w), repository: repository(w) });
    const refused = await bare.revise({ pr: 1 });
    expect(refused).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "credential-missing", exit: 1 }),
    });
  });

  test("independent repositories run concurrently without sharing state", async () => {
    const [a, b] = [make(), make()];
    const svc = (w: World) =>
      createLifecycleServices({ runtime: w.rt(), repository: repository(w) });
    const [ra, rb] = await Promise.all([
      svc(a).start({ id: TICKET, issue: a.specIssue(TICKET) }),
      svc(b).start({ id: "OTHER-002", issue: b.specIssue("OTHER-002") }),
    ]);
    expect([ra.ok, rb.ok]).toEqual([true, true]);
    const sa = await svc(a).status({});
    const sb = await svc(b).status({});
    expect(
      sa.ok && (sa.value.initiatives as { initiative: string }[]).map((i) => i.initiative),
    ).toEqual([TICKET]);
    expect(
      sb.ok && (sb.value.initiatives as { initiative: string }[]).map((i) => i.initiative),
    ).toEqual(["OTHER-002"]);
  });

  test("state and write ledger in the embedder's own store: nothing under .git/comforge", async () => {
    const w = make();
    const services = createLifecycleServices({
      runtime: w.rt(),
      repository: repository(w),
      state: stateStoreOn(createMemoryLedger<StoredRecord>()),
      writeLedger: () => createMemoryLedger<OperationRecord>(),
    });
    const issue = w.specIssue(TICKET);
    const started = await services.start({ id: TICKET, issue });
    expect(started.ok).toBe(true);
    const checkout = started.ok ? started.value.checkout : "";
    w.commitFile(checkout, "a.txt", "a\n", `feat: a\n\nTicket: ${TICKET}`);
    expect((await services.verify({ id: TICKET })).ok).toBe(true);
    const published = await services.publish({ id: TICKET, title: "A", execute: true });
    expect(published.ok).toBe(true);
    expect(existsSync(path.join(w.primary, ".git", "comforge"))).toBe(false);
  });

  test("a cancelled call stops between stages with a structured, resumable error", async () => {
    const w = make();
    const controller = new AbortController();
    controller.abort("shutting down");
    const services = createLifecycleServices({
      runtime: w.rt(),
      repository: repository(w),
      signal: controller.signal,
    });
    const r = await services.start({ id: TICKET, issue: w.specIssue(TICKET) });
    expect(r).toEqual({
      ok: false,
      error: {
        code: "cancelled",
        message: expect.any(String),
        detail: { reason: "shutting down" },
        exit: 4,
      },
    });
    expect(
      (await createLifecycleServices({ runtime: w.rt(), repository: repository(w) }).status({})).ok,
    ).toBe(true);
  });

  test("authorization is the trusted configuration's for a service caller too", async () => {
    const w = make(
      baseConfig({ security: { credentials: { source: "env", variable: "ACME_TOKEN" } } }),
    );
    const services = createLifecycleServices({ runtime: w.rt(), repository: repository(w) });
    const issue = w.specIssue(TICKET);
    const started = await services.start({ id: TICKET, issue });
    const checkout = started.ok ? started.value.checkout : "";
    w.commitFile(checkout, "a.txt", "a\n", `feat: a\n\nTicket: ${TICKET}`);
    await services.verify({ id: TICKET });
    const viaService = await services.publish({ id: TICKET, title: "A", execute: true });
    const viaCli = await w.cli(["publish", TICKET, "--title", "A", "--execute"]);
    expect(viaService.ok).toBe(false);
    if (!viaService.ok)
      expect([viaService.error.code, viaService.error.exit]).toEqual([
        viaCli.json.error,
        viaCli.code,
      ]);
    expect(viaCli.json.error).toBe("authorization-required");
    // A forged authorization handed to the service is ignored, not trusted.
    const forged = await services.publish({
      id: TICKET,
      title: "A",
      execute: true,
      authorized: { mode: "operator" },
    } as never);
    expect(forged.ok ? "written" : forged.error.code).toBe("authorization-required");
    expect(w.gh.writes()).toHaveLength(0);
  });

  test("interleaved calls on two repositories stay apart; credentials and ids never cross", async () => {
    const [a, b] = [make(), make()];
    const seen = { a: 0, b: 0 };
    const svc = (w: World, k: "a" | "b") =>
      createLifecycleServices({
        runtime: detached(w),
        repository: repository(w),
        credentials: () => {
          seen[k]++;
          return TOKEN;
        },
      });
    const [sa, sb] = [svc(a, "a"), svc(b, "b")];
    const [ia, ib] = [a.specIssue(TICKET), b.specIssue("OTHER-002")];
    const [ra, rb] = await Promise.all([
      sa.start({ id: TICKET, issue: ia }),
      sb.start({ id: "OTHER-002", issue: ib }),
    ]);
    const ca = ra.ok ? ra.value.checkout : "";
    const cb = rb.ok ? rb.value.checkout : "";
    a.commitFile(ca, "a.txt", "a\n", `feat: a\n\nTicket: ${TICKET}`);
    b.commitFile(cb, "b.txt", "b\n", "feat: b\n\nTicket: OTHER-002");
    const [va, vb] = await Promise.all([sa.verify({ id: TICKET }), sb.verify({ id: "OTHER-002" })]);
    expect([va.ok && va.value.status, vb.ok && vb.value.status]).toEqual(["PASS", "PASS"]);
    // Each instance sees only its repository.
    const cross = await sa.status({ id: "OTHER-002" });
    expect(cross.ok ? "found" : cross.error.code).toBe("not-found");
    expect(seen.a).toBeGreaterThan(0);
    expect(seen.b).toBeGreaterThan(0);
    const [pa, pb] = await Promise.all([
      sa.publish({ id: TICKET, title: "A", execute: true }),
      sb.publish({ id: "OTHER-002", title: "B", execute: true }),
    ]);
    expect([pa.ok, pb.ok]).toEqual([true, true]);
    expect([...a.gh.pulls.values()].map((p) => p.head.ref)).toEqual(["agent/demo-001"]);
    expect([...b.gh.pulls.values()].map((p) => p.head.ref)).toEqual(["agent/other-002"]);
  });

  test("tool-shaped input is untrusted: path-like ids, nested unknown fields and a forged authorization change nothing", async () => {
    const w = make(
      baseConfig({ security: { credentials: { source: "env", variable: "ACME_TOKEN" } } }),
    );
    const services = createLifecycleServices({ runtime: w.rt(), repository: repository(w) });
    for (const id of ["../../etc/passwd", "DEMO-001/../x", "demo-001", "DEMO-001.Phase"]) {
      const r = await services.status({ id });
      expect([id, r.ok ? "ok" : r.error.code]).toEqual([
        id,
        id === "demo-001" || id === "DEMO-001.Phase" ? "not-found" : "not-found",
      ]);
      const s = await services.start({ id, issue: 1 });
      expect([id, s.ok ? "ok" : s.error.code]).toEqual([id, "usage"]);
    }
    const issue = w.specIssue(TICKET);
    const started = await services.start({
      id: TICKET,
      issue,
      extra: { authorized: { mode: "operator" } },
    } as never);
    expect(started.ok).toBe(true);
    const checkout = started.ok ? started.value.checkout : "";
    w.commitFile(checkout, "a.txt", "a\n", `feat: a\n\nTicket: ${TICKET}`);
    await services.verify({ id: TICKET });
    for (const forged of [
      { mode: "operator" },
      {
        mode: "owner-grant",
        grantId: "x",
        keyId: "y",
        expiresAt: "2999-01-01",
        envelopeDigest: "z",
      },
    ]) {
      const r = await services.publish({
        id: TICKET,
        title: "A",
        execute: true,
        authorized: forged,
      } as never);
      expect(r.ok ? "written" : r.error.code).toBe("authorization-required");
      const c = await services.complete({ raw: {}, execute: true, authorized: forged } as never);
      expect(c.ok).toBe(false);
    }
    expect(w.gh.writes()).toHaveLength(0);
  });

  test("cancelled right after a remote write: the delivery stops between stages, durable and resumable", async () => {
    const w = make();
    const issue = w.specIssue(TICKET);
    const base = createLifecycleServices({ runtime: w.rt(), repository: repository(w) });
    const started = await base.start({ id: TICKET, issue });
    const checkout = started.ok ? started.value.checkout : "";
    w.commitFile(checkout, "a.txt", "a\n", `feat: a\n\nTicket: ${TICKET}`);
    await base.verify({ id: TICKET });
    const head = w.sh(checkout, "git", "rev-parse", "HEAD");
    const raw = {
      contract: "acme-completion/v1",
      issueType: "implementation",
      outcome: "completed",
      sourceRevision: head,
      execution: { runner: "test-agent", model: "m" },
      summary: "Implemented a.",
      sections: { changed_behavior: "a exists." },
      findings: [],
      changedArtifacts: [],
      evidence: [],
      validation: [{ gate: "unit", command: "sh check.sh", status: "PASS" }],
      limitations: [],
      nextSteps: [],
    };
    const controller = new AbortController();
    // The caller cancels the moment the pull request is created on GitHub.
    w.gh.beforeWrite.push(() => controller.abort("caller went away"));
    const cancelled = createLifecycleServices({
      runtime: w.rt(),
      repository: repository(w),
      signal: controller.signal,
    });
    const r = await cancelled.deliver({ id: TICKET, title: "A", raw, execute: true });
    expect(r.ok && [r.value.delivery, r.exit]).toEqual(["incomplete", 4]);
    expect(r.ok && (r.value.error as { code?: string }).code).toBe("cancelled");
    expect(w.gh.pulls.size).toBe(1);
    const done = await base.deliver({ id: TICKET, title: "A", raw, execute: true });
    expect(done.ok && done.value.delivery).toBe("complete");
    expect(w.gh.pulls.size).toBe(1);
    expect([...w.gh.comments.values()].filter((c) => c.issue === issue)).toHaveLength(1);
    const status = await base.status({ id: TICKET });
    expect(status.ok).toBe(true);
  });

  test("the CLI prints exactly what the service returns", async () => {
    const w = make();
    const services = createLifecycleServices({ runtime: w.rt(), repository: repository(w) });
    const issue = w.specIssue(TICKET);
    await services.start({ id: TICKET, issue });
    for (const [args, call] of [
      [["status", TICKET], () => services.status({ id: TICKET })],
      [["status"], () => services.status({})],
      [["migrate"], () => services.migrate({ execute: false })],
    ] as const) {
      const viaCli = await w.cli([...args]);
      const viaService = await call();
      expect(stableJson(viaCli.json)).toBe(
        stableJson(
          viaService.ok
            ? viaService.value
            : {
                error: viaService.error.code,
                message: viaService.error.message,
                detail: viaService.error.detail,
              },
        ),
      );
    }
  });
});
