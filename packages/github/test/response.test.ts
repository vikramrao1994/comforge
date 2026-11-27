import { describe, expect, test } from "bun:test";
import {
  type AuthorizationDecision,
  bodyDigest,
  createGitHubWriter,
  GitHubAdapterError,
  type GitHubWriterOptions,
  type OperationDescriptor,
  WRITE_CAPABILITIES,
  type WriteOperation,
} from "../src/index.ts";
import { BOT, createFakeGitHub, createMemoryLedger, OWNER, REPO, TOKEN } from "./fakeGitHub.ts";

// The verified response a write hands back (so a consumer needs no second GET), and the narrow
// pull request body edit. Offline against the synthetic GitHub; request counts are exact.

const HEAD = "1".repeat(40);
const OTHER = "2".repeat(40);
const T0 = 1_800_000_000_000;

function setup(overrides: Partial<GitHubWriterOptions> = {}, fake = createFakeGitHub()) {
  const time = T0;
  const ledger = createMemoryLedger();
  const options: GitHubWriterOptions = {
    repository: { owner: OWNER, name: REPO },
    token: TOKEN,
    capabilities: WRITE_CAPABILITIES,
    authorize: (d: OperationDescriptor): AuthorizationDecision => ({
      allow: true,
      descriptorDigest: d.digest,
      expiresAt: time + 60_000,
    }),
    ledger,
    clock: () => time,
    expectedAuthor: BOT,
    fetchImpl: fake.fetchImpl,
    ...overrides,
  };
  return { fake, ledger, writer: createGitHubWriter(options) };
}

async function refusal(promise: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof GitHubAdapterError) return { code: error.code, message: error.message };
    throw error;
  }
  throw new Error("expected a refusal");
}

const issue = (operationId = "op-resp-issue1", extra = {}) =>
  ({ kind: "issue.create", operationId, title: "T", body: "B", ...extra }) as const;

/** Every request after the first `skip`, as `METHOD path`. */
const trail = (fake: ReturnType<typeof createFakeGitHub>, skip = 0) =>
  fake.requests.slice(skip).map((r) => `${r.method} ${r.path}`);

