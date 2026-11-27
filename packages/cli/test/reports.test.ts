import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { assertCompletionLinkUnambiguous, withCompletionLink } from "../src/commands/delivery.ts";
import { baseConfig, createWorld, type World } from "./harness.ts";

// R2: reports delivered as their own pull request, and identity filled from the initiative.
// R3: the completion-link block in the configured namespace, never duplicated.

let world: World;
afterEach(() => world?.dispose());
const TICKET = "DEMO-001";

function resultFile(w: World, fields: Record<string, unknown>) {
  const file = path.join(w.root, `result-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(file, JSON.stringify(fields));
  return file;
}

/** A started, committed and verified initiative whose head is ready to deliver. */
async function ready(w: World) {
  const issue = w.specIssue(TICKET);
  const { checkout } = (await w.cli(["start", TICKET, "--issue", String(issue)])).json;
  w.commitFile(
    checkout,
    "docs/comforge/report.md",
    "# Report\n",
    `docs: report\n\nTicket: ${TICKET}`,
  );
  expect((await w.cli(["verify", TICKET])).code).toBe(0);
  const head = w.sh(checkout, "git", "rev-parse", "HEAD");
  const digest = (await w.cli(["status", TICKET])).json.specification.digest as string;
  return { issue, checkout, head, digest };
}

const audit = (head: string, extra: Record<string, unknown> = {}) => ({
  contract: "acme-completion/v1",
  issueType: "audit",
  outcome: "completed",
  sourceRevision: head,
  execution: { runner: "test-agent", model: "test-model" },
  summary: "Audited the widget; delivered as its own pull request.",
  sections: { verdict: "Go.", recommendations: "None." },
  findings: [],
  changedArtifacts: [],
  evidence: [],
  validation: [{ gate: "unit", command: "sh check.sh", status: "PASS" }],
  limitations: [],
  nextSteps: [],
  ...extra,
});

const deliver = (w: World, file: string, execute = true) =>
  w.cli([
    "deliver",
    TICKET,
    "--title",
    "Audit",
    "--result",
    file,
    ...(execute ? ["--execute"] : []),
  ]);

describe("R2: report pull requests and identity", () => {
  test("a report with the configured reason is delivered; identity comes from the initiative", async () => {
    world = createWorld({
      config: baseConfig({
        publication: {
          reportPullRequestReason: "PR-first report: the evidence is reviewed as a PR",
        },
      }),
    });
    const { issue, head } = await ready(world);
    // No issueNumber, ticketId or specificationDigest: filled from the initiative.
    const live = await deliver(world, resultFile(world, audit(head)));
    expect([live.code, live.json.delivery]).toEqual([0, "complete"]);
    const comment = [...world.gh.comments.values()].find((c) => c.issue === issue);
    expect(comment?.body).toContain("requested: PR-first report: the evidence is reviewed as a PR");
  });

  test("the result's own reason wins over the configured one", async () => {
    world = createWorld({
      config: baseConfig({ publication: { reportPullRequestReason: "configured" } }),
    });
    const { issue, head } = await ready(world);
    const file = resultFile(
      world,
      audit(head, {
        pullRequest: { number: 1, headSha: head, reason: "the owner asked for a PR" },
      }),
    );
    expect((await deliver(world, file)).json.delivery).toBe("complete");
    const comment = [...world.gh.comments.values()].find((c) => c.issue === issue);
    expect(comment?.body).toContain("requested: the owner asked for a PR");
  });

  test("without any reason a report PR is refused before any write", async () => {
    world = createWorld();
    const { head } = await ready(world);
    const file = resultFile(world, audit(head));
    const dry = await deliver(world, file, false);
    expect([dry.code, dry.json.error]).toEqual([1, "policy-denied"]);
    const live = await deliver(world, file);
    expect(live.json.delivery ?? live.json.error).not.toBe("complete");
    expect(world.gh.writes()).toHaveLength(0);
  });

  test("a result naming another issue, ticket or digest is refused", async () => {
    world = createWorld({ config: baseConfig({ publication: { reportPullRequestReason: "r" } }) });
    const { issue, head } = await ready(world);
    for (const wrong of [
      { issueNumber: issue + 100 },
      { ticketId: "OTHER-001" },
      { specificationDigest: "e".repeat(64) },
    ]) {
      const r = await deliver(world, resultFile(world, audit(head, wrong)), false);
      expect([r.code, r.json.error]).toEqual([1, "conflict"]);
    }
    expect(world.gh.writes()).toHaveLength(0);
  });
});

describe("R3: the completion-link block", () => {
  const link = {
    issueNumber: 7,
    url: "https://github.com/acme/widgets/issues/7#issuecomment-1",
    headSha: "a".repeat(40),
  };

  test("an existing block in the configured namespace is replaced in place; other text is kept", () => {
    const body = [
      "Intro",
      "",
      "<!-- acme-lifecycle:completion-link-begin -->",
      "old",
      "<!-- acme-lifecycle:completion-link-end -->",
      "",
      "Outro",
    ].join("\n");
    const next = withCompletionLink(body, link, "acme-lifecycle");
    expect(next.match(/## Issue completion/g)).toHaveLength(1);
    expect(next.startsWith("Intro\n\n")).toBe(true);
    expect(next.endsWith("\n\nOutro")).toBe(true);
    expect(next).not.toContain("old");
    // Idempotent.
    expect(withCompletionLink(next, link, "acme-lifecycle")).toBe(next);
  });

  test("0.1.0 behaviour is the default namespace", () => {
    expect(withCompletionLink("Body", link)).toContain("<!-- comforge:completion-link-begin -->");
  });

  test("ambiguous bodies are refused: a duplicate, a lone marker, reversed markers, two namespaces", () => {
    const b = "<!-- acme-lifecycle:completion-link-begin -->";
    const e = "<!-- acme-lifecycle:completion-link-end -->";
    for (const body of [
      `${b}${e}${b}${e}`,
      `${b} only`,
      `${e}${b}`,
      `${b}${e}<!-- comforge:completion-link-begin --><!-- comforge:completion-link-end -->`,
    ])
      expect(() => assertCompletionLinkUnambiguous(body, "acme-lifecycle")).toThrow();
  });

  test("delivery links once in the configured namespace and refuses a malformed body before commenting", async () => {
    world = createWorld({
      config: baseConfig({ publication: { linkMarkerNamespace: "acme-lifecycle" } }),
    });
    const { issue, head, digest } = await ready(world);
    const impl = {
      ...audit(head),
      issueType: "implementation",
      sections: { changed_behavior: "The widget exists." },
      summary: "Implemented the widget.",
    };
    const live = await deliver(world, resultFile(world, impl));
    expect(live.json.delivery).toBe("complete");
    const pr = live.json.pullRequest as number;
    const body = world.gh.pulls.get(pr)?.body ?? "";
    expect(body.match(/acme-lifecycle:completion-link-begin/g)).toHaveLength(1);
    expect(body).not.toContain("comforge:completion-link-begin");

    // A person duplicated the block: completion refuses before posting anything new.
    const pull = world.gh.pulls.get(pr);
    if (pull) pull.body = `${body}\n${body}`;
    const commentsBefore = [...world.gh.comments.values()].filter((c) => c.issue === issue).length;
    // Standalone complete names its issue, ticket and digest itself (deliver fills them).
    const changed = resultFile(world, {
      ...impl,
      issueNumber: issue,
      ticketId: TICKET,
      specificationDigest: digest,
      summary: "Implemented the widget, again.",
      pullRequest: { number: pr, headSha: head },
    });
    const r = await world.cli(["complete", "--result", changed, "--execute"]);
    expect([r.code, r.json.error]).toEqual([1, "conflict"]);
    expect([...world.gh.comments.values()].filter((c) => c.issue === issue)).toHaveLength(
      commentsBefore,
    );
  });
});
