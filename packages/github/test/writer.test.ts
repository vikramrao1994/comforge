import { describe, expect, test } from "bun:test";
import {
  type AuthorizationDecision,
  bodyDigest,
  createFetchTransport,
  createGitHubEvidence,
  createGitHubWriter,
  GitHubAdapterError,
  type GitHubWriterOptions,
  type OperationDescriptor,
  WRITE_CAPABILITIES,
  type WriteOperation,
} from "../src/index.ts";
import { BOT, createFakeGitHub, createMemoryLedger, OWNER, REPO, TOKEN } from "./fakeGitHub.ts";

// COMFORGE-GITHUB-003: the caller-authorized writer against a synthetic GitHub. Every test is
// offline; no test reaches the real service. Scenarios follow the specification's Phase C matrix.

const HEAD = "1".repeat(40);
const OTHER = "2".repeat(40);
const T0 = 1_800_000_000_000;

function setup(overrides: Partial<GitHubWriterOptions> = {}, fake = createFakeGitHub()) {
  let time = T0;
  const ledger = createMemoryLedger();
  const seen: OperationDescriptor[] = [];
  const allow = (d: OperationDescriptor): AuthorizationDecision => {
    seen.push(d);
    return {
      allow: true,
      descriptorDigest: d.digest,
      expiresAt: time + 60_000,
      reference: "approval-1",
    };
  };
  const options: GitHubWriterOptions = {
    repository: { owner: OWNER, name: REPO },
    token: TOKEN,
    capabilities: WRITE_CAPABILITIES,
    authorize: allow,
    ledger,
    clock: () => time,
    expectedAuthor: BOT,
    fetchImpl: fake.fetchImpl,
    ...overrides,
  };
  return {
    fake,
    ledger,
    seen,
    writer: createGitHubWriter(options),
    advance: (ms: number) => {
      time += ms;
    },
    options,
  };
}

async function refusal(
  promise: Promise<unknown>,
): Promise<{ code: string; detail: Record<string, unknown>; message: string }> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof GitHubAdapterError)
      return { code: error.code, detail: error.detail, message: error.message };
    throw error;
  }
  throw new Error("expected a refusal");
}

const createIssue = (
  operationId = "op-issue-0001",
  extra: Partial<Extract<WriteOperation, { kind: "issue.create" }>> = {},
) =>
  ({
    kind: "issue.create",
    operationId,
    title: "Sort widgets",
    body: "Body text.",
    ...extra,
  }) as const;

