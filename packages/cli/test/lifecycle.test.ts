import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createWorld, TOKEN, type World } from "./harness.ts";

// The full governed lifecycle against a real Git remote and a synthetic GitHub.

let world: World;
afterEach(() => world?.dispose());

const TICKET = "DEMO-001";

async function started(w: World, id = TICKET) {
  const issue = w.specIssue(id.split(".")[0] as string);
  const r = await w.cli(["start", id, "--issue", String(issue)]);
  expect(r.code).toBe(0);
  return { issue, checkout: r.json.checkout as string };
}

function resultFile(w: World, fields: Record<string, unknown>) {
  const file = path.join(w.root, `result-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(file, JSON.stringify(fields));
  return file;
}

function implementationResult(_w: World, issue: number, head: string, digest: string, pr?: number) {
  return {
    contract: "acme-completion/v1",
    issueNumber: issue,
    ticketId: TICKET,
    specificationDigest: digest,
    issueType: "implementation",
    outcome: "completed",
    sourceRevision: head,
    ...(pr ? { pullRequest: { number: pr, headSha: head } } : {}),
    execution: { runner: "test-agent", model: "test-model" },
    summary: "Implemented the widget.",
    sections: { changed_behavior: "The widget exists." },
    findings: [],
    changedArtifacts: [],
    evidence: [],
    validation: [{ gate: "unit", command: "sh check.sh", status: "PASS" }],
    limitations: [],
    nextSteps: [],
  };
}

describe("C1: start, verify, status (no GitHub writes)", () => {
  test("start verifies the specification and creates an isolated checkout on the initiative branch", async () => {
    world = createWorld();
    const { issue, checkout } = await started(world);
    expect(existsSync(path.join(checkout, "check.sh"))).toBe(true);
    expect(world.sh(checkout, "git", "rev-parse", "--abbrev-ref", "HEAD")).toBe("agent/demo-001");
    expect(world.sh(checkout, "git", "remote", "get-url", "origin")).toBe(world.remote);
    const status = await world.cli(["status", TICKET]);
    expect(status.json).toMatchObject({
      initiative: TICKET,
      stage: "started",
      specification: { issueNumber: issue },
    });
    expect(world.gh.writes()).toHaveLength(0);
    // A second start is refused; nothing is overwritten.
    expect((await world.cli(["start", TICKET, "--issue", String(issue)])).json.error).toBe(
      "conflict",
    );
  });

  test("an edited or foreign specification is refused before anything is created", async () => {
    world = createWorld();
    const issue = world.specIssue(TICKET);
    const stored = world.gh.issues.get(issue);
    if (stored) stored.body = String(stored.body).replace("Build", "Rebuild");
    const edited = await world.cli(["start", TICKET, "--issue", String(issue)]);
    expect([edited.code, edited.json.error]).toEqual([1, "stale"]);
    const other = world.specIssue("OTHER-002");
    expect((await world.cli(["start", TICKET, "--issue", String(other)])).json.error).toBe(
      "conflict",
    );
    expect((await world.cli(["start", TICKET])).json.error).toBe("specification-invalid");
    expect(existsSync(path.join(world.root, "widgets-agents", "demo-001"))).toBe(false);
  });

  test("verify records PASS for the exact clean head, FAIL for a failing command, and refuses dirt and missing trailers", async () => {
    world = createWorld();
    const { checkout } = await started(world);
    world.commitFile(checkout, "src/widget.txt", "widget\n", `feat: widget\n\nTicket: ${TICKET}`);
    const pass = await world.cli(["verify", TICKET]);
    expect([pass.code, pass.json.status]).toEqual([0, "PASS"]);
    expect(pass.json.commit).toBe(world.sh(checkout, "git", "rev-parse", "HEAD"));
    writeFileSync(path.join(checkout, "scratch.txt"), "x");
    expect((await world.cli(["verify", TICKET])).json.error).toBe("dirty-checkout");
    world.sh(checkout, "rm", "scratch.txt");
    world.commitFile(checkout, "src/other.txt", "x\n", "chore: no trailer");
    const trailer = await world.cli(["verify", TICKET]);
    expect([trailer.code, trailer.json.error]).toEqual([1, "policy-denied"]);
    world.sh(checkout, "git", "reset", "--quiet", "--hard", "HEAD~1");
    // Validation is the trusted base's command; a candidate edit of check.sh still runs, and fails.
    world.commitFile(
      checkout,
      "check.sh",
      "#!/bin/sh\nexit 3\n",
      `test: break\n\nTicket: ${TICKET}`,
    );
    const fail = await world.cli(["verify", TICKET]);
    expect([fail.code, fail.json.status]).toEqual([1, "FAIL"]);
    expect(fail.json.commands[0]).toMatchObject({ name: "check", exitStatus: 3 });
  });

  test("validation never sees the GitHub credential or the developer's gh login", async () => {
    world = createWorld();
    const { checkout } = await started(world);
    const probe = path.join(world.root, "env.txt");
    world.commitFile(
      checkout,
      "check.sh",
      `#!/bin/sh\nenv > ${probe}\n`,
      `test: probe\n\nTicket: ${TICKET}`,
    );
    const r = await world.cli(["verify", TICKET]);
    expect(r.code).toBe(0);
    const seen = readFileSync(probe, "utf8");
    expect(seen).not.toContain(TOKEN);
    expect(seen).not.toMatch(/^(ACME_TOKEN|GITHUB_TOKEN|GH_TOKEN)=/m);
    expect(seen).toMatch(/^GH_CONFIG_DIR=/m);
  });
});