describe("verified response", () => {
  test("a verified issue create returns the read-back body in two requests", async () => {
    const { writer, fake } = setup();
    const out = await writer.execute(issue());
    expect(out.status).toBe("verified");
    expect(trail(fake)).toEqual([
      "POST /repos/acme/widgets/issues",
      "GET /repos/acme/widgets/issues/100",
    ]);
    expect(out.response?.source).toBe("verification-read");
    const body = out.response?.body as { number: number; body: string; html_url: string };
    expect(body.number).toBe(100);
    expect(body.body).toMatch(/^B\n\n<!-- comforge-op v1 /);
    // Exactly what a consumer's own GET of the resource would return now.
    const again = await fake.fetchImpl("https://api.github.com/repos/acme/widgets/issues/100");
    expect(await again.json()).toEqual(out.response?.body);
  });

  test("a verified comment returns the comment in three requests (precondition, write, read-back)", async () => {
    const { writer, fake } = setup();
    const target = fake.seedIssue();
    const out = await writer.execute({
      kind: "issue.comment",
      operationId: "op-resp-comm1",
      issueNumber: target.number,
      body: "Hello",
    });
    expect(out.status).toBe("verified");
    expect(trail(fake)).toEqual([
      `GET /repos/acme/widgets/issues/${target.number}`,
      `POST /repos/acme/widgets/issues/${target.number}/comments`,
      `GET /repos/acme/widgets/issues/comments/${(out.resource as { id: number }).id}`,
    ]);
    expect((out.response?.body as { id: number }).id).toBe((out.resource as { id: number }).id);
  });

  test("a pull request conversation comment is the same three requests", async () => {
    const { writer, fake } = setup();
    const pr = fake.seedPull("feature", HEAD);
    const out = await writer.execute({
      kind: "issue.comment",
      operationId: "op-resp-prc01",
      issueNumber: pr.number,
      body: "Advisory",
      thread: "pull-request",
      allowLocked: true,
    });
    expect(out.status).toBe("verified");
    expect(fake.requests).toHaveLength(3);
    expect(out.response).toBeDefined();
  });

  test("a review returns the review, not the pull request read after it", async () => {
    const { writer, fake } = setup();
    const pr = fake.seedPull("feature", HEAD);
    const out = await writer.execute({
      kind: "pull.review",
      operationId: "op-resp-rev01",
      pullNumber: pr.number,
      expectedHeadSha: HEAD,
      event: "COMMENT",
      body: "Notes",
    });
    expect(out.status).toBe("verified");
    expect((out.response?.body as { id: number; commit_id: string }).commit_id).toBe(HEAD);
    expect((out.response?.body as { id: number }).id).toBe((out.resource as { id: number }).id);
  });

  test("a replay carries no response and the ledger never stores one", async () => {
    const { writer, fake, ledger } = setup();
    const first = await writer.execute(issue());
    expect(first.response).toBeDefined();
    const before = fake.requests.length;
    const again = await writer.execute(issue());
    expect(again).toMatchObject({ replayed: true, status: "verified" });
    expect(again.response).toBeUndefined();
    expect(fake.requests.length).toBe(before);
    const stored = JSON.stringify([...ledger.records.values()]);
    expect(stored).not.toContain("html_url");
    expect(stored).not.toContain('"response"');
  });

  test("an accepted write (read-back differs) never hands back its body as verified", async () => {
    const { writer } = setup({}, createFakeGitHub({ dropLabels: true }));
    const out = await writer.execute(issue("op-resp-issue2", { labels: ["bug"] }));
    expect(out.status).toBe("accepted");
    expect(out.response).toBeUndefined();
  });

  test.each([
    ["malformed", () => new Response(JSON.stringify({ unexpected: true }), { status: 200 })],
    ["not JSON", () => new Response("<html>", { status: 200 })],
    ["oversized", () => new Response(JSON.stringify({ pad: "x".repeat(4_000) }), { status: 200 })],
    ["unavailable", () => new Response("{}", { status: 503 })],
  ])("a %s read-back leaves the write accepted with no response", async (_, make) => {
    const { writer, fake } = setup({ maxBodyBytes: 2_000 });
    fake.readOverrides.push((path) =>
      path === "/repos/acme/widgets/issues/100" ? make() : undefined,
    );
    const out = await writer.execute(issue("op-resp-issue3"));
    expect(out).toMatchObject({ status: "accepted", verification: "unavailable" });
    expect(out.resource).toMatchObject({ type: "issue", number: 100 });
    expect(out.response).toBeUndefined();
  });

  test("an indeterminate write has no response", async () => {
    const { writer, fake } = setup({ markers: false });
    fake.faults.push("network-after");
    const out = await writer.execute(issue("op-resp-issue4"));
    expect(out.status).toBe("indeterminate");
    expect(out.response).toBeUndefined();
  });

  test("a create recovered by reconciliation returns its fresh, verified read-back", async () => {
    const { writer, fake } = setup();
    fake.faults.push("network-after");
    const out = await writer.execute(issue("op-resp-issue5"));
    expect(out).toMatchObject({ status: "verified", recovered: true });
    expect((out.response?.body as { number: number }).number).toBe(
      (out.resource as { number: number }).number,
    );
  });

  test("the token never appears in a response or the ledger", async () => {
    const { writer, ledger } = setup();
    const out = await writer.execute(issue("op-resp-issue6"));
    expect(JSON.stringify(out)).not.toContain(TOKEN);
    expect(JSON.stringify([...ledger.records.values()])).not.toContain(TOKEN);
  });
});