describe("create issue", () => {
  test("sends the authorized bytes with a correlation marker and verifies the read-back", async () => {
    const { writer, fake, seen } = setup();
    const out = await writer.execute(
      createIssue("op-issue-0001", { labels: ["bug"], assignees: ["alice"] }),
    );
    expect(out).toMatchObject({
      status: "verified",
      verification: "matched",
      replayed: false,
      recorded: true,
    });
    expect(out.resource?.type).toBe("issue");
    const [write] = fake.writes();
    expect(write?.method).toBe("POST");
    expect(write?.path).toBe("/repos/acme/widgets/issues");
    expect(write?.redirect).toBe("error");
    const body = write?.body as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["assignees", "body", "labels", "title"]);
    expect(String(body.body)).toMatch(
      /^Body text\.\n\n<!-- comforge-op v1 ns=comforge op=[0-9a-f]{32} fp=[0-9a-f]{32} -->$/,
    );
    expect(seen).toHaveLength(1);
    expect(Object.isFrozen(seen[0]) && Object.isFrozen(seen[0]?.payload)).toBe(true);
  });

  test("a repeat of the same operation is answered from the ledger without a second write", async () => {
    const { writer, fake } = setup();
    const first = await writer.execute(createIssue());
    const again = await writer.execute(createIssue());
    expect(again.replayed).toBe(true);
    expect(again.resource).toEqual(first.resource);
    expect(fake.writes()).toHaveLength(1);
  });

  test("labels GitHub silently drops (no push access) make the outcome accepted, not verified", async () => {
    const { writer } = setup({}, createFakeGitHub({ dropLabels: true }));
    const out = await writer.execute(createIssue("op-issue-0002", { labels: ["bug"] }));
    expect(out.status).toBe("accepted");
    expect(out.mismatches).toEqual(["labels"]);
  });

  test("the same operationId with other content is a conflict", async () => {
    const { writer, fake } = setup();
    await writer.execute(createIssue());
    const r = await refusal(writer.execute(createIssue("op-issue-0001", { body: "Different." })));
    expect(r).toMatchObject({ code: "conflict", detail: { reason: "fingerprint-mismatch" } });
    expect(fake.writes()).toHaveLength(1);
  });

  test.each([
    ["control characters", { body: "a\u0007b" }],
    ["the reserved marker prefix", { body: "x <!-- comforge-op v1 -->" }],
    ["an oversized body", { body: "x".repeat(65_537) }],
    ["an oversized title", { title: "t".repeat(257) }],
    ["an empty body", { body: "  " }],
    ["a bad assignee", { assignees: ["bad login!"] }],
    ["duplicate labels", { labels: ["a", "a"] }],
  ])("refuses %s before anything is recorded or sent", async (_, extra) => {
    const { writer, fake, ledger, seen } = setup();
    expect((await refusal(writer.execute(createIssue("op-issue-0003", extra as never)))).code).toBe(
      "invalid-input",
    );
    expect(fake.requests).toHaveLength(0);
    expect(ledger.records.size).toBe(0);
    expect(seen).toHaveLength(0);
  });

  test("a body that only overflows with the marker is refused before authorization", async () => {
    const { writer, seen } = setup();
    expect(
      (await refusal(writer.execute(createIssue("op-issue-0004", { body: "x".repeat(65_530) }))))
        .code,
    ).toBe("invalid-input");
    expect(seen).toHaveLength(0);
  });
});

describe("create issue comment", () => {
  test("verifies the target thread, state and lock before writing", async () => {
    const { writer, fake } = setup();
    const issue = fake.seedIssue();
    const pr = fake.seedPull("feature", HEAD);
    const closed = fake.seedIssue({ state: "closed" });
    const locked = fake.seedIssue({ locked: true });
    const op = (n: number, extra = {}) =>
      ({
        kind: "issue.comment",
        operationId: `op-comment-${n}`,
        issueNumber: n,
        body: "Looks good.",
        ...extra,
      }) as const;
    expect((await refusal(writer.execute(op(pr.number)))).code).toBe("wrong-target");
    expect(
      (
        await refusal(
          writer.execute(
            op(issue.number, { thread: "pull-request", operationId: "op-comment-thread" }),
          ),
        )
      ).code,
    ).toBe("wrong-target");
    expect(await refusal(writer.execute(op(closed.number)))).toMatchObject({
      code: "conflict",
      detail: { reason: "closed" },
    });
    expect(await refusal(writer.execute(op(locked.number)))).toMatchObject({
      code: "conflict",
      detail: { reason: "locked" },
    });
    expect(fake.writes()).toHaveLength(0);
    const out = await writer.execute(op(issue.number));
    expect(out).toMatchObject({
      status: "verified",
      resource: { type: "comment", issueNumber: issue.number },
    });
    const onPr = await writer.execute(
      op(pr.number, { thread: "pull-request", operationId: "op-comment-pr" }),
    );
    expect(onPr.status).toBe("verified");
  });

  test("a missing issue is not-found and the operation is not retryable under the same id", async () => {
    const { writer } = setup();
    const op = {
      kind: "issue.comment",
      operationId: "op-comment-404",
      issueNumber: 999,
      body: "Hi",
    } as const;
    expect((await refusal(writer.execute(op))).code).toBe("not-found");
    expect((await refusal(writer.execute(op))).code).toBe("not-found");
  });
});

