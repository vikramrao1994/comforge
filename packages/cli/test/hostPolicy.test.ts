import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openContext } from "../src/context.ts";
import type { HostPolicy } from "../src/host.ts";
import { createLifecycleServices } from "../src/services.ts";
import { baseConfig, createWorld, TOKEN, type World } from "./harness.ts";

// M9: what an embedding supervisor decides through trusted host policy — the checkout parent,
// a worker user's preparation and removal, its own validation — and reopening a cleaned
// initiative as a new attempt. The supervisor's worker user is simulated: a candidate command
// leaves a read-only tree that only the host's removal hook can delete.

let world: World;
const dirs: string[] = [];
afterEach(() => {
  world?.dispose();
  for (const d of dirs.splice(0)) {
    chmodTree(d);
    rmSync(d, { recursive: true, force: true });
  }
});
const TICKET = "DEMO-001";
const SECURITY = {
  credentials: { source: "env", variable: "ACME_TOKEN" },
  authorization: { mode: "operator" },
  capabilities: ["pulls:create", "pulls:update", "issues:comment", "branches:delete"],
};
const chmodTree = (dir: string) => {
  if (existsSync(dir)) Bun.spawnSync(["chmod", "-R", "u+w", dir]);
};
const services = (w: World, host?: HostPolicy) =>
  createLifecycleServices({
    runtime: w.rt(),
    repository: { root: w.primary, commonDir: path.join(w.primary, ".git") },
    credentials: () => TOKEN,
    ...(host ? { host } : {}),
  });
const value = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(`service refused: ${JSON.stringify(r.error)}`);
  return r.value;
};
const supervisorArea = () => {
  const d = realpathSync(mkdtempSync(path.join(tmpdir(), "comforge-supervisor-")));
  dirs.push(d);
  return d;
};

describe("host checkout parent", () => {
  test("checkouts go under the host's parent, are recorded, and cleanup needs the same policy", async () => {
    world = createWorld({ config: baseConfig({ security: SECURITY }) });
    const parent = supervisorArea();
    const prepared: string[] = [];
    const host: HostPolicy = { checkoutParent: parent, prepareCheckout: (d) => prepared.push(d) };
    const issue = world.specIssue(TICKET);
    const started = value(await services(world, host).start({ id: TICKET, issue }));
    expect(started.checkout).toBe(path.join(parent, "demo-001"));
    expect(prepared).toEqual([started.checkout]);
    const record = await openContext(world.rt()).state.get(TICKET);
    expect(record?.hostCheckoutParent).toBe(parent);

    world.commitFile(started.checkout, "a.txt", "a\n", `feat: a\n\nTicket: ${TICKET}`);
    value(await services(world, host).verify({ id: TICKET }));
    const pr = value(await services(world, host).publish({ id: TICKET, title: "A", execute: true }))
      .pullRequest as { number: number };
    const head = world.sh(started.checkout, "git", "rev-parse", "HEAD");
    Object.assign(world.gh.pulls.get(pr.number) as object, {
      state: "closed",
      merged: true,
      merged_at: "2026-01-02T00:00:00Z",
    });
    world.sh(world.remote, "git", "update-ref", "refs/heads/main", head);

    // The plain CLI (no host policy) refuses to remove a checkout it did not place.
    const plain = await world.cli(["cleanup", TICKET, "--allow-missing-completion", "--execute"]);
    expect(plain.code).toBe(1);
    expect(plain.json.message).toContain("host checkout parent");
    expect(existsSync(started.checkout)).toBe(true);
    const done = await services(world, host).cleanup({
      target: TICKET,
      execute: true,
      allowMissingCompletion: true,
    });
    if (!done.ok) throw new Error(JSON.stringify(done.error));
    expect(existsSync(started.checkout)).toBe(false);
  });

  test("a relative parent, the primary or a path inside it, or a filesystem root is refused", async () => {
    world = createWorld();
    const issue = world.specIssue(TICKET);
    for (const checkoutParent of ["../clones", world.primary, path.join(world.primary, "x"), "/"]) {
      const r = await services(world, { checkoutParent }).start({ id: TICKET, issue });
      expect(r).toMatchObject({ ok: false, error: { code: "config-invalid" } });
    }
    expect(await openContext(world.rt()).state.get(TICKET)).toBeNull();
  });
});

describe("worker-user execution (simulated)", () => {
  test("a snapshot the candidate made read-only is removed by the host's hook, not left behind", async () => {
    world = createWorld({
      config: baseConfig({
        validation: {
          // The candidate's validation leaves a tree its supervisor cannot delete as itself.
          commands: [
            {
              name: "check",
              run: ["sh", "-c", "mkdir -p out/deep && touch out/deep/f && chmod -R a-w out"],
            },
          ],
        },
        verification: { snapshot: true },
      }),
    });
    const removed: string[] = [];
    const host: HostPolicy = {
      remove: (d) => {
        removed.push(d);
        chmodTree(d); // what a worker-user removal does: as the owner of the files
        rmSync(d, { recursive: true, force: true });
      },
    };
    const issue = world.specIssue(TICKET);
    const { checkout } = value(await services(world, host).start({ id: TICKET, issue }));
    world.commitFile(checkout, ".gitignore", "out/\n", `feat: a\n\nTicket: ${TICKET}`);
    const v = value(await services(world, host).verify({ id: TICKET }));
    expect(v.status).toBe("PASS");
    expect(removed).toHaveLength(1);
    expect(existsSync(removed[0] as string)).toBe(false);
  });
});

