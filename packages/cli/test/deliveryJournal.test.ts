import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { main } from "../src/cli.ts";
import { openContext } from "../src/context.ts";
import { createWorld, type World } from "./harness.ts";

// R7: every deliver --execute leaves an attempt record, and a delivery is complete only when
// GitHub reads back as published.

let world: World;
afterEach(() => world?.dispose());
const TICKET = "DEMO-001";

async function ready(w: World) {
  const issue = w.specIssue(TICKET);
  const { checkout } = (await w.cli(["start", TICKET, "--issue", String(issue)])).json;
  w.commitFile(checkout, "a.txt", "a\n", `feat: a\n\nTicket: ${TICKET}`);
  await w.cli(["verify", TICKET]);
  const head = w.sh(checkout, "git", "rev-parse", "HEAD");
  const file = path.join(w.root, "result.json");
  writeFileSync(
    file,
    JSON.stringify({
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
    }),
  );
  return { issue, head, args: ["deliver", TICKET, "--title", "A", "--result", file, "--execute"] };
}

const attempts = async (w: World) => (await w.cli(["status", TICKET])).json;

async function deliverWith(w: World, args: string[], fetchImpl: typeof fetch) {
  let out = "";
  const code = await main(
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
  );
  return { code, json: JSON.parse(out) };
}

describe("R7: delivery attempts and read-back", () => {
  test("a complete delivery records its attempt and stages, read back from GitHub", async () => {
    world = createWorld();
    const { args } = await ready(world);
    const r = await world.cli(args);
    expect([r.code, r.json.delivery, r.json.attempt]).toEqual([0, "complete", 1]);
    expect(r.json.stages.read_back).toMatchObject({
      integrity: "verified",
      current: true,
      pullRequest: { linked: true, draft: false },
    });
    const ctx = openContext(world.rt());
    const record = await ctx.state.get(TICKET);
    expect(record?.deliveries).toEqual([
      expect.objectContaining({
        attempt: 1,
        outcome: "complete",
        stages: ["publish", "completion", "read_back"],
        failedStage: null,
      }),
    ]);
  });

  test("an unresolved write is uncertain, never a clean stop; recovery then completes in a later attempt", async () => {
    world = createWorld();
    const { issue, args } = await ready(world);
    let failed = false;
    // The comment POST fails with a server error once: it may or may not have been stored.
    const failing = (async (input: string | URL | Request, init?: RequestInit) => {
      if (
        (init?.method ?? "GET") === "POST" &&
        String(input).includes(`/issues/${issue}/comments`) &&
        !failed
      ) {
        failed = true;
        return new Response(JSON.stringify({ message: "Server Error" }), { status: 500 });
      }
      return world.gh.fetchImpl(input, init);
    }) as typeof fetch;
    const first = await deliverWith(world, args, failing);
    expect([first.code, first.json.failedStage]).toEqual([4, "completion"]);
    // A complete search finds no copy, so the write is given up explicitly; then it is sent once.
    expect((await world.cli(["recover", TICKET, "--abandon", "--execute"])).code).toBe(0);
    const done = await world.cli(args);
    expect([done.code, done.json.delivery, done.json.attempt]).toEqual([0, "complete", 2]);
    expect([...world.gh.comments.values()].filter((c) => c.issue === issue)).toHaveLength(1);
    const record = await openContext(world.rt()).state.get(TICKET);
    expect(record?.deliveries?.map((d) => [d.attempt, d.outcome, d.failedStage])).toEqual([
      [1, "uncertain", "completion"],
      [2, "complete", null],
    ]);
  });

  test("an attempt left running by a dead process is marked uncertain by the next one", async () => {
    world = createWorld();
    const { head, args } = await ready(world);
    await openContext(world.rt()).state.update(TICKET, (r) => {
      r.deliveries = [
        {
          attempt: 1,
          head,
          startedAt: "2026-11-26T00:00:00.000Z",
          finishedAt: null,
          outcome: "running",
          stages: ["publish"],
          failedStage: null,
        },
      ];
    });
    expect((await world.cli(args)).json.attempt).toBe(2);
    const record = await openContext(world.rt()).state.get(TICKET);
    expect(record?.deliveries?.map((d) => d.outcome)).toEqual(["uncertain", "complete"]);
  });

  test("a record GitHub does not show afterwards makes the delivery incomplete at read_back", async () => {
    world = createWorld();
    const { issue, args } = await ready(world);
    world.gh.readOverrides.push((p) =>
      p.endsWith(`/issues/${issue}/comments`)
        ? new Response("[]", { status: 200, headers: { "content-type": "application/json" } })
        : undefined,
    );
    const r = await world.cli(args);
    expect([r.code, r.json.delivery, r.json.failedStage]).toEqual([4, "incomplete", "read_back"]);
    expect(r.json.error.detail.problems[0]).toContain("is not on");
    const record = await openContext(world.rt()).state.get(TICKET);
    expect(record?.deliveries?.at(-1)).toMatchObject({
      outcome: "incomplete",
      failedStage: "read_back",
    });
  });
});
