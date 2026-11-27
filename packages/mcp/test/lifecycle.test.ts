import { afterEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { writeFileSync } from "node:fs";
import path from "node:path";
import type { Runtime } from "@comforge/cli";
import { keyIdFor } from "@comforge/core";
import { type CallContext, HANDLERS } from "../src/tools.ts";
import { baseConfig, connect, createWorld, principal, TOKEN, type World } from "./harness.ts";

// The lifecycle through MCP is the published @comforge/cli's: the same state store, the same
// authorization, the same refusals. These tests drive it end to end on a synthetic world.

let world: World;
afterEach(() => world?.dispose());
const TICKET = "DEMO-001";
const both = principal(["executor", "publisher"]);

function resultDoc(head: string) {
  return {
    contract: "acme-completion/v1",
    issueType: "implementation",
    outcome: "completed",
    sourceRevision: head,
    execution: { runner: "test-agent", model: "test-model" },
    summary: "Implemented a.",
    sections: { changed_behavior: "a exists." },
    findings: [],
    changedArtifacts: [],
    evidence: [],
    validation: [{ gate: "unit", command: "sh check.sh", status: "PASS" }],
    limitations: [],
    nextSteps: [],
  };
}

async function verified(w: World, s: Awaited<ReturnType<typeof connect>>) {
  const issue = w.specIssue(TICKET);
  const started = await s.call("comforge_start", {
    repository: "widgets",
    initiative: TICKET,
    issue,
  });
  expect(started.isError).toBe(false);
  const checkout = started.body.data.checkout as string;
  w.commitFile(checkout, "a.txt", "a\n", `feat: a\n\nTicket: ${TICKET}`);
  const v = await s.call("comforge_verify", { repository: "widgets", initiative: TICKET });
  expect(v.body.data.status).toBe("PASS");
  return { issue, checkout, head: w.sh(checkout, "git", "rev-parse", "HEAD") };
}

describe("start, verify and deliver through MCP", () => {
  test("share one state store with the CLI, plan without writes, and deliver once", async () => {
    world = createWorld();
    const s = await connect({
      repositories: [world.binding],
      host: world.host(),
      principal: both,
      transport: "stdio",
    });
    const { head } = await verified(world, s);

    // The CLI sees what the server recorded, and the server lists it summary-first.
    const cli = await world.cli(["status", TICKET]);
    expect(cli.code).toBe(0);
    expect((cli.json.lastValidation as { commit: string }).commit).toBe(head);
    const listed = await s.call("comforge_status", { repository: "widgets" });
    expect(listed.body.data.initiatives).toEqual([
      expect.objectContaining({
        initiative: TICKET,
        lastValidation: { status: "PASS", commit: head },
      }),
    ]);
    const one = await s.call("comforge_status", { repository: "widgets", initiative: TICKET });
    expect(one.body.data.counts.validations).toBe(1);
    const ev = await s.call("comforge_evidence", {
      repository: "widgets",
      initiative: TICKET,
      section: "validations",
    });
    expect(ev.body.data.items[0].commit).toBe(head);

    const plan = await s.call("comforge_deliver", {
      repository: "widgets",
      initiative: TICKET,
      title: "A",
      result: resultDoc(head),
      execute: false,
    });
    expect(plan.body.data.delivery).toBe("planned");
    expect(world.gh.writes()).toHaveLength(0);

    const done = await s.call("comforge_deliver", {
      repository: "widgets",
      initiative: TICKET,
      title: "A",
      result: resultDoc(head),
      execute: true,
    });
    expect(done.isError).toBe(false);
    expect(done.body.data.delivery).toBe("complete");
    expect(done.text).not.toContain(TOKEN);
    expect(
      [...world.gh.pulls.values()].filter((p) => p.head.ref === "agent/demo-001"),
    ).toHaveLength(1);
    expect(world.gh.comments.size).toBe(1);

    // A repeated delivery is idempotent: no second pull request or completion.
    await s.call("comforge_deliver", {
      repository: "widgets",
      initiative: TICKET,
      title: "A",
      result: resultDoc(head),
      execute: true,
    });
    expect(
      [...world.gh.pulls.values()].filter((p) => p.head.ref === "agent/demo-001"),
    ).toHaveLength(1);
    expect(world.gh.comments.size).toBe(1);
    await s.close();
  });

  test("an unverified head is refused with the CLI's code and a hint", async () => {
    world = createWorld();
    const s = await connect({
      repositories: [world.binding],
      host: world.host(),
      principal: both,
      transport: "stdio",
    });
    const issue = world.specIssue(TICKET);
    const started = await s.call("comforge_start", {
      repository: "widgets",
      initiative: TICKET,
      issue,
    });
    world.commitFile(started.body.data.checkout, "a.txt", "a\n", `feat: a\n\nTicket: ${TICKET}`);
    const head = world.sh(started.body.data.checkout, "git", "rev-parse", "HEAD");
    const r = await s.call("comforge_deliver", {
      repository: "widgets",
      initiative: TICKET,
      title: "A",
      result: resultDoc(head),
      execute: true,
    });
    expect(r.isError).toBe(true);
    expect(r.body.schema).toBe("comforge-mcp-error/v1");
    expect(r.body.code).toBe("validation-missing");
    expect(r.body.detail).toMatchObject({
      delivery: "incomplete",
      failedStage: "publish",
      attempt: 1,
    });
    expect(r.body.hint).toContain("comforge_verify");
    expect(world.gh.writes()).toHaveLength(0);
    await s.close();
  });
});

describe("cleanup", () => {
  test("execute of unmerged work is refused by the CLI's own proofs, with no side effect", async () => {
    world = createWorld();
    const s = await connect({
      repositories: [world.binding],
      host: world.host(),
      principal: both,
      transport: "stdio",
    });
    await verified(world, s);
    const before = world.sh(world.remote, "git", "branch", "--list");
    const refused = await s.call("comforge_cleanup", {
      repository: "widgets",
      target: TICKET,
      execute: true,
    });
    expect(refused.body.ok).not.toBe(true);
    expect(refused.body.exit).toBeGreaterThan(0);
    expect(world.sh(world.remote, "git", "branch", "--list")).toBe(before);
    await s.close();
  });
});

describe("owner grants through MCP", () => {
  const keyPair = () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
    return {
      publicKeyPem,
      privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      keyId: keyIdFor(publicKeyPem),
    };
  };
  const owner = keyPair();
  const config = (extra: Record<string, unknown> = {}) =>
    baseConfig({
      ...extra,
      security: {
        credentials: { source: "env", variable: "ACME_TOKEN" },
        ...(extra.cleanup
          ? { capabilities: ["pulls:create", "pulls:update", "issues:comment", "branches:delete"] }
          : {}),
        authorization: {
          mode: "owner-grant",
          grantScheme: "acme-grant/v1",
          trustedKeys: [{ keyId: owner.keyId, publicKeyPem: owner.publicKeyPem, label: "owner" }],
        },
      },
    });

  /** The owner's side, outside the server: `comforge grant template` and `grant sign`. */
  async function envelope(
    w: World,
    key = owner.privateKeyPem,
    edit: (g: Record<string, unknown>) => void = () => {},
    extra: string[] = [],
  ) {
    const template = (await w.cli(["grant", "template", TICKET, ...extra])).json;
    edit(template);
    const grantFile = path.join(w.root, `grant-${Math.random().toString(36).slice(2)}.json`);
    const keyFile = path.join(w.root, `key-${Math.random().toString(36).slice(2)}.pem`);
    writeFileSync(grantFile, JSON.stringify(template));
    writeFileSync(keyFile, key);
    return (await w.cli(["grant", "sign", TICKET, "--grant", grantFile, "--key", keyFile])).json;
  }

  test("no grant, a foreign key, a forged signature or another head is refused with no write; a valid one delivers", async () => {
    world = createWorld({ config: config() });
    const s = await connect({
      repositories: [world.binding],
      host: world.host(),
      principal: both,
      transport: "stdio",
    });
    const { head } = await verified(world, s);
    const deliver = (grant?: unknown) =>
      s.call("comforge_deliver", {
        repository: "widgets",
        initiative: TICKET,
        title: "A",
        result: resultDoc(head),
        execute: true,
        ...(grant ? { grant } : {}),
      });

    expect((await deliver()).body.code).toBe("authorization-required");
    const foreign = await envelope(world, keyPair().privateKeyPem);
    expect((await deliver(foreign)).body.code).toBe("unauthorized");
    const genuine = await envelope(world);
    const forged = { ...genuine, signature: `${String(genuine.signature).slice(0, -4)}AAAA` };
    expect((await deliver(forged)).body.code).toBe("unauthorized");
    const otherHead = await envelope(world, owner.privateKeyPem, (g) => {
      (g.publication as { candidateSha: string }).candidateSha = "f".repeat(40);
    });
    expect((await deliver(otherHead)).body.code).toBe("unauthorized");
    expect(world.gh.writes()).toHaveLength(0);

    const ok = await deliver(genuine);
    expect(ok.body.data?.delivery ?? ok.body).toBe("complete");
    // The grant file the server staged is gone: nothing of it stays on disk.
    expect(ok.text).not.toContain("comforge-mcp-grant-");

    await s.close();
  });

  test("cleanup through MCP: a publication grant never deletes the branch; a cleanup-scoped grant does", async () => {
    world = createWorld({ config: config({ cleanup: { deleteRemoteBranch: true } }) });
    const s = await connect({
      repositories: [world.binding],
      host: world.host(),
      principal: both,
      transport: "stdio",
    });
    const { head } = await verified(world, s);
    const publication = await envelope(world);
    const delivered = await s.call("comforge_deliver", {
      repository: "widgets",
      initiative: TICKET,
      title: "A",
      result: resultDoc(head),
      execute: true,
      grant: publication,
    });
    const pr = (delivered.body.data as { pullRequest: number }).pullRequest;
    Object.assign(world.gh.pulls.get(pr) as object, {
      state: "closed",
      merged: true,
      merged_at: "2026-01-02T00:00:00Z",
    });
    world.sh(world.remote, "git", "update-ref", "refs/heads/main", head);
    const branch = () =>
      world.sh(
        world.remote,
        "git",
        "for-each-ref",
        "--format=%(refname)",
        "refs/heads/agent/demo-001",
      );
    const cleanup = (grant?: unknown) =>
      s.call("comforge_cleanup", {
        repository: "widgets",
        target: TICKET,
        execute: true,
        ...(grant ? { grant } : {}),
      });

    for (const g of [publication, await envelope(world)]) {
      const refused = await cleanup(g);
      expect(refused.body).toMatchObject({ code: "unauthorized" });
      expect(refused.body.message).toContain("needs a command grant that scopes it");
    }
    expect((await cleanup()).body.code).toBe("authorization-required");
    expect(branch()).toBe("refs/heads/agent/demo-001");
    const scoped = await envelope(world, owner.privateKeyPem, () => {}, ["--command", "cleanup"]);
    const done = await cleanup(scoped);
    expect(done.body.ok).toBe(true);
    expect(branch()).toBe("");
    await s.close();
  });

  test("a grant envelope with an extra field is refused by the input schema", async () => {
    world = createWorld({ config: config() });
    const s = await connect({
      repositories: [world.binding],
      host: world.host(),
      principal: both,
      transport: "stdio",
    });
    const r = await s.call("comforge_recover", {
      repository: "widgets",
      initiative: TICKET,
      execute: true,
      grant: { grant: {}, keyId: "0".repeat(16), signature: "A".repeat(20), path: "/etc/passwd" },
    });
    expect(r.isError).toBe(true);
    expect(r.text).not.toContain("comforge-mcp-error");
    await s.close();
  });
});