describe("publish pull request review", () => {
  const review = (pullNumber: number, extra = {}) =>
    ({
      kind: "pull.review",
      operationId: "op-review-0001",
      pullNumber,
      expectedHeadSha: HEAD,
      event: "COMMENT",
      body: "Advisory notes.",
      ...extra,
    }) as const;

  test("binds the review to the expected head with commit_id and refuses a stale head", async () => {
    const { writer, fake } = setup();
    const pr = fake.seedPull("feature", HEAD);
    expect(
      await refusal(
        writer.execute(
          review(pr.number, { expectedHeadSha: OTHER, operationId: "op-review-stale" }),
        ),
      ),
    ).toMatchObject({
      code: "stale",
      detail: { expected: OTHER, actual: HEAD },
    });
    const out = await writer.execute(review(pr.number));
    expect(out).toMatchObject({
      status: "verified",
      headMovedDuringPublication: false,
      resource: { commitSha: HEAD, state: "COMMENTED" },
    });
    expect((fake.writes()[0]?.body as { commit_id: string }).commit_id).toBe(HEAD);
  });

  test("a push between the precondition and the read-back is reported, not hidden", async () => {
    const { writer, fake } = setup();
    const pr = fake.seedPull("feature", HEAD);
    fake.afterWrite.push(() => {
      pr.head.sha = OTHER;
    });
    const out = await writer.execute(review(pr.number));
    expect(out.headMovedDuringPublication).toBe(true);
    expect(out.resource).toMatchObject({ commitSha: HEAD });
  });

  test("APPROVE and REQUEST_CHANGES each need their own capability; a closed PR is refused", async () => {
    const { writer, fake } = setup({ capabilities: ["pulls:review"] });
    const pr = fake.seedPull("feature", HEAD);
    expect(
      (
        await refusal(
          writer.execute(review(pr.number, { event: "APPROVE", operationId: "op-review-appr" })),
        )
      ).code,
    ).toBe("capability-denied");
    expect(
      (
        await refusal(
          writer.execute(
            review(pr.number, { event: "REQUEST_CHANGES", operationId: "op-review-rc01" }),
          ),
        )
      ).code,
    ).toBe("capability-denied");
    expect(
      (await refusal(writer.execute(review(pr.number, { event: "PENDING" as never })))).code,
    ).toBe("invalid-input");
    pr.state = "closed";
    expect((await refusal(writer.execute(review(pr.number)))).code).toBe("conflict");
    expect(fake.writes()).toHaveLength(0);
  });
});

describe("create pull request", () => {
  const create = (extra = {}) =>
    ({
      kind: "pull.create",
      operationId: "op-pull-00001",
      title: "Sorting",
      body: "Adds sorting.",
      head: "feature/sort",
      base: "main",
      expectedHeadSha: HEAD,
      ...extra,
    }) as const;

  test("checks the head branch commit and existing pull requests, then verifies the created head", async () => {
    const { writer, fake } = setup();
    fake.refs.set("feature/sort", HEAD);
    fake.refs.set("main", OTHER);
    expect(
      (
        await refusal(
          writer.execute(create({ expectedBaseSha: HEAD, operationId: "op-pull-base" })),
        )
      ).code,
    ).toBe("stale");
    const out = await writer.execute(create({ expectedBaseSha: OTHER }));
    expect(out).toMatchObject({ status: "verified", resource: { type: "pull", headSha: HEAD } });
    const body = fake.writes()[0]?.body as Record<string, unknown>;
    expect(body.maintainer_can_modify).toBe(false);
    expect(await refusal(writer.execute(create({ operationId: "op-pull-00002" })))).toMatchObject({
      code: "conflict",
      detail: { reason: "exists" },
    });
  });

  test("a branch at another commit is stale; a branch that moved during the create is accepted, not verified", async () => {
    const { writer, fake } = setup({}, createFakeGitHub({ pullHeadOverride: OTHER }));
    fake.refs.set("feature/sort", OTHER);
    expect((await refusal(writer.execute(create({ operationId: "op-pull-stale" })))).code).toBe(
      "stale",
    );
    fake.refs.set("feature/sort", HEAD);
    const out = await writer.execute(create());
    expect(out.status).toBe("accepted");
    expect(out.mismatches).toContain("head.sha");
  });

  test.each([
    "../main",
    "-x",
    "a//b",
    "x.lock",
    "refs@{1}",
    "with space",
  ])("refuses branch name %s", async (head) => {
    const { writer, fake } = setup();
    expect((await refusal(writer.execute(create({ head })))).code).toBe("invalid-input");
    expect(fake.requests).toHaveLength(0);
  });
});

