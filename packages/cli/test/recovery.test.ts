import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { main } from "../src/cli.ts";
import { MAX_TRANSITION_REPEATS } from "../src/commands/delivery.ts";
import { createWorld, type World } from "./harness.ts";

// Every case drives real git processes; a loaded CI runner exceeds bun's 5 s default.
setDefaultTimeout(30_000);

// Review M13: the consumer lifecycle's regression scenarios, ported to the standalone CLI on the
// published @comforge/github writer and @comforge/ledger: undone transitions (every one inside the
// synthetic GitHub's frozen second), bounded repeats, competing writers, a writer that died
// mid-send, lost answers, and stale specifications. No blind retry anywhere.

let world: World;
afterEach(() => world?.dispose());
const TICKET = "DEMO-001";

async function published(w: World) {
  const issue = w.specIssue(TICKET);
  const { checkout } = (await w.cli(["start", TICKET, "--issue", String(issue)])).json;
  w.commitFile(checkout, "src/widget.txt", "widget\n", `feat: widget\n\nTicket: ${TICKET}`);
  await w.cli(["verify", TICKET]);
  const pr = (await w.cli(["publish", TICKET, "--title", "W", "--execute"])).json.pullRequest
    .number as number;
  return { issue, checkout: checkout as string, pr };
}
const patches = (w: World) => w.gh.writes().filter((x) => x.method === "PATCH").length;
const posts = (w: World, suffix: string) =>
  w.gh.writes().filter((x) => x.method === "POST" && x.path.endsWith(suffix)).length;
const freeze = (w: World, pr: number) => {
  const p = w.gh.pulls.get(pr);
  if (p) p.updated_at = "2026-01-01T00:00:00Z";
};
const undo = (w: World, pr: number) => {
  const p = w.gh.pulls.get(pr);
  if (p) p.body = "someone else's edit";
  freeze(w, pr);
};

async function background(w: World, args: string[], fetchImpl: typeof fetch) {
  let out = "";
  const done = main(
    [...args, "--json"],
    { ...w.rt(), fetchImpl },
    {
      out: (t) => {
        out += t;
      },
      err: (t) => {
        out += t;
      },
    },
  ).then((code) => ({ code, json: JSON.parse(out) }));
  return done;
}

describe("undone transitions and bounded repeats", () => {
  test("A→B→A→B in one GitHub second: every transition is sent under a new identity, then refused past the bound", async () => {
    world = createWorld();
    const { pr } = await published(world);
    const composed = world.gh.pulls.get(pr)?.body;
    for (let n = 0; n <= MAX_TRANSITION_REPEATS; n++) {
      undo(world, pr);
      const before = patches(world);
      const r = await world.cli(["publish", TICKET, "--title", "W", "--execute"]);
      expect(r.code).toBe(0);
      expect(patches(world)).toBe(before + 1);
      expect(world.gh.pulls.get(pr)?.body).toContain("## DEMO-001");
    }
    undo(world, pr);
    const before = patches(world);
    const refused = await world.cli(["publish", TICKET, "--title", "W", "--execute"]);
    expect([refused.code, refused.json.error]).toEqual([3, "ambiguous"]);
    expect(patches(world)).toBe(before);
    expect(composed).toBeDefined();
  });

  test("an update refused as stale in a race is not a reason to refuse the same update later", async () => {
    world = createWorld();
    const { pr } = await published(world);
    undo(world, pr);
    // The CLI reads the old body; another edit lands before the writer's own precondition read.
    let reads = 0;
    const racing = (async (input: string | URL | Request, init?: RequestInit) => {
      const res = await world.gh.fetchImpl(input, init);
      if (
        (init?.method ?? "GET") === "GET" &&
        String(input).endsWith(`/pulls/${pr}`) &&
        ++reads === 1
      ) {
        const p = world.gh.pulls.get(pr);
        if (p) p.body = "a third edit";
        freeze(world, pr);
      }
      return res;
    }) as typeof fetch;
    const lost = await background(world, ["publish", TICKET, "--title", "W", "--execute"], racing);
    expect(lost.json.error).toBe("stale");
    undo(world, pr);
    const before = patches(world);
    const r = await world.cli(["publish", TICKET, "--title", "W", "--execute"]);
    expect(r.code).toBe(0);
    expect(patches(world)).toBe(before + 1);
  });

  test("an unchanged body sends nothing; a completion link already in the body survives a republish", async () => {
    world = createWorld();
    const { pr } = await published(world);
    const before = patches(world);
    expect((await world.cli(["publish", TICKET, "--title", "W", "--execute"])).code).toBe(0);
    expect(patches(world)).toBe(before);
    const p = world.gh.pulls.get(pr);
    if (p)
      p.body = `${p.body}\n\n<!-- comforge:completion-link-begin -->\nlink\n<!-- comforge:completion-link-end -->\n`;
    await world.cli(["publish", TICKET, "--title", "W", "--execute"]);
    expect(world.gh.pulls.get(pr)?.body).toContain("<!-- comforge:completion-link-begin -->\nlink");
  });
});

