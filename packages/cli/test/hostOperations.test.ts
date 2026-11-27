import { afterEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { keyIdFor } from "@comforge/core";
import { main } from "../src/cli.ts";
import { openContext } from "../src/context.ts";
import { baseConfig, createWorld, type World } from "./harness.ts";

// R14: the writes outside the SDK. Recorded before they run, settled by what GitHub shows,
// never retried blindly; destructive cleanup needs its own owner grant.

let world: World;
afterEach(() => world?.dispose());
const TICKET = "DEMO-001";
const credentials = { source: "env", variable: "ACME_TOKEN" };
const ALL = ["pulls:create", "pulls:update", "issues:comment", "pulls:ready", "branches:delete"];

async function verified(w: World) {
  const issue = w.specIssue(TICKET);
  const { checkout } = (await w.cli(["start", TICKET, "--issue", String(issue)])).json;
  w.commitFile(checkout, "a.txt", "a\n", `feat: a\n\nTicket: ${TICKET}`);
  expect((await w.cli(["verify", TICKET])).code).toBe(0);
  return { checkout: checkout as string, head: w.sh(checkout, "git", "rev-parse", "HEAD") };
}

/** A `gh` on PATH: logs its arguments, makes `pr ready` happen on "GitHub", exits with `status`. */
function fakeGh(w: World, status = 0) {
  const bin = path.join(w.root, "bin");
  mkdirSync(bin, { recursive: true });
  const log = path.join(w.root, "gh.log");
  writeFileSync(path.join(bin, "gh"), `#!/bin/sh\necho "$@" >> "${log}"\nexit ${status}\n`);
  chmodSync(path.join(bin, "gh"), 0o755);
  w.gh.readOverrides.push((p) => {
    const m = p.match(/\/pulls\/(\d+)$/);
    if (m && existsSync(log) && readFileSync(log, "utf8").includes(`pr ready ${m[1]}`)) {
      const pull = w.gh.pulls.get(Number(m[1]));
      if (pull) pull.draft = false;
    }
    return undefined;
  });
  const calls = () =>
    existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : [];
  const cli = async (args: string[]) => {
    let out = "";
    const code = await main(
      [...args, "--json"],
      w.rt(w.primary, { PATH: `${bin}:${process.env.PATH}` }),
      {
        out: (t) => {
          out += t;
        },
        err: (t) => {
          out += t;
        },
      },
    );
    return { code, json: JSON.parse(out) };
  };
  return { calls, cli };
}

const readyConfig = () =>
  baseConfig({
    publication: { draftFirst: true },
    security: { credentials, authorization: { mode: "operator" }, capabilities: ALL },
  });
const hostOps = async (w: World) =>
  (await openContext(w.rt()).state.get(TICKET))?.hostOperations ?? [];

describe("R14: host-adapter writes are journalled and settled from GitHub", () => {
  test("gh reports failure but GitHub shows the pull request ready: succeeded, never retried", async () => {
    world = createWorld({ config: readyConfig() });
    await verified(world);
    const gh = fakeGh(world, 1);
    const r = await gh.cli(["publish", TICKET, "--title", "A", "--execute"]);
    expect([r.code, r.json.pullRequest.draft, r.json.readyForReview.ready]).toEqual([
      0,
      false,
      true,
    ]);
    expect((await hostOps(world)).map((h) => [h.kind, h.state])).toEqual([
      ["pulls:ready", "succeeded"],
    ]);
    await gh.cli(["publish", TICKET, "--title", "A", "--execute"]);
    expect(gh.calls()).toHaveLength(1);
  });

  test("a run that died after the change landed is settled from GitHub without calling gh", async () => {
    world = createWorld({ config: readyConfig() });
    const { head } = await verified(world);
    const gh = fakeGh(world);
    const draft = await gh.cli(["publish", TICKET, "--title", "A", "--draft", "--execute"]);
    const pr = draft.json.pullRequest.number as number;
    // The dead run had recorded its intent, and GitHub shows it applied.
    await openContext(world.rt()).state.update(TICKET, (r) => {
      r.hostOperations = [
        {
          kind: "pulls:ready",
          prNumber: pr,
          head,
          state: "sending",
          at: "2026-11-26T00:00:00.000Z",
          detail: "",
        },
      ];
    });
    const pull = world.gh.pulls.get(pr);
    if (pull) pull.draft = false;
    const r = await gh.cli(["publish", TICKET, "--title", "A", "--execute"]);
    expect([r.code, r.json.readyForReview]).toEqual([0, null]);
    expect(gh.calls()).toEqual([]);
    expect((await hostOps(world)).map((h) => [h.state, h.detail])).toEqual([
      ["succeeded", "settled from GitHub after an interrupted run"],
    ]);
  });

  test("a pull request that is not at the published head is never marked ready", async () => {
    world = createWorld({ config: readyConfig() });
    await verified(world);
    const gh = fakeGh(world);
    world.gh.readOverrides.push((p) => {
      const m = p.match(/\/pulls\/(\d+)$/);
      const pull = m ? world.gh.pulls.get(Number(m[1])) : undefined;
      if (pull && pull.draft) pull.head.sha = "f".repeat(40);
      return undefined;
    });
    const r = await gh.cli(["publish", TICKET, "--title", "A", "--execute"]);
    // Refused before any host write, by the SDK's own head check or by the ready guard.
    expect(r.code).not.toBe(0);
    expect(["stale", "ambiguous"]).toContain(r.json.error);
    expect(gh.calls()).toEqual([]);
  });
});

describe("R14: destructive cleanup is separately authorized", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const owner = {
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
  const REVOKED = "00000000-0000-4000-8000-00000000dead";
  const config = () =>
    baseConfig({
      cleanup: { deleteRemoteBranch: true },
      security: {
        credentials,
        capabilities: ALL,
        authorization: {
          mode: "owner-grant",
          grantScheme: "acme-grant/v1",
          revokedGrants: [REVOKED],
          trustedKeys: [
            {
              keyId: keyIdFor(owner.publicKeyPem),
              publicKeyPem: owner.publicKeyPem,
              label: "owner",
            },
          ],
        },
      },
    });
  async function grant(
    w: World,
    edit: (g: Record<string, unknown>) => void = () => {},
    extra: string[] = [],
  ) {
    const template = (await w.cli(["grant", "template", TICKET, ...extra])).json;
    edit(template);
    const file = path.join(w.root, `grant-${Math.random().toString(36).slice(2)}.json`);
    const key = path.join(w.root, "owner.pem");
    writeFileSync(file, JSON.stringify(template));
    writeFileSync(key, owner.privateKeyPem);
    const envelope = (await w.cli(["grant", "sign", TICKET, "--grant", file, "--key", key])).json;
    const out = `${file}.signed`;
    writeFileSync(out, JSON.stringify(envelope));
    return out;
  }
  const branch = (w: World) =>
    w.sh(w.remote, "git", "for-each-ref", "--format=%(refname)", "refs/heads/agent/demo-001");

  test("the publication's grant, no grant or an expired grant cannot delete the branch; its own grant can", async () => {
    world = createWorld({ config: config() });
    const { head } = await verified(world);
    const g = await grant(world, (t) => {
      t.maxAttempts = 5;
    });
    const pr = (await world.cli(["publish", TICKET, "--title", "A", "--grant", g, "--execute"]))
      .json.pullRequest.number;
    const pull = world.gh.pulls.get(pr);
    if (pull)
      Object.assign(pull, { state: "closed", merged: true, merged_at: "2026-01-02T00:00:00Z" });
    world.sh(world.remote, "git", "update-ref", "refs/heads/main", head);
    const cleanup = (file?: string) =>
      world.cli([
        "cleanup",
        TICKET,
        "--allow-missing-completion",
        "--execute",
        ...(file ? ["--grant", file] : []),
      ]);

    // A publication grant — even a fresh, unused one — never authorizes cleanup by omission.
    for (const file of [g, await grant(world)]) {
      const refused = await cleanup(file);
      expect([refused.json.error, refused.json.message]).toEqual([
        "unauthorized",
        expect.stringContaining("needs a command grant that scopes it"),
      ]);
    }
    expect((await cleanup()).json.error).toBe("authorization-required");
    const expired = await grant(
      world,
      (t) => {
        t.expiresAt = "2000-01-01T00:00:00.000Z";
      },
      ["--command", "cleanup"],
    );
    expect((await cleanup(expired)).json.error).toBe("unauthorized");
    // A cleanup grant for another pull request is refused too.
    const other = await grant(
      world,
      (t) => {
        (t.scope as { commands: { pullRequest: number }[] }).commands[0]!.pullRequest = pr + 1;
      },
      ["--command", "cleanup"],
    );
    expect((await cleanup(other)).json.message).toContain("another pull request");
    expect(branch(world)).toBe("refs/heads/agent/demo-001");

    const own = await grant(world, () => {}, ["--command", "cleanup"]);
    const done = await cleanup(own);
    expect(done.code).toBe(0);
    expect(branch(world)).toBe("");
  }, 60_000);

  test("a grant the trusted configuration revokes is refused, though validly signed", async () => {
    world = createWorld({ config: config() });
    await verified(world);
    const revoked = await grant(world, (t) => {
      t.grantId = REVOKED;
    });
    const r = await world.cli(["publish", TICKET, "--title", "A", "--grant", revoked, "--execute"]);
    expect([r.json.error, r.json.message]).toEqual([
      "unauthorized",
      expect.stringContaining("revoked"),
    ]);
    expect(world.gh.pulls.size).toBe(0);
  }, 60_000);
});