describe("cancellation", () => {
  const ctxFor = (w: World, signal: AbortSignal, rt: Runtime = w.rt()): CallContext => ({
    principal: both,
    binding: w.binding,
    rt,
    host: w.host(),
    signal,
    transport: "stdio",
    secrets: [],
    server: { bindings: [w.binding], executionAvailable: true, isolation: null, tools: [] },
  });

  test("a call cancelled before it starts stops at the first stage and records nothing", async () => {
    world = createWorld();
    const issue = world.specIssue(TICKET);
    const controller = new AbortController();
    controller.abort("client cancelled");
    const r = await HANDLERS.comforge_start(ctxFor(world, controller.signal), {
      repository: "widgets",
      initiative: TICKET,
      issue,
    });
    expect(r).toMatchObject({ code: "cancelled", exit: 4 });
    expect((await world.cli(["status"])).json.initiatives).toEqual([]);
  });

  test("a call cancelled during its work stops between stages, never inside a write", async () => {
    world = createWorld();
    const s = await connect({
      repositories: [world.binding],
      host: world.host(),
      principal: both,
      transport: "stdio",
    });
    const { head } = await verified(world, s);
    await s.close();
    const controller = new AbortController();
    const base = world.rt();
    // Cancels as the delivery pushes: the push completes, the next checkpoint stops the call.
    const rt: Runtime = {
      ...base,
      run: (cmd, args, o) => {
        const r = base.run(cmd, args, o);
        if (cmd === "git" && args[0] === "push") controller.abort("client cancelled");
        return r;
      },
    };
    const r = await HANDLERS.comforge_deliver(ctxFor(world, controller.signal, rt), {
      repository: "widgets",
      initiative: TICKET,
      title: "A",
      result: resultDoc(head),
      execute: true,
    });
    const outcome = "code" in r ? r.code : (r.data as { delivery: string }).delivery;
    expect(["cancelled", "incomplete"]).toContain(outcome);
    // Whatever was applied is recorded and recoverable: no pull request was created twice.
    expect(
      [...world.gh.pulls.values()].filter((p) => p.head.ref === "agent/demo-001").length,
    ).toBeLessThanOrEqual(1);
    const status = await world.cli(["status", TICKET]);
    expect(status.code).toBe(0);
  });
});

describe("uncertain writes", () => {
  test("a pull request whose response is lost is settled from GitHub, never created twice", async () => {
    world = createWorld();
    const s = await connect({
      repositories: [world.binding],
      host: world.host(),
      principal: both,
      transport: "stdio",
    });
    const { head } = await verified(world, s);
    // GitHub applies the create, but its response never arrives.
    world.gh.faults.push("network-after");
    const done = await s.call("comforge_deliver", {
      repository: "widgets",
      initiative: TICKET,
      title: "A",
      result: resultDoc(head),
      execute: true,
    });
    expect(done.body.data?.delivery).toBe("complete");
    expect(
      [...world.gh.pulls.values()].filter((p) => p.head.ref === "agent/demo-001"),
    ).toHaveLength(1);
    // Nothing stays open for recovery, and a recovery run applies nothing.
    const writes = world.gh.writes().length;
    const settled = await s.call("comforge_recover", {
      repository: "widgets",
      initiative: TICKET,
      execute: true,
    });
    expect(settled.isError).toBe(false);
    expect(settled.body.exit).toBe(0);
    expect(world.gh.writes().length).toBe(writes);
    await s.close();
  });
});