describe("competing writers and dead writers", () => {
  test("two concurrent deliveries create one pull request and one completion comment", async () => {
    world = createWorld();
    const issue = world.specIssue(TICKET);
    const { checkout } = (await world.cli(["start", TICKET, "--issue", String(issue)])).json;
    world.commitFile(checkout, "src/widget.txt", "widget\n", `feat: widget\n\nTicket: ${TICKET}`);
    await world.cli(["verify", TICKET]);
    const head = world.sh(checkout, "git", "rev-parse", "HEAD");
    const digest = (await world.cli(["status", TICKET])).json.specification.digest;
    const file = path.join(world.root, "result.json");
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
        validation: [{ gate: "unit", command: "sh check.sh", status: "PASS" }],
        limitations: [],
        nextSteps: [],
      }),
    );
    const args = ["deliver", TICKET, "--title", "W", "--result", file, "--execute"];
    const [a, b] = await Promise.all([
      background(world, args, world.gh.fetchImpl),
      background(world, args, world.gh.fetchImpl),
    ]);
    expect([a.code, b.code].sort()).toContain(0);
    expect(posts(world, "/pulls")).toBe(1);
    // The loser stopped (incomplete or refused); the same command then finishes without duplicates.
    const again = await world.cli(args);
    expect(again.json.delivery).toBe("complete");
    expect(posts(world, "/pulls")).toBe(1);
    expect([...world.gh.comments.values()].filter((c) => c.issue === issue)).toHaveLength(1);
  });

  test("a writer that died mid-PATCH: refused while its lease runs, then reconciled and sent once", async () => {
    world = createWorld();
    const { pr } = await published(world);
    undo(world, pr);
    let seen!: () => void;
    const arrived = new Promise<void>((r) => {
      seen = r;
    });
    const hanging = (async (input: string | URL | Request, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "PATCH") {
        seen();
        return new Promise<Response>(() => {});
      }
      return world.gh.fetchImpl(input, init);
    }) as typeof fetch;
    void background(world, ["publish", TICKET, "--title", "W", "--execute"], hanging); // the "dead" process
    await arrived;
    const before = patches(world);
    const inLease = await world.cli(["publish", TICKET, "--title", "W", "--execute"]);
    expect([inLease.code, inLease.json.error]).toEqual([1, "conflict"]);
    world.clock.now += 3 * 60_000;
    const held = await world.cli(["publish", TICKET, "--title", "W", "--execute"]);
    expect([held.code, held.json.error]).toEqual([3, "ambiguous"]);
    expect(patches(world)).toBe(before);
    // Reconciliation reads the target: the PATCH never applied, so the update may be sent again.
    await world.cli(["recover", TICKET, "--execute"]);
    const sent = await world.cli(["publish", TICKET, "--title", "W", "--execute"]);
    expect(sent.code).toBe(0);
    expect(patches(world)).toBe(before + 1);
    expect(world.gh.pulls.get(pr)?.body).toContain("## DEMO-001");
  });

  test("an answer lost after GitHub created the pull request is recovered with one POST", async () => {
    world = createWorld();
    const issue = world.specIssue(TICKET);
    const { checkout } = (await world.cli(["start", TICKET, "--issue", String(issue)])).json;
    world.commitFile(checkout, "a.txt", "a\n", `feat: a\n\nTicket: ${TICKET}`);
    await world.cli(["verify", TICKET]);
    world.gh.faults.push("network-after");
    const r = await world.cli(["publish", TICKET, "--title", "W", "--execute"]);
    expect(r.code).toBe(0);
    expect(posts(world, "/pulls")).toBe(1);
  });
});

describe("stale state is refused, never repaired by resending", () => {
  test("a specification edited after start refuses completion; a head moved after verify refuses publication", async () => {
    world = createWorld();
    const { issue, checkout, pr } = await published(world);
    const digest = (await world.cli(["status", TICKET])).json.specification.digest;
    const publishedHead = world.sh(checkout, "git", "rev-parse", "HEAD");
    world.commitFile(checkout, "b.txt", "b\n", `feat: b\n\nTicket: ${TICKET}`);
    expect((await world.cli(["publish", TICKET, "--title", "W", "--execute"])).json.error).toBe(
      "validation-missing",
    );
    const stored = world.gh.issues.get(issue);
    if (stored) stored.body = String(stored.body).replace("Build", "Rebuild");
    const file = path.join(world.root, "r.json");
    writeFileSync(
      file,
      JSON.stringify({
        contract: "acme-completion/v1",
        issueNumber: issue,
        ticketId: TICKET,
        specificationDigest: digest,
        issueType: "implementation",
        outcome: "completed",
        sourceRevision: publishedHead,
        pullRequest: { number: pr, headSha: publishedHead },
        execution: { runner: "test-agent", model: "m" },
        summary: "S.",
        sections: { changed_behavior: "B." },
        findings: [],
        changedArtifacts: [],
        evidence: [],
        validation: [{ gate: "u", command: "c", status: "PASS" }],
        limitations: [],
        nextSteps: [],
      }),
    );
    const r = await world.cli(["complete", "--result", file, "--execute"]);
    expect(r.code).toBe(1);
    expect(r.json.error).toBe("stale");
    expect([...world.gh.comments.values()].filter((c) => c.issue === issue)).toHaveLength(0);
  });
});