describe("update issue and comment with expected state", () => {
  test("an issue update refuses a stale updatedAt or body digest, then verifies", async () => {
    const { writer, fake } = setup();
    const issue = fake.seedIssue({ body: "old" });
    const update = (expected: Record<string, unknown>, operationId: string) =>
      ({
        kind: "issue.update",
        operationId,
        issueNumber: issue.number,
        expected,
        changes: { body: "new", state: "closed", stateReason: "completed" },
      }) as never;
    expect(
      (
        await refusal(
          writer.execute(update({ updatedAt: "2020-01-01T00:00:00Z" }, "op-upd-stale1")),
        )
      ).code,
    ).toBe("stale");
    expect(
      (
        await refusal(
          writer.execute(
            update(
              { updatedAt: issue.updated_at, bodyDigest: await bodyDigest("other") },
              "op-upd-stale2",
            ),
          ),
        )
      ).code,
    ).toBe("stale");
    const out = await writer.execute(
      update(
        { updatedAt: issue.updated_at, bodyDigest: await bodyDigest("old"), state: "open" },
        "op-upd-00001",
      ),
    );
    expect(out.status).toBe("verified");
    expect(issue).toMatchObject({ body: "new", state: "closed" });
    expect((fake.writes()[0]?.body as Record<string, unknown>).body).toBe("new"); // no marker on edits
  });

  test("a comment update checks issue, author and freshness", async () => {
    const { writer, fake } = setup();
    const issue = fake.seedIssue();
    const other = fake.seedIssue();
    const comment = fake.seedComment(issue.number, "draft", "someone");
    const op = (expected: Record<string, unknown>, operationId: string) =>
      ({
        kind: "comment.update",
        operationId,
        commentId: comment.id,
        expected,
        body: "final",
      }) as never;
    const base = { issueNumber: issue.number, updatedAt: comment.updated_at };
    expect(
      (await refusal(writer.execute(op({ ...base, issueNumber: other.number }, "op-cu-wrong1"))))
        .code,
    ).toBe("wrong-target");
    expect((await refusal(writer.execute(op({ ...base, author: BOT }, "op-cu-author")))).code).toBe(
      "conflict",
    );
    expect(
      (
        await refusal(
          writer.execute(op({ ...base, updatedAt: "2020-01-01T00:00:00Z" }, "op-cu-stale1")),
        )
      ).code,
    ).toBe("stale");
    expect((await writer.execute(op({ ...base, author: "someone" }, "op-cu-00001"))).status).toBe(
      "verified",
    );
    expect(comment.body).toBe("final");
  });

  test("an update whose answer was lost is adopted when GitHub shows it applied", async () => {
    const { writer, fake } = setup();
    const issue = fake.seedIssue();
    fake.faults.push("network-after");
    const out = await writer.execute({
      kind: "issue.update",
      operationId: "op-upd-lost1",
      issueNumber: issue.number,
      expected: { updatedAt: issue.updated_at },
      changes: { title: "Renamed" },
    });
    expect(out).toMatchObject({ status: "verified", recovered: true });
    expect(fake.writes()).toHaveLength(1);
  });

  test("an update that never arrived is marked resendable by reconcile, then sent once more", async () => {
    const { writer, fake } = setup();
    const issue = fake.seedIssue();
    const op = {
      kind: "issue.update",
      operationId: "op-upd-lost2",
      issueNumber: issue.number,
      expected: { updatedAt: issue.updated_at },
      changes: { title: "Renamed" },
    } as const;
    fake.faults.push("500-after");
    // Make the 502 a true non-application by reverting what the fake applied.
    fake.afterWrite.push(() => {
      issue.title = "Seed";
      issue.updated_at = "2025-12-31T00:00:00Z";
    });
    const first = await writer.execute(op);
    expect(first.status).toBe("indeterminate");
    const reconciled = await writer.reconcile(op.operationId);
    expect(reconciled.reason).toMatch(/not applied/);
    expect((await writer.execute(op)).status).toBe("verified");
    expect(fake.writes()).toHaveLength(2);
  });
});

