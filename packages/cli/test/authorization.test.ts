import { afterEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { keyIdFor } from "@comforge/core";
import { main } from "../src/cli.ts";
import type { Runtime } from "../src/runtime.ts";
import { baseConfig, createWorld, type World } from "./harness.ts";

// Review M9: holding the CLI and a credential is not authority. Writes need an authorization
// the trusted base configuration names; candidate text cannot create one.

let world: World;
afterEach(() => world?.dispose());

const TICKET = "DEMO-001";
const credentials = { source: "env", variable: "ACME_TOKEN" };

function keyPair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  return {
    publicKeyPem,
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    keyId: keyIdFor(publicKeyPem),
  };
}

async function verifiedInitiative(w: World) {
  const issue = w.specIssue(TICKET);
  const { checkout } = (await w.cli(["start", TICKET, "--issue", String(issue)])).json;
  w.commitFile(checkout, "src/widget.txt", "widget\n", `feat: widget\n\nTicket: ${TICKET}`);
  expect((await w.cli(["verify", TICKET])).json.status).toBe("PASS");
  return { issue, checkout: checkout as string, head: w.sh(checkout, "git", "rev-parse", "HEAD") };
}

const writes = (w: World) => w.gh.writes().length;

describe("without an authorization in the trusted configuration", () => {
  test("every write is refused before any request; dry runs still plan", async () => {
    world = createWorld({ config: baseConfig({ security: { credentials } }) });
    await verifiedInitiative(world);
    const dry = await world.cli(["publish", TICKET, "--title", "W"]);
    expect(dry.json.plan.authorization).toBe("none: writes are refused");
    const live = await world.cli(["publish", TICKET, "--title", "W", "--execute"]);
    expect([live.code, live.json.error]).toEqual([1, "authorization-required"]);
    expect(writes(world)).toBe(0);
    expect(world.sh(world.remote, "git", "branch", "--list", "agent/*")).toBe("");
  });

  test("an uncommitted working copy cannot grant itself operator mode", async () => {
    world = createWorld({ config: baseConfig({ security: { credentials } }) });
    writeFileSync(
      path.join(world.primary, "comforge.config.json"),
      JSON.stringify(
        baseConfig({ security: { credentials, authorization: { mode: "operator" } } }),
      ),
    );
    await verifiedInitiative(world);
    expect((await world.cli(["publish", TICKET, "--title", "W", "--execute"])).json.error).toBe(
      "authorization-required",
    );
    expect(writes(world)).toBe(0);
  });

  test("a candidate commit that adds operator mode is refused as an untrusted change", async () => {
    world = createWorld({ config: baseConfig({ security: { credentials } }) });
    const { checkout } = await verifiedInitiative(world);
    const file = path.join(checkout, "comforge.config.json");
    const config = JSON.parse(readFileSync(file, "utf8"));
    config.security.authorization = { mode: "operator" };
    world.commitFile(
      checkout,
      "comforge.config.json",
      JSON.stringify(config),
      `chore: self-authorize\n\nTicket: ${TICKET}`,
    );
    await world.cli(["verify", TICKET]);
    const r = await world.cli(["publish", TICKET, "--title", "W", "--execute"]);
    expect([r.json.error, r.json.detail.sections]).toEqual([
      "untrusted-config-change",
      ["security"],
    ]);
    expect(writes(world)).toBe(0);
  });
});