describe("host validation policy", () => {
  test("the host's commands replace the configuration's and the validation says so", async () => {
    world = createWorld();
    const ran: string[] = [];
    const issue = world.specIssue(TICKET);
    const host: HostPolicy = {
      validation: [{ name: "runtime-check", run: ["sh", "-c", "echo host > /dev/null"] }],
    };
    const { checkout } = value(await services(world, host).start({ id: TICKET, issue }));
    world.commitFile(checkout, "a.txt", "a\n", `feat: a\n\nTicket: ${TICKET}`);
    const v = value(await services(world, host).verify({ id: TICKET }));
    ran.push(...v.commands.map((c) => c.name));
    expect(ran).toEqual(["runtime-check"]);
    expect(v).toMatchObject({ status: "PASS", policy: "host" });
    // Without the policy the trusted configuration's command runs, and is not marked host.
    const trusted = value(await services(world).verify({ id: TICKET }));
    expect(trusted.commands.map((c) => c.name)).toEqual(["check"]);
    expect(trusted.policy).toBeUndefined();
  });

  test("a shell string, an empty or duplicate list, or a NUL argument is refused", async () => {
    world = createWorld();
    const issue = world.specIssue(TICKET);
    for (const validation of [
      [{ name: "x", run: "sh check.sh" }],
      [],
      [
        { name: "x", run: ["true"] },
        { name: "x", run: ["true"] },
      ],
      [{ name: "x", run: ["sh", "a\0b"] }],
      [{ name: "../x", run: ["true"] }],
    ]) {
      const r = await services(world, { validation } as unknown as HostPolicy).start({
        id: TICKET,
        issue,
      });
      expect(r).toMatchObject({ ok: false, error: { code: "config-invalid" } });
    }
  });
});

describe("reopening a cleaned initiative", () => {
  async function cleaned(w: World) {
    const issue = w.specIssue(TICKET);
    const { checkout } = (await w.cli(["start", TICKET, "--issue", String(issue)])).json;
    w.commitFile(checkout, "a.txt", "a\n", `feat: a\n\nTicket: ${TICKET}`);
    await w.cli(["verify", TICKET]);
    const pr = (await w.cli(["publish", TICKET, "--title", "A", "--execute"])).json.pullRequest
      .number as number;
    const head = w.sh(checkout, "git", "rev-parse", "HEAD");
    Object.assign(w.gh.pulls.get(pr) as object, {
      state: "closed",
      merged: true,
      merged_at: "2026-01-02T00:00:00Z",
    });
    w.sh(w.remote, "git", "update-ref", "refs/heads/main", head);
    const c = await w.cli(["cleanup", TICKET, "--allow-missing-completion", "--execute"]);
    expect(c.code).toBe(0);
    return { issue, pr };
  }

  test("start refuses without --reopen, then opens attempt 2 keeping attempt 1 verbatim", async () => {
    world = createWorld({ config: baseConfig({ security: SECURITY }) });
    const { issue, pr } = await cleaned(world);
    const before = await openContext(world.rt()).state.get(TICKET);
    const again = await world.cli(["start", TICKET, "--issue", String(issue)]);
    expect(again.code).toBe(1);
    expect(again.json.message).toContain("--reopen");

    const reopened = await world.cli(["start", TICKET, "--issue", String(issue), "--reopen"]);
    expect(reopened.code).toBe(0);
    expect(reopened.json.attempt).toBe(2);
    const after = await openContext(world.rt()).state.get(TICKET);
    expect(after).toMatchObject({ attempt: 2, cleanedAt: null, validations: [], publications: [] });
    const archived = after?.attempts?.[0];
    expect(archived?.attempt).toBe(1);
    // The first attempt is kept exactly: its validations, its PR, its write identities.
    const {
      version: _v,
      schema: _s,
      grantUses: _g,
      ...first
    } = before as NonNullable<typeof before>;
    expect(archived?.record).toEqual(first);
    expect(archived?.record.publications.map((p) => p.prNumber)).toEqual([pr]);
    // Status of the new attempt works as for any initiative.
    expect((await world.cli(["status", TICKET])).code).toBe(0);
  });

  test("an initiative that was never started, or is still active, is not reopened", async () => {
    world = createWorld();
    const issue = world.specIssue(TICKET);
    expect((await world.cli(["start", TICKET, "--issue", String(issue), "--reopen"])).code).toBe(1);
    expect((await world.cli(["start", TICKET, "--issue", String(issue)])).code).toBe(0);
    const active = await world.cli(["start", TICKET, "--issue", String(issue), "--reopen"]);
    expect(active.code).toBe(1);
    expect(active.json.message).toContain("already started");
  });

  test("two concurrent reopens: exactly one attempt 2, and nothing of the loser is left", async () => {
    world = createWorld({ config: baseConfig({ security: SECURITY }) });
    const { issue } = await cleaned(world);
    const parents = [supervisorArea(), supervisorArea()];
    const results = await Promise.all(
      parents.map((checkoutParent) =>
        services(world, { checkoutParent }).start({ id: TICKET, issue, reopen: true }),
      ),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const record = await openContext(world.rt()).state.get(TICKET);
    expect(record?.attempt).toBe(2);
    expect(record?.attempts).toHaveLength(1);
    const loser = parents.find((p) => p !== record?.hostCheckoutParent) as string;
    expect(existsSync(path.join(loser, "demo-001"))).toBe(false);
  });
});