describe("authorization binding", () => {
  test("no capability: refused before authorization, ledger or network", async () => {
    const { writer, fake, ledger, seen } = setup({ capabilities: ["issues:comment"] });
    expect((await refusal(writer.execute(createIssue()))).code).toBe("capability-denied");
    expect([fake.requests.length, ledger.records.size, seen.length]).toEqual([0, 0, 0]);
  });

  test.each([
    ["denies", () => ({ allow: false, reason: "not approved" })],
    [
      "throws",
      () => {
        throw new Error("policy service down");
      },
    ],
    [
      "returns a truthy non-boolean",
      (d: OperationDescriptor) => ({
        allow: "yes",
        descriptorDigest: d.digest,
        expiresAt: T0 + 1000,
      }),
    ],
    [
      "binds another descriptor",
      () => ({ allow: true, descriptorDigest: `sha256:${"0".repeat(64)}`, expiresAt: T0 + 1000 }),
    ],
    [
      "has expired",
      (d: OperationDescriptor) => ({ allow: true, descriptorDigest: d.digest, expiresAt: T0 }),
    ],
    ["has no expiry", (d: OperationDescriptor) => ({ allow: true, descriptorDigest: d.digest })],
    [
      "lives too long",
      (d: OperationDescriptor) => ({
        allow: true,
        descriptorDigest: d.digest,
        expiresAt: T0 + 86_400_000,
      }),
    ],
    ["returns nothing", () => undefined],
  ])("an authorization that %s fails closed", async (_, authorize) => {
    const { writer, fake, ledger } = setup({ authorize: authorize as never });
    expect((await refusal(writer.execute(createIssue()))).code).toBe("authorization-denied");
    expect(fake.requests).toHaveLength(0);
    expect(ledger.records.size).toBe(0);
  });

  test("mutating the operation after preparation or during authorization changes nothing sent", async () => {
    const op = { ...createIssue(), labels: ["bug"] };
    const { writer, fake } = setup({
      authorize: (d) => {
        op.body = "INJECTED";
        (op.labels as string[]).push("admin");
        return { allow: true, descriptorDigest: d.digest, expiresAt: T0 + 1000 };
      },
    });
    const prepared = await writer.prepare(op);
    const out = await writer.execute(op);
    expect(out.descriptorDigest).toBe(prepared.digest);
    const sent = fake.writes()[0]?.body as { body: string; labels: string[] };
    expect(sent.body.startsWith("Body text.")).toBe(true);
    expect(sent.labels).toEqual(["bug"]);
  });

  test("prepare is pure and its digest is what execute authorizes", async () => {
    const { writer, fake, seen } = setup();
    const prepared = await writer.prepare(createIssue());
    expect(fake.requests).toHaveLength(0);
    await writer.execute(createIssue());
    expect(seen[0]?.digest).toBe(prepared.digest);
    expect((await writer.prepare(createIssue("op-issue-0001", { body: "Other" }))).digest).not.toBe(
      prepared.digest,
    );
  });

  test("an authorization that expires during the precondition reads stops the write", async () => {
    const ctx = setup();
    const pr = ctx.fake.seedPull("feature", HEAD);
    const slow = createGitHubWriter({
      ...ctx.options,
      authorize: (d) => ({ allow: true, descriptorDigest: d.digest, expiresAt: T0 + 10 }),
      fetchImpl: (async (...args: Parameters<typeof fetch>) => {
        ctx.advance(50);
        return ctx.fake.fetchImpl(...args);
      }) as typeof fetch,
    });
    const r = await refusal(
      slow.execute({
        kind: "pull.review",
        operationId: "op-review-exp1",
        pullNumber: pr.number,
        expectedHeadSha: HEAD,
        event: "COMMENT",
        body: "x",
      }),
    );
    expect(r.code).toBe("authorization-denied");
    expect(ctx.fake.writes()).toHaveLength(0);
  });
});