describe("owner grants", () => {
  const owner = keyPair();
  const config = () =>
    baseConfig({
      security: {
        credentials,
        authorization: {
          mode: "owner-grant",
          grantScheme: "acme-grant/v1",
          trustedKeys: [{ keyId: owner.keyId, publicKeyPem: owner.publicKeyPem, label: "owner" }],
        },
      },
    });

  async function signed(
    w: World,
    edit: (g: Record<string, unknown>) => void = () => {},
    key = owner.privateKeyPem,
  ) {
    const template = (await w.cli(["grant", "template", TICKET])).json;
    edit(template);
    const grantFile = path.join(w.root, `grant-${Math.random().toString(36).slice(2)}.json`);
    const keyFile = path.join(w.root, "owner.pem");
    writeFileSync(grantFile, JSON.stringify(template));
    writeFileSync(keyFile, key);
    const envelope = (
      await w.cli(["grant", "sign", TICKET, "--grant", grantFile, "--key", keyFile])
    ).json;
    const out = path.join(w.root, `envelope-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(out, JSON.stringify(envelope));
    return out;
  }

  test("a missing, foreign-key, other-commit, other-repository or expired grant is refused with no write", async () => {
    world = createWorld({ config: config() });
    await verifiedInitiative(world);
    const run = (grant?: string) =>
      world.cli([
        "publish",
        TICKET,
        "--title",
        "W",
        "--execute",
        ...(grant ? ["--grant", grant] : []),
      ]);
    expect((await run()).json.error).toBe("authorization-required");
    const stranger = keyPair();
    for (const grant of [
      await signed(world, () => {}, stranger.privateKeyPem),
      await signed(world, (g) => {
        (g.publication as { candidateSha: string }).candidateSha = "f".repeat(40);
      }),
      await signed(world, (g) => {
        g.repository = "acme/other";
      }),
    ]) {
      const r = await run(grant);
      expect([r.code, r.json.error]).toEqual([1, "unauthorized"]);
    }
    const expiring = await signed(world);
    world.clock.now += 25 * 3_600_000;
    expect((await run(expiring)).json.message).toContain("expired");
    expect(writes(world)).toBe(0);
  });

  test("a valid grant authorizes exactly its commit; reuse past maxAttempts is refused as a replay", async () => {
    world = createWorld({ config: config() });
    await verifiedInitiative(world);
    const grant = await signed(world, (g) => {
      g.maxAttempts = 1;
    });
    const ok = await world.cli(["publish", TICKET, "--title", "W", "--execute", "--grant", grant]);
    expect([ok.code, ok.json.authorization.mode]).toEqual([0, "owner-grant"]);
    const again = await world.cli([
      "publish",
      TICKET,
      "--title",
      "W",
      "--execute",
      "--grant",
      grant,
    ]);
    expect([again.json.error, again.json.message]).toEqual([
      "unauthorized",
      "grant refused: its attempts are exhausted (replay refused)",
    ]);
    expect(world.gh.writes().filter((w) => w.method === "POST")).toHaveLength(1);
  });
});

describe("the assignment host adapter", () => {
  test("never runs gh without the pulls:assign capability, and the handoff does not demand it", async () => {
    world = createWorld({
      config: baseConfig({
        security: {
          credentials,
          authorization: { mode: "operator" },
          delivery: { assignee: "acme-owner" },
        },
      }),
    });
    await verifiedInitiative(world);
    const calls: string[] = [];
    const base = world.rt();
    const rt: Runtime = {
      ...base,
      run: (cmd, args, o) => {
        calls.push(cmd);
        return base.run(cmd, args, o);
      },
    };
    let out = "";
    const code = await main(["publish", TICKET, "--title", "W", "--execute", "--json"], rt, {
      out: (t) => {
        out += t;
      },
      err: (t) => {
        out += t;
      },
    });
    expect(code).toBe(0);
    expect(JSON.parse(out).handoff).toBe("ok");
    expect(calls).not.toContain("gh");
  });
});

// Review M15: every command with a remote side effect checks authorization before its first one.
// "Remote side effects" are: git push (publish, deliver), SDK pull.create / pull.update /
// issue.comment (publish, complete, deliver), gh assignment (publish). recover writes nothing
// remote (reconcile reads, abandon is local) but still needs a valid authorization.
describe("authorization precedes every remote side effect", () => {
  function resultFile(w: World, issue: number, head: string, digest: string) {
    const file = path.join(w.root, `result-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(
      file,
      JSON.stringify({
        contract: "acme-completion/v1",
        issueNumber: issue,
        ticketId: TICKET,
        specificationDigest: digest,
        issueType: "implementation",
        outcome: "completed",
        sourceRevision: head,
        execution: { runner: "test-agent", model: "m" },
        summary: "Done.",
        sections: { changed_behavior: "A widget." },
        findings: [],
        changedArtifacts: [],
        evidence: [],
        validation: [{ gate: "u", command: "c", status: "PASS" }],
        limitations: [],
        nextSteps: [],
      }),
    );
    return file;
  }
  const noRemoteEffect = (w: World) => {
    expect(w.gh.writes()).toEqual([]);
    expect(w.sh(w.remote, "git", "branch", "--list", "agent/*")).toBe("");
  };

  test("without authorization: publish, complete, deliver and recover all refuse with no remote effect", async () => {
    world = createWorld({ config: baseConfig({ security: { credentials } }) });
    const { issue, head } = await verifiedInitiative(world);
    const digest = (await world.cli(["status", TICKET])).json.specification.digest;
    const file = resultFile(world, issue, head, digest);
    for (const args of [
      ["publish", TICKET, "--title", "W", "--execute"],
      ["complete", "--result", file, "--execute"],
      ["deliver", TICKET, "--title", "W", "--result", file, "--execute"],
      ["recover", TICKET, "--execute"],
    ]) {
      const r = await world.cli(args);
      expect(r.code).not.toBe(0);
      // complete validates the result and reads the PR first (reads only); here it has no PR to name.
      if (args[0] !== "complete")
        expect(JSON.stringify(r.json)).toContain("authorization-required");
    }
    noRemoteEffect(world);
  });

  test("owner-grant: a grant for another ticket, an expired one or none refuses deliver, complete and recover with no remote effect", async () => {
    const owner = keyPair();
    world = createWorld({
      config: baseConfig({
        security: {
          credentials,
          authorization: {
            mode: "owner-grant",
            grantScheme: "acme-grant/v1",
            trustedKeys: [{ keyId: owner.keyId, publicKeyPem: owner.publicKeyPem, label: "owner" }],
          },
        },
      }),
    });
    const { issue, head } = await verifiedInitiative(world);
    const digest = (await world.cli(["status", TICKET])).json.specification.digest;
    const template = (await world.cli(["grant", "template", TICKET])).json;
    const sign = async (g: Record<string, unknown>) => {
      const gf = path.join(world.root, `g-${Math.random().toString(36).slice(2)}.json`);
      const kf = path.join(world.root, "k.pem");
      writeFileSync(gf, JSON.stringify(g));
      writeFileSync(kf, owner.privateKeyPem);
      const out = path.join(world.root, `e-${Math.random().toString(36).slice(2)}.json`);
      writeFileSync(
        out,
        JSON.stringify(
          (await world.cli(["grant", "sign", TICKET, "--grant", gf, "--key", kf])).json,
        ),
      );
      return out;
    };
    // A valid grant publishes; everything after it is checked against bad grants.
    const valid = await sign({ ...template, maxAttempts: 1 });
    const pr = (await world.cli(["publish", TICKET, "--title", "W", "--execute", "--grant", valid]))
      .json.pullRequest.number as number;
    const after = world.gh.writes().length;
    const file = path.join(world.root, "result-owner.json");
    writeFileSync(
      file,
      readFileSync(resultFile(world, issue, head, digest), "utf8").replace(
        '"outcome":"completed",',
        `"outcome":"completed","pullRequest":{"number":${pr},"headSha":"${head}"},`,
      ),
    );
    const otherTicket = await sign({
      ...template,
      ticket: "OTHER-002",
      publication: { ...template.publication, branch: "agent/other-002" },
    });
    const expired = await sign({
      ...template,
      issuedAt: new Date(world.clock.now - 3 * 3_600_000).toISOString(),
      expiresAt: new Date(world.clock.now - 3_600_000).toISOString(),
    });
    for (const grant of [otherTicket, expired, valid, null])
      for (const args of [
        ["deliver", TICKET, "--title", "W", "--result", file, "--execute"],
        ["complete", "--result", file, "--execute"],
        ["recover", TICKET, "--execute"],
      ]) {
        const r = await world.cli([...args, ...(grant ? ["--grant", grant] : [])]);
        // recover verifies the grant but spends no attempt, so the spent valid grant still recovers.
        if (args[0] === "recover" && grant === valid) expect(r.code).toBe(0);
        else expect(JSON.stringify(r.json)).toMatch(/unauthorized|authorization-required/);
      }
    expect(world.gh.writes().length).toBe(after);
    expect([...world.gh.comments.values()].filter((c) => c.issue === issue)).toHaveLength(0);
  });

  test("running the CLI from inside the candidate checkout finds no initiative and writes nothing", async () => {
    world = createWorld();
    const { checkout } = await verifiedInitiative(world);
    const r = await world.cli(["publish", TICKET, "--title", "W", "--execute"], checkout);
    expect([r.code, r.json.error]).toEqual([1, "not-found"]);
    noRemoteEffect(world);
  });
});