describe("C2: publish, complete, deliver, cleanup", () => {
  test("publish refuses an unvalidated head, then creates exactly one pull request; a rerun changes nothing", async () => {
    world = createWorld();
    const { checkout } = await started(world);
    world.commitFile(checkout, "src/widget.txt", "widget\n", `feat: widget\n\nTicket: ${TICKET}`);
    expect(
      (await world.cli(["publish", TICKET, "--title", "Widget", "--execute"])).json.error,
    ).toBe("validation-missing");
    await world.cli(["verify", TICKET]);
    const dry = await world.cli(["publish", TICKET, "--title", "Widget"]);
    expect(dry.json).toMatchObject({
      executed: false,
      plan: { push: "create-branch", pullRequest: { action: "create" } },
    });
    expect(world.gh.writes()).toHaveLength(0);
    const live = await world.cli(["publish", TICKET, "--title", "Widget", "--execute"]);
    expect(live.code).toBe(0);
    const head = world.sh(checkout, "git", "rev-parse", "HEAD");
    expect(world.sh(world.remote, "git", "rev-parse", "refs/heads/agent/demo-001")).toBe(head);
    expect(live.json.pullRequest).toMatchObject({ headSha: head, draft: false });
    const again = await world.cli(["publish", TICKET, "--title", "Widget", "--execute"]);
    expect(again.json.plan).toMatchObject({
      push: "up-to-date",
      pullRequest: { action: "update" },
    });
    expect(world.gh.writes().filter((w) => w.method === "POST")).toHaveLength(1);
  });

  test("a candidate that changes trusted configuration is refused for publication", async () => {
    world = createWorld();
    const { checkout } = await started(world);
    const config = JSON.parse(readFileSync(path.join(checkout, "comforge.config.json"), "utf8"));
    config.validation.commands = [{ name: "check", run: ["true"] }];
    world.commitFile(
      checkout,
      "comforge.config.json",
      JSON.stringify(config),
      `chore: weaken\n\nTicket: ${TICKET}`,
    );
    await world.cli(["verify", TICKET]);
    const r = await world.cli(["publish", TICKET, "--title", "Weaken", "--execute"]);
    expect([r.code, r.json.error, r.json.detail.sections]).toEqual([
      1,
      "untrusted-config-change",
      ["validation"],
    ]);
    expect(world.gh.writes()).toHaveLength(0);
  });

  test("deliver publishes, completes once, links the PR; a rerun replays; cleanup waits for the merge", async () => {
    world = createWorld();
    const { issue, checkout } = await started(world);
    world.commitFile(checkout, "src/widget.txt", "widget\n", `feat: widget\n\nTicket: ${TICKET}`);
    await world.cli(["verify", TICKET]);
    const head = world.sh(checkout, "git", "rev-parse", "HEAD");
    const digest = (await world.cli(["status", TICKET])).json.specification.digest;
    const file = resultFile(world, implementationResult(world, issue, head, digest));
    const dry = await world.cli(["deliver", TICKET, "--title", "Widget", "--result", file]);
    expect(dry.json).toMatchObject({ executed: false, delivery: "planned" });
    const live = await world.cli([
      "deliver",
      TICKET,
      "--title",
      "Widget",
      "--result",
      file,
      "--execute",
    ]);
    expect([live.code, live.json.delivery]).toEqual([0, "complete"]);
    const pr = live.json.pullRequest as number;
    const comments = [...world.gh.comments.values()].filter((c) => c.issue === issue);
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("acme-lifecycle:completion v1");
    expect(world.gh.pulls.get(pr)?.body).toContain("comforge:completion-link-begin");
    const rerun = await world.cli([
      "deliver",
      TICKET,
      "--title",
      "Widget",
      "--result",
      file,
      "--execute",
    ]);
    expect(rerun.code).toBe(0);
    expect([...world.gh.comments.values()].filter((c) => c.issue === issue)).toHaveLength(1);
    expect((await world.cli(["status", TICKET])).json.stage).toBe("completed");

    expect((await world.cli(["cleanup", String(pr), "--execute"])).json.error).toBe(
      "policy-denied",
    );
    const pull = world.gh.pulls.get(pr);
    if (pull)
      Object.assign(pull, { state: "closed", merged: true, merged_at: "2026-01-02T00:00:00Z" });
    // The merge reaches the base branch (here a fast-forward); cleanup proves that first.
    world.sh(world.remote, "git", "update-ref", "refs/heads/main", head);
    const plan = await world.cli(["cleanup", String(pr)]);
    expect(plan.json).toMatchObject({
      executed: false,
      actions: [`remove ${checkout}`, "mark the initiative cleaned"],
    });
    expect(existsSync(checkout)).toBe(true);
    expect((await world.cli(["cleanup", String(pr), "--execute"])).code).toBe(0);
    expect(existsSync(checkout)).toBe(false);
    expect((await world.cli(["status", TICKET])).json.stage).toBe("cleaned");
  });

  test("an interrupted delivery exits 4 and the same command finishes it without a duplicate", async () => {
    world = createWorld();
    const { issue, checkout } = await started(world);
    world.commitFile(checkout, "src/widget.txt", "widget\n", `feat: widget\n\nTicket: ${TICKET}`);
    await world.cli(["verify", TICKET]);
    const head = world.sh(checkout, "git", "rev-parse", "HEAD");
    const digest = (await world.cli(["status", TICKET])).json.specification.digest;
    const file = resultFile(world, implementationResult(world, issue, head, digest));
    let posts = 0;
    world.gh.beforeWrite.push(() => undefined);
    const originalFetch = world.gh.fetchImpl;
    world.gh.readOverrides.push(() => undefined);
    // Fail the completion comment's POST once (after the PR was created).
    const failing = (async (input: string | URL | Request, init?: RequestInit) => {
      if (
        (init?.method ?? "GET") === "POST" &&
        String(input).includes(`/issues/${issue}/comments`) &&
        posts++ === 0
      )
        return new Response(JSON.stringify({ message: "Server Error" }), { status: 500 });
      return originalFetch(input, init);
    }) as typeof fetch;
    const rt = world.rt();
    const { main } = await import("../src/cli.ts");
    let out = "";
    const code = await main(
      ["deliver", TICKET, "--title", "Widget", "--result", file, "--execute", "--json"],
      { ...rt, fetchImpl: failing },
      {
        out: (t) => {
          out += t;
        },
        err: (t) => {
          out += t;
        },
      },
    );
    expect(code).toBe(4);
    expect(JSON.parse(out)).toMatchObject({ delivery: "incomplete", failedStage: "completion" });
    // The comment may have landed: the same command answers from the ledger and sends nothing.
    const held = await world.cli([
      "deliver",
      TICKET,
      "--title",
      "Widget",
      "--result",
      file,
      "--execute",
    ]);
    expect([held.code, held.json.error?.code]).toEqual([4, "ambiguous"]);
    const reconciled = await world.cli(["recover", TICKET, "--execute"]);
    expect([reconciled.code, reconciled.json.reconciled[0].status]).toEqual([4, "indeterminate"]);
    const abandoned = await world.cli(["recover", TICKET, "--abandon", "--execute"]);
    expect([abandoned.code, abandoned.json.reconciled[0].status]).toEqual([0, "abandoned"]);
    const done = await world.cli([
      "deliver",
      TICKET,
      "--title",
      "Widget",
      "--result",
      file,
      "--execute",
    ]);
    expect([done.code, done.json.delivery]).toEqual([0, "complete"]);
    expect([...world.gh.comments.values()].filter((c) => c.issue === issue)).toHaveLength(1);
    expect(
      world.gh.writes().filter((w) => w.method === "POST" && w.path.endsWith("/pulls")),
    ).toHaveLength(1);
  });

  test("no credential is ever written to local state, the ledger or any output", async () => {
    world = createWorld();
    const { issue, checkout } = await started(world);
    world.commitFile(checkout, "src/widget.txt", "widget\n", `feat: widget\n\nTicket: ${TICKET}`);
    await world.cli(["verify", TICKET]);
    const head = world.sh(checkout, "git", "rev-parse", "HEAD");
    const digest = (await world.cli(["status", TICKET])).json.specification.digest;
    const outputs = [
      await world.cli([
        "deliver",
        TICKET,
        "--title",
        "Widget",
        "--result",
        resultFile(world, implementationResult(world, issue, head, digest)),
        "--execute",
      ]),
      await world.cli(["status", TICKET]),
      await world.cli(["recover", TICKET]),
    ];
    for (const o of outputs) expect(o.out + o.err).not.toContain(TOKEN);
    const state = path.join(world.primary, ".git", "comforge");
    const files = readdirSync(state, { recursive: true })
      .map(String)
      .filter((f) => statSync(path.join(state, f)).isFile());
    expect(files.length).toBeGreaterThan(3);
    for (const f of files) expect(readFileSync(path.join(state, f), "utf8")).not.toContain(TOKEN);
  });
});
