import { afterEach, describe, expect, test } from "bun:test";
import { TOOL_NAMES } from "../src/contracts.ts";
import { discoverableTools } from "../src/server.ts";
import { connect, createWorld, principal, TOKEN, type World } from "./harness.ts";

let world: World;
afterEach(() => world?.dispose());

const READ = [
  "comforge_capabilities",
  "comforge_context",
  "comforge_status",
  "comforge_evidence",
  "comforge_issue",
  "comforge_pr",
  "comforge_prs",
  "comforge_comments",
  "comforge_reviews",
  "comforge_artifact",
];

describe("discovery is filtered by profile and transport", () => {
  test("each profile discovers exactly its tools, and HTTP without isolation never lists an executing tool", async () => {
    world = createWorld();
    const listed = async (
      profiles: Parameters<typeof principal>[0],
      transport: "stdio" | "http" = "stdio",
    ) => {
      const s = await connect({
        repositories: [world.binding],
        host: world.host(),
        principal: principal(profiles),
        transport,
      });
      const names = (await s.client.listTools()).tools.map((t) => t.name).sort();
      await s.close();
      return names;
    };
    expect(await listed(["read-only"])).toEqual([...READ].sort());
    // Publishing an advisory review is the reviewer's alone; it runs no repository command.
    expect(await listed(["reviewer"])).toEqual([...READ, "comforge_publish_review"].sort());
    expect(await listed(["executor"])).toEqual(
      [...READ, "comforge_start", "comforge_revise", "comforge_verify"].sort(),
    );
    expect(await listed(["publisher"])).toEqual(
      [
        ...READ,
        "comforge_deliver",
        "comforge_recover",
        "comforge_cleanup",
        "comforge_publish_specification",
      ].sort(),
    );
    const allButReview = TOOL_NAMES.filter((n) => n !== "comforge_publish_review");
    expect(await listed(["executor", "publisher"])).toEqual([...allButReview].sort());
    // Remote publication is not remote execution: without isolation HTTP keeps the publication
    // tool that runs no repository command, and drops every executing one.
    expect(await listed(["executor", "publisher"], "http")).toEqual(
      [...READ, "comforge_publish_specification"].sort(),
    );
    const isolated = discoverableTools(principal(["executor", "publisher"]), "http", {
      id: "vm",
      runtime: () => world.rt(),
    });
    expect(isolated.sort()).toEqual([...allButReview].sort());
  });

  test("a tool outside the profile cannot be called even by name", async () => {
    world = createWorld();
    const s = await connect({
      repositories: [world.binding],
      host: world.host(),
      principal: principal(["read-only"]),
      transport: "stdio",
    });
    const r = await s.call("comforge_start", { repository: "widgets", initiative: "ACME-1" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("comforge_start");
    await s.close();
  });
});

describe("strict inputs and the repository allowlist", () => {
  test("a forged internal option, a path or a credential field is refused before any handler runs", async () => {
    world = createWorld();
    const s = await connect({
      repositories: [world.binding],
      host: world.host(),
      principal: principal(["executor", "publisher"]),
      transport: "stdio",
    });
    for (const forged of [
      { repository: "widgets", authorized: true },
      { repository: "widgets", root: "/etc" },
      { repository: "widgets", token: "x" },
      { repository: "/tmp/elsewhere" },
      { repository: "https://example.invalid/repo" },
    ]) {
      const r = await s.call("comforge_status", forged);
      expect(r.isError).toBe(true);
    }
    const deliver = await s.call("comforge_deliver", {
      repository: "widgets",
      initiative: "ACME-1",
      title: "t",
      result: {},
      execute: true,
      authorized: { mode: "operator" },
    });
    expect(deliver.isError).toBe(true);
    expect(world.gh.writes()).toHaveLength(0);
    await s.close();
  });

  test("an unknown repository and a repository outside the principal's allowlist get the same refusal", async () => {
    world = createWorld();
    const other = { ...world.binding, id: "other" };
    const s = await connect({
      repositories: [world.binding, other],
      host: world.host(),
      principal: principal(["read-only"], ["widgets"]),
      transport: "stdio",
    });
    const unknown = await s.call("comforge_status", { repository: "nope" });
    const foreign = await s.call("comforge_status", { repository: "other" });
    expect(unknown.body.code).toBe("unknown-repository");
    expect(foreign.body.code).toBe("unknown-repository");
    expect(foreign.body.message.replace("other", "X")).toBe(
      unknown.body.message.replace("nope", "X"),
    );
    await s.close();
  });

  test("a trusted configuration that names another repository is refused", async () => {
    world = createWorld();
    const s = await connect({
      repositories: [{ ...world.binding, owner: "someone-else" }],
      host: world.host(),
      principal: principal(["read-only"]),
      transport: "stdio",
    });
    const r = await s.call("comforge_issue", { repository: "widgets", number: 1 });
    expect(r.body.code).toBe("repository-mismatch");
    await s.close();
  });
});

describe("capabilities", () => {
  test("reports profiles, repositories, execution, and how cleanup is authorized", async () => {
    world = createWorld();
    const s = await connect({
      repositories: [world.binding],
      host: world.host(),
      principal: principal(["publisher"]),
      transport: "http",
    });
    const r = await s.call("comforge_capabilities");
    expect(r.isError).toBe(false);
    expect(r.body.schema).toBe("comforge-mcp/v1");
    expect(r.body.data.repositories).toEqual(["widgets"]);
    expect(r.body.data.execution.available).toBe(false);
    expect(r.body.data.cleanup).toMatchObject({ plan: true, execute: true });
    expect(r.body.data.cleanup.authorization).toContain("a publication grant never authorizes it");
    expect(r.body.data.never).toContain("merge");
    expect(r.body.data.never).toContain("run an arbitrary shell command");
    expect(r.structured).toEqual(r.body);
    await s.close();
  });
});

describe("reads", () => {
  test("an issue carries its specification verification, as untrusted text, without the credential", async () => {
    world = createWorld();
    const n = world.specIssue("ACME-1");
    const s = await connect({
      repositories: [world.binding],
      host: world.host(),
      principal: principal(["read-only"]),
      transport: "stdio",
    });
    const r = await s.call("comforge_issue", { repository: "widgets", number: n });
    expect(r.isError).toBe(false);
    expect(r.body.data.verified).toBe(true);
    expect(r.body.data.specification.ticketId).toBe("ACME-1");
    expect(r.body.data.issue.body.trust).toBe("untrusted");
    expect(r.text).not.toContain(TOKEN);
    expect(world.gh.requests.every((q) => q.method === "GET")).toBe(true);
    await s.close();
  });

  test("a pull request shows checks, paginated files and native reviews, never an advisory review as one", async () => {
    world = createWorld();
    const sha = "c".repeat(40);
    const pr = world.gh.seedPull("agent/acme-1", sha);
    world.checkRuns.set(sha, [
      { name: "build", status: "completed", conclusion: "success" },
      { name: "e2e", status: "completed", conclusion: "failure" },
      { name: "lint", status: "in_progress", conclusion: null },
    ]);
    world.files.set(
      pr.number,
      Array.from({ length: 12 }, (_, i) => ({
        filename: `f${i}.ts`,
        status: "modified",
        additions: 1,
        deletions: 0,
        changes: 1,
        patch: "@@ -1 +1 @@",
      })),
    );
    world.gh.reviews.set(900, {
      id: 900,
      pull: pr.number,
      user: { login: "owner" },
      state: "COMMENTED",
      commit_id: sha,
      submitted_at: "2026-01-01T00:00:00Z",
      body: "looks fine",
    } as never);
    const s = await connect({
      repositories: [world.binding],
      host: world.host(),
      principal: principal(["reviewer"]),
      transport: "stdio",
    });
    const r = await s.call("comforge_pr", {
      repository: "widgets",
      number: pr.number,
      include: ["checks", "files", "reviews"],
      pageSize: 5,
    });
    expect(r.isError).toBe(false);
    expect(r.body.data.checks).toEqual({
      ok: false,
      total: 3,
      failing: ["e2e"],
      pending: ["lint"],
    });
    expect(r.body.data.files).toHaveLength(5);
    expect(r.body.page).toMatchObject({ next: "5", total: 12 });
    expect(r.body.data.reviews.native[0]).toMatchObject({ id: 900, current: true });
    expect(r.body.data.reviews.advisory.available).toBe(false);
    await s.close();
  });

  test("a moved head is a structured stale refusal", async () => {
    world = createWorld();
    const pr = world.gh.seedPull("agent/acme-2", "d".repeat(40));
    const s = await connect({
      repositories: [world.binding],
      host: world.host(),
      principal: principal(["read-only"]),
      transport: "stdio",
    });
    const r = await s.call("comforge_pr", {
      repository: "widgets",
      number: pr.number,
      expectedHeadSha: "e".repeat(40),
    });
    expect(r.isError).toBe(true);
    expect(r.body).toMatchObject({
      schema: "comforge-mcp-error/v1",
      code: "stale",
      retryable: false,
    });
    await s.close();
  });

  test("context routes a task through the repository's manifest", async () => {
    world = createWorld({
      config: (await import("./harness.ts")).baseConfig({ context: { manifest: "routing.json" } }),
    });
    world.commitFile(
      world.primary,
      "routing.json",
      JSON.stringify({
        version: 1,
        categories: {
          docs: {
            label: "Docs",
            description: "Documentation",
            triggers: ["readme"],
            files: ["README.md"],
            guidance: [],
            validation: [],
          },
        },
      }),
      "routing",
    );
    world.commitFile(world.primary, "README.md", "# widgets\n", "readme");
    world.sh(world.primary, "git", "push", "--quiet", "origin", "main");
    const s = await connect({
      repositories: [world.binding],
      host: world.host(),
      principal: principal(["read-only"]),
      transport: "stdio",
    });
    const r = await s.call("comforge_context", {
      repository: "widgets",
      task: "update the readme",
    });
    expect(r.text.length).toBeLessThan(13_000);
    expect(r.isError).toBe(false);
    expect(r.body.data.match).toMatchObject({ id: "docs", files: ["README.md"] });
    expect(r.body.summary).toBe("routed: docs");
    await s.close();
  });
});

describe("issue listing (review M5)", () => {
  test("without a number, comforge_issue lists issues newest first, paginated, as untrusted text", async () => {
    world = createWorld();
    for (let i = 0; i < 7; i++) world.gh.seedIssue({ title: `Issue ${i} ${"x".repeat(300)}` });
    world.gh.seedIssue({ title: "Closed one", state: "closed" });
    const s = await connect({
      repositories: [world.binding],
      host: world.host(),
      principal: principal(["read-only"]),
      transport: "stdio",
    });
    const first = await s.call("comforge_issue", { repository: "widgets", pageSize: 5 });
    expect(first.isError).toBe(false);
    expect(first.body.data.issues).toHaveLength(5);
    expect(first.body.page).toMatchObject({ next: "5", total: 7 });
    const numbers = first.body.data.issues.map((i: { number: number }) => i.number);
    expect([...numbers].sort((a: number, b: number) => b - a)).toEqual(numbers);
    expect(first.body.data.issues[0].title).toMatchObject({ trust: "untrusted", truncated: true });
    const closed = await s.call("comforge_issue", { repository: "widgets", state: "closed" });
    expect(closed.body.data.issues.map((i: { title: { text: string } }) => i.title.text)).toEqual([
      "Closed one",
    ]);
    await s.close();
  });
});