describe("pull request body edit", () => {
  const edit = async (
    pullNumber: number,
    current: string,
    extra: Partial<Extract<WriteOperation, { kind: "pull.update" }>> = {},
  ): Promise<WriteOperation> => ({
    kind: "pull.update",
    operationId: "op-pull-edit01",
    pullNumber,
    expected: { bodyDigest: await bodyDigest(current), headSha: HEAD },
    body: "New body",
    ...extra,
  });

  test("sends only the body, unmarked, and verifies it in three requests", async () => {
    const { writer, fake } = setup();
    const pr = fake.seedPull("feature", HEAD, { body: "Old body" });
    const out = await writer.execute(await edit(pr.number, "Old body"));
    expect(out).toMatchObject({
      status: "verified",
      resource: { type: "pull", number: pr.number, headSha: HEAD },
    });
    expect(trail(fake)).toEqual([
      `GET /repos/acme/widgets/pulls/${pr.number}`,
      `PATCH /repos/acme/widgets/pulls/${pr.number}`,
      `GET /repos/acme/widgets/pulls/${pr.number}`,
    ]);
    expect(fake.writes()[0]?.body).toEqual({ body: "New body" });
    expect(pr.body).toBe("New body");
    expect((out.response?.body as { body: string }).body).toBe("New body");
  });

  test("a body changed since it was read, or a moved head, is stale and nothing is sent", async () => {
    const { writer, fake } = setup();
    const pr = fake.seedPull("feature", HEAD, { body: "Old body" });
    expect((await refusal(writer.execute(await edit(pr.number, "Something else")))).code).toBe(
      "stale",
    );
    expect(
      (
        await refusal(
          writer.execute(
            await edit(pr.number, "Old body", {
              operationId: "op-pull-edit02",
              expected: { bodyDigest: await bodyDigest("Old body"), headSha: OTHER },
            }),
          ),
        )
      ).code,
    ).toBe("stale");
    expect(
      (
        await refusal(
          writer.execute(
            await edit(pr.number, "Old body", {
              operationId: "op-pull-edit03",
              expected: {
                bodyDigest: await bodyDigest("Old body"),
                updatedAt: "2020-01-01T00:00:00Z",
              },
            }),
          ),
        )
      ).code,
    ).toBe("stale");
    expect(fake.writes()).toHaveLength(0);
  });

  test("a closed or merged pull request is refused", async () => {
    const { writer, fake } = setup();
    const pr = fake.seedPull("feature", HEAD, {
      body: "Old body",
      merged_at: "2026-01-01T00:00:00Z",
    });
    expect((await refusal(writer.execute(await edit(pr.number, "Old body")))).code).toBe(
      "conflict",
    );
    expect(fake.writes()).toHaveLength(0);
  });

  test("needs pulls:update and an expected body digest; title, state and base are not fields", async () => {
    const { writer, fake } = setup({ capabilities: ["pulls:create", "issues:update"] });
    const pr = fake.seedPull("feature", HEAD, { body: "Old body" });
    expect((await refusal(writer.execute(await edit(pr.number, "Old body")))).code).toBe(
      "capability-denied",
    );
    expect(
      (
        await refusal(
          writer.execute({
            kind: "pull.update",
            operationId: "op-pull-edit04",
            pullNumber: pr.number,
            expected: {} as never,
            body: "x",
          }),
        )
      ).code,
    ).toBe("invalid-input");
    const d = await writer.prepare({
      ...(await edit(pr.number, "Old body")),
      title: "ignored",
      state: "closed",
      base: "other",
    } as never);
    expect(Object.keys(d.payload)).toEqual(["body"]);
    expect(d.capability).toBe("pulls:update");
    expect(fake.writes()).toHaveLength(0);
  });

  test("an edit whose answer was lost is adopted when GitHub shows it applied", async () => {
    const { writer, fake } = setup();
    const pr = fake.seedPull("feature", HEAD, { body: "Old body" });
    fake.faults.push("network-after");
    const out = await writer.execute(await edit(pr.number, "Old body"));
    expect(out).toMatchObject({ status: "verified", recovered: true });
    expect(fake.writes()).toHaveLength(1);
  });

  test("an edit that never applied is resendable after reconcile; one that diverged is not", async () => {
    const { writer, fake } = setup();
    const pr = fake.seedPull("feature", HEAD, { body: "Old body" });
    const op = await edit(pr.number, "Old body");
    fake.faults.push("500-after");
    fake.afterWrite.push(() => {
      pr.body = "Old body";
    });
    expect((await writer.execute(op)).status).toBe("indeterminate");
    expect((await writer.reconcile(op.operationId)).reason).toMatch(/not applied/);
    expect((await writer.execute(op)).status).toBe("verified");
    expect(fake.writes()).toHaveLength(2);

    const other = fake.seedPull("other", HEAD, { body: "Old body" });
    const op2 = await edit(other.number, "Old body", { operationId: "op-pull-edit05" });
    fake.faults.push("500-after");
    fake.afterWrite.push(() => {
      other.body = "Someone else's edit";
    });
    expect((await writer.execute(op2)).status).toBe("indeterminate");
    expect((await writer.reconcile(op2.operationId)).reason).toMatch(/target changed/);
  });
});