describe("uncertain outcomes, replay and reconciliation", () => {
  test("a lost answer is found by its marker instead of being written twice", async () => {
    const { writer, fake } = setup();
    fake.faults.push("network-after");
    const out = await writer.execute(createIssue());
    expect(out).toMatchObject({
      status: "verified",
      recovered: true,
      reconciliation: { complete: true, matches: 1 },
    });
    expect(fake.writes()).toHaveLength(1);
  });

  test.each([
    "500-after",
    "malformed-after",
  ] as const)("%s is reconciled to the one created issue", async (fault) => {
    const { writer, fake } = setup();
    fake.faults.push(fault);
    expect((await writer.execute(createIssue())).recovered).toBe(true);
    expect(fake.issues.size).toBe(1);
  });

  test("an unanswered create that did not land stays indeterminate and is never resent automatically", async () => {
    const { writer, fake } = setup();
    fake.faults.push("network-before");
    const first = await writer.execute(createIssue());
    expect(first).toMatchObject({
      status: "indeterminate",
      reconciliation: { complete: true, matches: 0 },
    });
    const again = await writer.execute(createIssue());
    expect(again).toMatchObject({ status: "indeterminate", replayed: true });
    expect((await writer.reconcile("op-issue-0001")).status).toBe("indeterminate");
    expect(fake.writes()).toHaveLength(1);
    await writer.abandon("op-issue-0001", "owner confirmed nothing was created");
    expect(await refusal(writer.execute(createIssue()))).toMatchObject({
      code: "conflict",
      detail: { reason: "abandoned" },
    });
    expect(fake.writes()).toHaveLength(1);
  });

  test("an indeterminate create that later appears is adopted by reconcile", async () => {
    const { writer, fake } = setup();
    fake.faults.push("network-after");
    // Simulate list lag: hide the issue from the first search.
    const hidden = new Map(fake.issues);
    fake.afterWrite.push(() => {
      for (const [k, v] of fake.issues) hidden.set(k, v);
      fake.issues.clear();
    });
    expect((await writer.execute(createIssue())).status).toBe("indeterminate");
    for (const [k, v] of hidden) fake.issues.set(k, v);
    expect(await writer.reconcile("op-issue-0001")).toMatchObject({
      status: "verified",
      recovered: true,
    });
    expect((await writer.execute(createIssue())).replayed).toBe(true);
  });

  test("without markers an uncertain create can only be resolved by the caller", async () => {
    const { writer, fake } = setup({ markers: false });
    fake.faults.push("network-after");
    const out = await writer.execute(createIssue());
    expect(out.status).toBe("indeterminate");
    expect((await writer.reconcile("op-issue-0001")).reason).toMatch(/no correlation marker/);
    expect(String((fake.writes()[0]?.body as { body: string }).body)).toBe("Body text.");
  });

  test("a copied marker by another author is not accepted as the write", async () => {
    const { writer, fake } = setup();
    fake.faults.push("network-before");
    await writer.execute(createIssue());
    const marker = (fake.writes()[0]?.body as { body: string }).body.split("\n\n").at(-1) as string;
    fake.seedIssue({ body: `copy\n\n${marker}`, user: { login: "mallory" } });
    expect(await writer.reconcile("op-issue-0001")).toMatchObject({
      status: "indeterminate",
      reconciliation: { foreignMarkers: 1, matches: 0 },
    });
  });

  test("a search that cannot read every page stays indeterminate (pagination exhaustion)", async () => {
    const { writer, fake } = setup({ limits: { reconcileMaxPages: 1 } });
    for (let i = 0; i < 100; i++) fake.seedIssue();
    fake.faults.push("network-before");
    const out = await writer.execute(createIssue());
    expect(out).toMatchObject({ status: "indeterminate", reconciliation: { complete: false } });
  });

  test("a rate-limited write honours retry-after and searches before the one resend", async () => {
    const { writer, fake, advance } = setup();
    fake.faults.push("429");
    expect(await refusal(writer.execute(createIssue()))).toMatchObject({
      code: "rate-limited",
      detail: { retryAfterSeconds: 30 },
    });
    expect((await refusal(writer.execute(createIssue()))).code).toBe("rate-limited");
    expect(fake.writes()).toHaveLength(1);
    advance(31_000);
    expect((await writer.execute(createIssue())).status).toBe("verified");
    expect(fake.writes()).toHaveLength(2);
    expect(fake.issues.size).toBe(1);
  });

  test("a definite 403 or 422 is a final refusal", async () => {
    const { writer, fake } = setup();
    fake.faults.push("403", "422");
    expect((await refusal(writer.execute(createIssue("op-issue-403a")))).code).toBe("forbidden");
    expect((await refusal(writer.execute(createIssue("op-issue-422a")))).detail.status).toBe(422);
    expect((await refusal(writer.execute(createIssue("op-issue-403a")))).code).toBe("forbidden");
    expect(fake.writes()).toHaveLength(2);
  });

  test("two writers sharing one ledger send one write for one operation", async () => {
    const fake = createFakeGitHub();
    const a = setup({}, fake);
    let during: Promise<unknown> | null = null;
    const b = createGitHubWriter({ ...a.options });
    // The second writer runs while the first one's POST is in flight.
    const gated = createGitHubWriter({
      ...a.options,
      fetchImpl: (async (...args: Parameters<typeof fetch>) => {
        if ((args[1]?.method ?? "GET") !== "GET" && !during) {
          during = b.execute(createIssue()).catch((e: unknown) => e);
          await during;
        }
        return fake.fetchImpl(...args);
      }) as typeof fetch,
    });
    const first = await gated.execute(createIssue());
    const second = (await (during as Promise<unknown> | null)) as GitHubAdapterError;
    expect(first.status).toBe("verified");
    expect(second).toBeInstanceOf(GitHubAdapterError);
    expect([second.code, second.detail.reason]).toEqual(["conflict", "in-progress"]);
    expect(fake.writes()).toHaveLength(1);
    expect((await b.execute(createIssue())).replayed).toBe(true);
  });

  test("a sender that stopped after sending leaves the operation indeterminate once its lease ends", async () => {
    const { writer, fake, ledger, advance } = setup();
    await writer.execute(createIssue());
    const record = ledger.records.get("op-issue-0001");
    if (!record) throw new Error("no record");
    ledger.records.set("op-issue-0001", {
      ...record,
      state: "sending",
      outcome: null,
      leaseUntil: T0 + 1000,
    });
    expect((await refusal(writer.execute(createIssue()))).detail.reason).toBe("in-progress");
    advance(2000);
    expect((await writer.execute(createIssue())).status).toBe("indeterminate");
    expect(await writer.reconcile("op-issue-0001")).toMatchObject({
      status: "verified",
      recovered: true,
    });
    expect(fake.writes()).toHaveLength(1);
  });

  test("a ledger failure before sending sends nothing; after sending, the result still stands", async () => {
    const { writer, fake, ledger } = setup();
    ledger.failOn("create");
    expect((await refusal(writer.execute(createIssue()))).code).toBe("ledger-failure");
    expect(fake.writes()).toHaveLength(0);
    fake.afterWrite.push(() => ledger.failOn("replace"));
    const out = await writer.execute(createIssue("op-issue-0002"));
    expect(out).toMatchObject({ status: "verified", recorded: false });
  });

  test("reconcile and abandon refuse what they must", async () => {
    const { writer } = setup();
    expect((await refusal(writer.reconcile("op-missing-0001"))).code).toBe("not-found");
    await writer.execute(createIssue());
    expect((await writer.reconcile("op-issue-0001")).replayed).toBe(true);
    expect((await refusal(writer.abandon("op-issue-0001", "no"))).detail.reason).toBe("succeeded");
    expect((await refusal(writer.abandon("op-issue-0001", ""))).code).toBe("invalid-input");
  });
});