describe("expected state is a read before the write, not compare-and-swap", () => {
  test("an edit landing between the precondition read and the PATCH is overwritten and not detected", async () => {
    const { writer, fake } = setup();
    const pr = fake.seedPull("feature", HEAD, { body: "Old body" });
    // Another actor edits after the writer's precondition GET and before its PATCH.
    fake.beforeWrite.push(() => {
      pr.body = "Concurrent edit";
    });
    const out = await writer.execute({
      kind: "pull.update",
      operationId: "op-pull-race01",
      pullNumber: pr.number,
      expected: { bodyDigest: await bodyDigest("Old body") },
      body: "New body",
    });
    // Honest semantics: the outcome describes this write only. The concurrent edit is lost.
    expect(out).toMatchObject({ status: "verified", verification: "matched" });
    expect(pr.body).toBe("New body");
    expect(trail(fake)).toEqual([
      `GET /repos/acme/widgets/pulls/${pr.number}`,
      `PATCH /repos/acme/widgets/pulls/${pr.number}`,
      `GET /repos/acme/widgets/pulls/${pr.number}`,
    ]);
  });

  test("an edit landing before the precondition read is refused as stale", async () => {
    const { writer, fake } = setup();
    const pr = fake.seedPull("feature", HEAD, { body: "Old body" });
    pr.body = "Concurrent edit";
    const r = await refusal(
      writer.execute({
        kind: "pull.update",
        operationId: "op-pull-race02",
        pullNumber: pr.number,
        expected: { bodyDigest: await bodyDigest("Old body") },
        body: "New body",
      }),
    );
    expect(r.code).toBe("stale");
    expect(fake.writes()).toHaveLength(0);
  });
});

describe("a verified response is bound to the written resource's identity", () => {
  /** The next GET of `from` is answered with the real resource at `to`: well-formed, wrong identity. */
  const misdirect = (fake: ReturnType<typeof createFakeGitHub>, from: string, to: string) => {
    let used = false;
    fake.readOverrides.push((path) => {
      if (used || path !== from) return undefined;
      used = true;
      return fake.fetchImpl(`https://api.github.com${to}`);
    });
  };

  test("an issue read-back of another issue is a mismatch with no response", async () => {
    const { writer, fake } = setup();
    const other = fake.seedIssue({ title: "T", body: "B" });
    misdirect(fake, "/repos/acme/widgets/issues/101", `/repos/acme/widgets/issues/${other.number}`);
    const out = await writer.execute(issue("op-ident-iss1"));
    expect(out.resource).toMatchObject({ type: "issue", number: 101 });
    expect(out).toMatchObject({ status: "accepted", verification: "mismatch" });
    expect(out.mismatches).toContain("identity");
    expect(out.response).toBeUndefined();
  });

  test("a comment read-back of another comment on the same issue is a mismatch", async () => {
    const { writer, fake } = setup();
    const target = fake.seedIssue();
    const decoy = fake.seedComment(target.number, "Hello");
    const op = {
      kind: "issue.comment",
      operationId: "op-ident-com1",
      issueNumber: target.number,
      body: "Hello",
    } as const;
    const id = decoy.id + 1;
    misdirect(
      fake,
      `/repos/acme/widgets/issues/comments/${id}`,
      `/repos/acme/widgets/issues/comments/${decoy.id}`,
    );
    const out = await writer.execute(op);
    expect((out.resource as { id: number }).id).toBe(id);
    expect(out.mismatches).toContain("identity");
    expect(out.response).toBeUndefined();
  });

  test("a review read-back of another review is a mismatch", async () => {
    const { writer, fake } = setup();
    const pr = fake.seedPull("feature", HEAD);
    const op = (operationId: string) =>
      ({
        kind: "pull.review",
        operationId,
        pullNumber: pr.number,
        expectedHeadSha: HEAD,
        event: "COMMENT",
        body: "Notes",
      }) as const;
    const first = await writer.execute(op("op-ident-rev1"));
    const firstId = (first.resource as { id: number }).id;
    misdirect(
      fake,
      `/repos/acme/widgets/pulls/${pr.number}/reviews/${firstId + 1}`,
      `/repos/acme/widgets/pulls/${pr.number}/reviews/${firstId}`,
    );
    const out = await writer.execute(op("op-ident-rev2"));
    expect(out.mismatches).toContain("identity");
    expect(out.response).toBeUndefined();
  });

  test("a pull request edit whose read-back is another pull request is a mismatch", async () => {
    const { writer, fake } = setup();
    const pr = fake.seedPull("feature", HEAD, { body: "Old body" });
    const other = fake.seedPull("other", HEAD, { body: "New body" });
    // The first GET of the target is the precondition; only the read-back is misdirected.
    fake.beforeWrite.push(() =>
      misdirect(
        fake,
        `/repos/acme/widgets/pulls/${pr.number}`,
        `/repos/acme/widgets/pulls/${other.number}`,
      ),
    );
    const out = await writer.execute({
      kind: "pull.update",
      operationId: "op-ident-pul1",
      pullNumber: pr.number,
      expected: { bodyDigest: await bodyDigest("Old body") },
      body: "New body",
    });
    expect(out.mismatches).toEqual(["identity"]);
    expect(out.status).toBe("accepted");
    expect(out.response).toBeUndefined();
  });
});