describe("secrets and read-only compatibility", () => {
  test("the token appears only in Authorization headers, never in outcomes, errors or the ledger", async () => {
    const { writer, fake, ledger } = setup({ token: async () => TOKEN });
    const ok = await writer.execute(createIssue());
    fake.faults.push("403");
    const err = await refusal(writer.execute(createIssue("op-issue-0002")));
    const surfaces = JSON.stringify([ok, err, [...ledger.records.values()]]);
    expect(surfaces.includes(TOKEN)).toBe(false);
    expect(fake.requests.every((r) => r.auth === `Bearer ${TOKEN}`)).toBe(true);
  });

  test("a failing token provider is a refusal before anything is sent", async () => {
    const { writer, fake } = setup({
      token: () => {
        throw new Error(`leak ${TOKEN}`);
      },
    });
    const r = await refusal(writer.execute(createIssue()));
    expect(r.code).toBe("unauthorized");
    expect(r.message.includes(TOKEN)).toBe(false);
    expect(fake.writes()).toHaveLength(0);
  });

  test("read clients expose no write method and the writer exposes no generic request", async () => {
    const transport = createFetchTransport({ token: "x" });
    expect(Object.keys(transport)).toEqual(["get"]);
    const evidence = createGitHubEvidence({ transport, repository: { owner: OWNER, name: REPO } });
    expect(
      Object.keys(evidence).filter((k) =>
        /create|update|post|patch|put|delete|write|merge|dispatch/i.test(k),
      ),
    ).toEqual([]);
    const { writer } = setup();
    expect(Object.keys(writer).sort()).toEqual([
      "abandon",
      "capabilities",
      "execute",
      "prepare",
      "reconcile",
      "repository",
    ]);
    expect(Object.isFrozen(writer)).toBe(true);
  });

  test("construction refuses a missing ledger, clock, authorizer or capability, and unknown capabilities", () => {
    const { options } = setup();
    for (const broken of [
      { capabilities: [] },
      { capabilities: ["contents:write"] },
      { ledger: undefined },
      { clock: undefined },
      { authorize: undefined },
      { repository: { owner: "a/b", name: "c" } },
      { markers: { namespace: "Bad NS" } },
      { expectedAuthor: "not a login" },
    ])
      expect(() =>
        createGitHubWriter({ ...options, ...(broken as object) } as GitHubWriterOptions),
      ).toThrow(GitHubAdapterError);
  });

  test("the writer refuses an operation kind it does not know (no merge, tag or dispatch)", async () => {
    const { writer, fake } = setup();
    for (const kind of ["pull.merge", "ref.create", "workflow.dispatch", "issue.delete"])
      expect(
        (await refusal(writer.execute({ kind, operationId: "op-unknown-01" } as never))).code,
      ).toBe("invalid-input");
    expect(fake.requests).toHaveLength(0);
  });
});
