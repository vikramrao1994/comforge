import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createReviewProtocol } from "@comforge/core";
import type { OperationDescriptor, OperationRecord, WriteOperation } from "@comforge/github";
import { BOT, createFakeGitHub, createMemoryLedger, TOKEN } from "../../github/test/fakeGitHub.ts";
import { ledgerTableStatements } from "../../ledger/src/sqlite.ts";
import {
  createEngineeringHost,
  type EngineeringHost,
  fetchTransport,
  HOST_SERVICES_SCHEMA,
  HostServiceError,
  type HostTransport,
  isFinished,
  minimizeFinished,
  retentionClass,
  sqliteOperationStore,
} from "../src/hostServices.ts";

// The embedded host services, offline: GitHub is the in-memory fake behind `fetch`, the
// database is in-memory SQLite.

const REPO = { owner: "acme", name: "widgets" };
const SLUG = "acme/widgets";
const ROOT = "/repos/acme/widgets/";
const HEAD = "a".repeat(40);
const OTHER = "b".repeat(40);
const REVISION = "d".repeat(40);
const T0 = 1_800_000_000_000;
const CONFIG = `${JSON.stringify({ schema: "example/v1", note: "héllo" }, null, 2)}\n`;

async function refusal(p: Promise<unknown>): Promise<HostServiceError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof HostServiceError) return e;
    throw e;
  }
  throw new Error("expected a HostServiceError");
}

/** A transport that records every path and query it is asked for. */
function recording(inner: HostTransport) {
  const calls: { path: string; query: Readonly<Record<string, string>> | undefined }[] = [];
  const transport: HostTransport = {
    get(path, query) {
      calls.push({ path, query });
      return inner.get(path, query);
    },
  };
  return { transport, calls };
}

function readWorld(fakeOptions: Parameters<typeof createFakeGitHub>[0] = {}) {
  const fake = createFakeGitHub({ requireToken: true, ...fakeOptions });
  const { transport, calls } = recording(
    fetchTransport({ token: () => TOKEN, fetchImpl: fake.fetchImpl }),
  );
  const host = (extra: Partial<Parameters<typeof createEngineeringHost>[0]> = {}) =>
    createEngineeringHost({ repository: REPO, transport, ...extra });
  return { fake, calls, transport, host };
}

describe("construction", () => {
  const transport: HostTransport = { get: async () => ({}) };

  test.each([
    ["an owner with a slash", { owner: "a/b", name: "widgets" }],
    ["an empty owner", { owner: "", name: "widgets" }],
    ["a name with spaces", { owner: "acme", name: "wid gets" }],
    ["a name over 100 characters", { owner: "acme", name: "n".repeat(101) }],
    ["a missing name", { owner: "acme" } as never],
  ])("refuses %s", (_, repository) => {
    expect(() => createEngineeringHost({ repository, transport })).toThrow(TypeError);
  });

  test("refuses a missing or non-callable transport", () => {
    expect(() => createEngineeringHost({ repository: REPO } as never)).toThrow(TypeError);
    expect(() =>
      createEngineeringHost({ repository: REPO, transport: { get: 1 } as never }),
    ).toThrow(TypeError);
  });

  test("reports its schema, repository and profile, and is frozen", () => {
    const readOnly = createEngineeringHost({ repository: REPO, transport });
    expect(readOnly.schema).toBe(HOST_SERVICES_SCHEMA);
    expect(HOST_SERVICES_SCHEMA).toBe("comforge-host-services/v1");
    expect(readOnly.repository).toBe(SLUG);
    expect(readOnly.profile).toBe("read-only");
    expect(Object.isFrozen(readOnly)).toBe(true);
    expect(Object.isFrozen(readOnly.writes)).toBe(true);

    const governed = createEngineeringHost({
      repository: REPO,
      transport,
      writes: {
        token: TOKEN,
        capabilities: ["issues:comment"],
        authorize: () => ({ allow: false, reason: "no" }) as never,
        operations: createMemoryLedger(),
        clock: () => T0,
      },
    });
    expect(governed.profile).toBe("governed-writes");
  });
});

describe("reads through the injected transport", () => {
  test("issue, pull request and comments are read, and every request stays in the repository", async () => {
    const { fake, calls, host } = readWorld();
    const issue = fake.seedIssue({ title: "Sort widgets", body: "hello" });
    const pr = fake.seedPull("feature", HEAD);
    fake.seedComment(issue.number, "first");
    fake.seedComment(issue.number, "second");
    const h = host();

    expect((await h.evidence.getIssue(issue.number)).title.text).toBe("Sort widgets");
    expect((await h.evidence.getPullRequest(pr.number)).head.sha).toBe(HEAD);
    const comments = await h.evidence.listIssueComments(issue.number);
    expect(comments.map((c) => c.body.text)).toEqual(["first", "second"]);

    expect(calls.length).toBeGreaterThan(2);
    for (const call of calls) expect(call.path.startsWith(ROOT)).toBe(true);
    expect(fake.refused).toHaveLength(0);
  });

  test("evidenceLimits.maxTextChars truncates a long body and marks it", async () => {
    const { fake, host } = readWorld();
    const issue = fake.seedIssue({ body: "x".repeat(200) });
    const got = await host({ evidenceLimits: { maxTextChars: 20 } }).evidence.getIssue(
      issue.number,
    );
    expect(got.body.truncated).toBe(true);
    expect(got.body.text.length).toBeLessThanOrEqual(20);
    const full = await host().evidence.getIssue(issue.number);
    expect(full.body.truncated).toBe(false);
  });

  test("a listing longer than evidenceLimits.maxPages is refused as incomplete", async () => {
    const { fake, host } = readWorld();
    const issue = fake.seedIssue();
    for (let i = 0; i < 5; i++) fake.seedComment(issue.number, `c${i}`);
    const limited = host({ evidenceLimits: { perPage: 2, maxPages: 1 } });
    expect((await refusal(limited.evidence.listIssueComments(issue.number))).code).toBe(
      "incomplete",
    );
    const roomy = host({ evidenceLimits: { perPage: 2, maxPages: 5 } });
    expect(await roomy.evidence.listIssueComments(issue.number)).toHaveLength(5);
  });

  test("a request for another repository's data never leaves the repository path", async () => {
    const { calls, host } = readWorld();
    await refusal(host().evidence.getIssue(999));
    expect(calls.every((c) => c.path.startsWith(ROOT))).toBe(true);
  });
});

describe("the read-only profile", () => {
  test("prepare, execute, reconcile and abandon are refused before any request", async () => {
    const { fake, calls, host } = readWorld();
    const issue = fake.seedIssue();
    const h = host();
    const op: WriteOperation = {
      kind: "issue.comment",
      operationId: "op-readonly-0001",
      issueNumber: issue.number,
      body: "hi",
    };
    for (const call of [
      () => h.writes.prepare(op),
      () => h.writes.execute(op),
      () => h.writes.reconcile("op-readonly-0001"),
      () => h.writes.abandon("op-readonly-0001", "reason"),
    ]) {
      const e = await refusal(call());
      expect(e.code).toBe("capability-denied");
    }
    expect(calls).toHaveLength(0);
    expect(fake.requests).toHaveLength(0);
    expect(fake.refused).toHaveLength(0);
  });
});

describe("trustedConfig", () => {
  function seeded() {
    const world = readWorld();
    world.fake.refs.set("main", REVISION);
    world.fake.files.set(`${REVISION}:comforge.config.json`, CONFIG);
    return world;
  }

  test("returns the revision, the exact bytes as text and the observation time", async () => {
    const { host } = seeded();
    const snapshot = await host().trustedConfig({ branch: "main", now: () => 42 });
    expect(snapshot).toEqual({ revision: REVISION, text: CONFIG, observedAt: 42 });
  });

  test.each([
    "../x",
    "/main",
    "",
    "a//b",
    "main/",
    "a..b",
    "has space",
  ])("refuses the branch %p as invalid input with no request", async (branch) => {
    const { host, calls } = seeded();
    expect((await refusal(host().trustedConfig({ branch }))).code).toBe("invalid-input");
    expect(calls).toHaveLength(0);
  });

  test("a branch GitHub does not know is refused", async () => {
    const { host } = seeded();
    expect((await refusal(host().trustedConfig({ branch: "nope" }))).code).toBe("not-found");
  });

  test("a file larger than maxBytes is refused as too-large", async () => {
    const { host } = seeded();
    const e = await refusal(host().trustedConfig({ branch: "main", maxBytes: 5 }));
    expect(e.code).toBe("too-large");
  });

  test("a ref without a commit sha is a malformed response", async () => {
    const e = await refusal(
      createEngineeringHost({
        repository: REPO,
        transport: { get: async () => ({ object: { sha: "main" } }) },
      }).trustedConfig({ branch: "main" }),
    );
    expect(e.code).toBe("malformed-response");
  });

  test("bytes that are not UTF-8 are refused as malformed", async () => {
    const bytes = Buffer.from([0xff, 0xfe, 0xfd]);
    const transport: HostTransport = {
      get: async (path) =>
        path.includes("/git/ref/heads/")
          ? { object: { sha: REVISION } }
          : {
              type: "file",
              path: "comforge.config.json",
              sha: "c".repeat(40),
              size: bytes.length,
              encoding: "base64",
              content: bytes.toString("base64"),
            },
    };
    const e = await refusal(
      createEngineeringHost({ repository: REPO, transport }).trustedConfig({ branch: "main" }),
    );
    expect(e.code).toBe("malformed-response");
  });
});

describe("confirmTrustedConfig", () => {
  function seeded() {
    const world = readWorld();
    world.fake.files.set(`${REVISION}:comforge.config.json`, CONFIG);
    return world;
  }

  test("match for identical bytes, including multi-byte text", async () => {
    const { host } = seeded();
    expect(await host().confirmTrustedConfig({ revision: REVISION, text: CONFIG })).toBe("match");
  });

  test("mismatch for different text", async () => {
    const { host } = seeded();
    expect(await host().confirmTrustedConfig({ revision: REVISION, text: `${CONFIG} ` })).toBe(
      "mismatch",
    );
  });

  test("absent when the file or the commit does not exist", async () => {
    const { host, fake } = seeded();
    expect(await host().confirmTrustedConfig({ revision: OTHER, text: CONFIG })).toBe("absent");
    fake.files.clear();
    expect(await host().confirmTrustedConfig({ revision: REVISION, text: CONFIG })).toBe("absent");
  });

  test("other failures propagate as HostServiceError", async () => {
    const { fake } = seeded();
    const wrong = createEngineeringHost({
      repository: REPO,
      transport: fetchTransport({ token: "ghs_wrong", fetchImpl: fake.fetchImpl }),
    });
    const e = await refusal(wrong.confirmTrustedConfig({ revision: REVISION, text: CONFIG }));
    expect(e.code).toBe("unauthorized");
  });
});

describe("advisoryReviews", () => {
  const protocol = createReviewProtocol({
    reviewScheme: "acme-review/v1",
    repository: SLUG,
    markerNamespace: "acme-mcp",
    publisherName: "Acme",
    publishToolName: "create_review",
    ticketPattern: /^[A-Z][A-Z0-9-]*-\d{3}$/,
    limits: {
      summaryMaxChars: 2000,
      findingsMax: 20,
      findingTitleMaxChars: 120,
      findingTextMaxChars: 2000,
      notesMax: 10,
      noteMaxChars: 400,
    },
  });
  const render = (pr: number, head: string) =>
    protocol.composeReviewComment(
      protocol.buildReviewPayload(
        protocol.inputSchema.parse({
          prNumber: pr,
          expectedHeadSha: head,
          ticketId: "ACME-TICKET-001",
          verdict: "revision_recommended",
          summary: "Looks fine overall.",
          findings: [{ id: "H1", severity: "high", title: "One", evidence: "e1" }],
          idempotencyKey: "key-0123456789abcdef",
        }),
        null,
      ),
      "e".repeat(32),
    );
  const trusted = { trustedAuthors: ["reviewer-bot"] };

  function world(login = "reviewer-bot", body?: (pr: number) => string) {
    const w = readWorld();
    const pr = w.fake.seedPull("feature", HEAD);
    w.fake.seedComment(pr.number, body ? body(pr.number) : render(pr.number, HEAD), login);
    return { ...w, pr };
  }

  test("a verified review by a trusted author on the current head is trusted and fresh", async () => {
    const { host, pr } = world();
    const [r] = await host().advisoryReviews(
      protocol,
      { number: pr.number, headSha: HEAD },
      trusted,
    );
    expect(r).toMatchObject({
      provenance: "trusted_author",
      integrity: "verified",
      stale: false,
      reviewedHeadSha: HEAD,
      author: "reviewer-bot",
    });
  });

  test("the same review is stale once the head moves", async () => {
    const { host, pr } = world();
    const [r] = await host().advisoryReviews(
      protocol,
      { number: pr.number, headSha: OTHER },
      trusted,
    );
    expect(r).toMatchObject({ integrity: "verified", stale: true });
  });

  test("a review by another login is an untrusted author", async () => {
    const { host, pr } = world("mallory");
    const [r] = await host().advisoryReviews(
      protocol,
      { number: pr.number, headSha: HEAD },
      trusted,
    );
    expect(r?.provenance).toBe("untrusted_author");
  });

  test("with no trusted authors no author is verified", async () => {
    const { host, pr } = world();
    const [r] = await host().advisoryReviews(
      protocol,
      { number: pr.number, headSha: HEAD },
      { trustedAuthors: [] },
    );
    expect(r?.provenance).toBe("author_not_verified");
  });

  test("a tampered marker is not verified", async () => {
    const { host, pr } = world("reviewer-bot", (n) =>
      render(n, HEAD).replace(/payload=([A-Za-z0-9_-]+)/, (_m, p: string) => {
        const obj = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
        obj.verdict = "no_blocking_findings";
        return `payload=${Buffer.from(JSON.stringify(obj)).toString("base64url")}`;
      }),
    );
    const [r] = await host().advisoryReviews(
      protocol,
      { number: pr.number, headSha: HEAD },
      trusted,
    );
    expect(r?.integrity).not.toBe("verified");
    expect(r?.review).toBeUndefined();
  });
});

describe("governed writes", () => {
  function writeWorld(overrides: { capabilities?: ("issues:comment" | "issues:create")[] } = {}) {
    const fake = createFakeGitHub({ requireToken: true });
    const operations = createMemoryLedger();
    const approved = new Set<string>();
    const denied: string[] = [];
    const authorized: OperationDescriptor[] = [];
    const host = createEngineeringHost({
      repository: REPO,
      transport: fetchTransport({ token: () => TOKEN, fetchImpl: fake.fetchImpl }),
      writes: {
        token: TOKEN,
        capabilities: overrides.capabilities ?? ["issues:comment"],
        authorize: (d) => {
          authorized.push(d);
          return approved.has(d.digest)
            ? { allow: true, descriptorDigest: d.digest, expiresAt: T0 + 60_000, reference: "ok" }
            : ({ allow: false, reason: "not approved" } as never);
        },
        operations,
        clock: () => T0,
        expectedAuthor: BOT,
        fetchImpl: fake.fetchImpl,
      },
    });
    const approve = async (op: WriteOperation) => {
      const descriptor = await host.writes.prepare(op);
      approved.add(descriptor.digest);
      return descriptor;
    };
    const comment = (id: string, issue: number, body = `body of ${id}`): WriteOperation => ({
      kind: "issue.comment",
      operationId: id,
      issueNumber: issue,
      body,
    });
    return { fake, operations, host, approve, comment, authorized, denied };
  }

  test("a prepared and approved comment executes once; a repeat is answered from the store", async () => {
    const { fake, host, approve, comment } = writeWorld();
    const issue = fake.seedIssue();
    const op = comment("op-comment-0001", issue.number);
    await approve(op);
    expect(fake.writes()).toHaveLength(0);

    const first = await host.writes.execute(op);
    expect(first).toMatchObject({ status: "verified", replayed: false });
    expect(fake.writes()).toHaveLength(1);
    expect(fake.comments.size).toBe(1);

    const again = await host.writes.execute(op);
    expect(again).toMatchObject({ replayed: true });
    expect(again.resource).toEqual(first.resource);
    expect(fake.writes()).toHaveLength(1);
  });

  test("an operation outside the capabilities is refused", async () => {
    const { fake, host } = writeWorld();
    const e = await refusal(
      host.writes.execute({
        kind: "issue.create",
        operationId: "op-create-0001",
        title: "t",
        body: "b",
      }),
    );
    expect(e.code).toBe("capability-denied");
    expect(fake.writes()).toHaveLength(0);
  });

  test("an authorize that denies is refused and nothing is sent", async () => {
    const { fake, host, comment, operations } = writeWorld();
    const issue = fake.seedIssue();
    const e = await refusal(host.writes.execute(comment("op-denied-0001", issue.number)));
    expect(e.code).toBe("authorization-denied");
    expect(fake.writes()).toHaveLength(0);
    expect(operations.records.size).toBe(0);
  });

  test("a lost response leaves the operation indeterminate and reconcile settles it without resending", async () => {
    const { fake, host, approve, comment, operations } = writeWorld();
    const issue = fake.seedIssue();
    const op = comment("op-lost-0001", issue.number);
    await approve(op);
    // The comment lands but the listing cannot show it yet, so the first recovery finds nothing.
    fake.faults.push("network-after");
    const hidden = new Map(fake.comments);
    fake.afterWrite.push(() => {
      for (const [k, v] of fake.comments) hidden.set(k, v);
      fake.comments.clear();
    });
    const out = await host.writes.execute(op);
    expect(out.status).toBe("indeterminate");
    expect((await operations.get("op-lost-0001"))?.state).toBe("indeterminate");
    expect(fake.writes()).toHaveLength(1);

    for (const [k, v] of hidden) fake.comments.set(k, v);
    const settled = await host.writes.reconcile("op-lost-0001");
    expect(settled).toMatchObject({ status: "verified", recovered: true });
    expect(settled.resource).toMatchObject({ type: "comment" });
    expect(fake.writes()).toHaveLength(1);
    expect((await operations.get("op-lost-0001"))?.state).toBe("succeeded");
  });

  test("an unresolved operation can be abandoned and is then never sent", async () => {
    const { fake, host, approve, comment, operations } = writeWorld();
    const issue = fake.seedIssue();
    const op = comment("op-abandon-0001", issue.number);
    await approve(op);
    fake.faults.push("network-before");
    expect((await host.writes.execute(op)).status).toBe("indeterminate");
    await host.writes.abandon("op-abandon-0001", "owner confirmed nothing was created");
    expect((await operations.get("op-abandon-0001"))?.state).toBe("abandoned");
    expect((await refusal(host.writes.execute(op))).code).toBe("conflict");
    expect(fake.writes()).toHaveLength(1);
  });

  test("two executions of one operation started together send exactly once", async () => {
    const { fake, host, approve, comment } = writeWorld();
    const issue = fake.seedIssue();
    const op = comment("op-race-0001", issue.number);
    await approve(op);
    const results = await Promise.allSettled([host.writes.execute(op), host.writes.execute(op)]);
    expect(results.some((r) => r.status === "fulfilled")).toBe(true);
    expect(fake.writes()).toHaveLength(1);
    expect(fake.comments.size).toBe(1);
  });

  test("the credential appears in no refusal and no stored operation record", async () => {
    const { fake, host, approve, comment, operations } = writeWorld();
    const issue = fake.seedIssue();
    const op = comment("op-secret-0001", issue.number);
    await approve(op);
    await host.writes.execute(op);

    const errors: HostServiceError[] = [];
    errors.push(await refusal(host.writes.execute(comment("op-secret-0002", issue.number))));
    const wrong = createEngineeringHost({
      repository: REPO,
      transport: fetchTransport({
        token: TOKEN,
        fetchImpl: (async () => {
          throw new TypeError(`fetch failed for ${TOKEN}`);
        }) as unknown as typeof fetch,
      }),
    });
    errors.push(await refusal(wrong.evidence.getIssue(1)));
    const unauthorized = createEngineeringHost({
      repository: REPO,
      transport: fetchTransport({ token: "ghs_other", fetchImpl: fake.fetchImpl }),
    });
    errors.push(await refusal(unauthorized.evidence.getIssue(1)));

    for (const e of errors) {
      expect(e.message).not.toContain(TOKEN);
      expect(JSON.stringify(e.detail)).not.toContain(TOKEN);
    }
    expect(JSON.stringify([...operations.records.values()])).not.toContain(TOKEN);
  });
});

// --- sqliteOperationStore ------------------------------------------------------------------

type State = OperationRecord["state"];

function rec(
  id: string,
  state: State,
  options: { retryable?: boolean; repository?: string; body?: string; version?: number } = {},
): OperationRecord {
  const sent = ["sending", "succeeded", "indeterminate"].includes(state);
  return {
    schema: "comforge-github-operation/v1",
    operationId: id,
    repository: options.repository ?? SLUG,
    kind: "issue.comment",
    capability: "issues:comment",
    fingerprint: `fp-${id}`,
    descriptor: {
      digest: `digest-${id}`,
      payload: { issueNumber: 3, body: options.body ?? `body of ${id}` },
    },
    version: options.version ?? 1,
    state,
    leaseUntil: state === "sending" || state === "reserved" ? T0 + 1 : null,
    attempts: 1,
    firstSentAt: sent ? T0 : null,
    changedAt: T0,
    authorizationReference: null,
    marker: null,
    outcome:
      state === "succeeded"
        ? ({ status: "verified", resource: { type: "comment", id: 9 } } as never)
        : null,
    failure:
      state === "failed"
        ? {
            code: "http-error",
            message: "refused",
            retryable: options.retryable === true,
            notBefore: null,
          }
        : null,
    note: null,
  } as unknown as OperationRecord;
}

const sha = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;

function storeWorld(options: { kindAndState?: boolean } = {}) {
  const db = new Database(":memory:");
  const kindAndState = options.kindAndState === true;
  for (const sql of ledgerTableStatements({
    table: "ops",
    namespaceColumn: "repo",
    ...(kindAndState ? { columns: { kind: "TEXT", state: "TEXT" } } : {}),
  }))
    db.prepare(sql).run();
  let now = Date.parse("2026-01-01T00:00:00Z");
  const open = (repository = SLUG) =>
    sqliteOperationStore({
      database: db,
      repository,
      table: "ops",
      repositoryColumn: "repo",
      kindAndStateColumns: kindAndState,
      clock: () => new Date(now),
    });
  const row = (id: string) =>
    db.prepare("SELECT * FROM ops WHERE operation_id = ?").get(id) as Record<string, unknown>;
  return {
    db,
    open,
    row,
    advance(ms: number) {
      now += ms;
    },
    stored: (id: string) => JSON.parse(row(id).record_json as string) as OperationRecord,
  };
}

describe("sqliteOperationStore", () => {
  test("create, get and version-checked replace", async () => {
    const { open } = storeWorld();
    const store = open();
    const first = rec("op-1", "reserved");
    expect(await store.create(first)).toBe(true);
    expect(await store.create(first)).toBe(false);
    expect(await store.get("op-1")).toEqual(first);
    expect(await store.get("missing")).toBeNull();

    const next = rec("op-1", "sending", { version: 2 });
    expect(await store.replace("op-1", 1, next)).toBe(true);
    expect(await store.replace("op-1", 1, rec("op-1", "abandoned", { version: 2 }))).toBe(false);
    expect(await store.get("op-1")).toEqual(next);
  });

  test("a record of another repository is refused on create", async () => {
    const { open } = storeWorld();
    const e = await open()
      .create(rec("op-x", "reserved", { repository: "other/repo" }))
      .then(
        () => null,
        (error: Error) => error,
      );
    expect(e?.message).toContain("ops record is inconsistent with its state");
  });

  test("a malformed record and a record inconsistent with its state are refused on create", async () => {
    const { open } = storeWorld();
    const store = open();
    const bad = (p: Promise<unknown>) =>
      p.then(
        () => null,
        (error: Error) => error.message,
      );
    expect(
      await bad(store.create({ ...rec("op-m", "reserved"), fingerprint: 1 } as never)),
    ).toContain("ops record is malformed");
    expect(
      await bad(store.create({ ...rec("op-m", "reserved"), version: 0 } as never)),
    ).toBeTruthy();
    expect(
      await bad(store.create({ ...rec("op-m", "succeeded"), outcome: null } as never)),
    ).toContain("ops record is inconsistent with its state");
    expect(await bad(store.create({ ...rec("op-m", "failed"), failure: null } as never))).toContain(
      "ops record is inconsistent with its state",
    );
    expect(await store.get("op-m")).toBeNull();
  });

  test("a malformed or state-inconsistent stored row is refused on read", async () => {
    const { open, db } = storeWorld();
    const store = open();
    await store.create(rec("op-r", "reserved"));
    const put = (id: string, json: string) =>
      db
        .prepare(
          "INSERT INTO ops (operation_id, repo, version, record_json, created_at, updated_at) VALUES (?, 'acme/widgets', 1, ?, 'x', 'x')",
        )
        .run(id, json);
    put("bad-shape", JSON.stringify({ ...rec("bad-shape", "reserved"), schema: "other/v1" }));
    put("bad-state", JSON.stringify({ ...rec("bad-state", "succeeded"), outcome: null }));
    const message = (id: string) =>
      store.get(id).then(
        () => null,
        (error: Error) => error.message,
      );
    expect(await message("bad-shape")).toContain("ops record is malformed");
    expect(await message("bad-state")).toContain("ops record is inconsistent with its state");
  });

  test("finished records are stored minimized, unresolved ones keep their body", async () => {
    const { open, stored } = storeWorld();
    const store = open();
    await store.create(rec("done", "succeeded"));
    await store.create(rec("dead", "failed"));
    await store.create(rec("retry", "failed", { retryable: true }));
    await store.create(rec("open", "indeterminate"));
    const body = (id: string) => (stored(id).descriptor.payload as { body: string }).body;
    expect(body("done")).toBe(`[omitted; ${sha("body of done")}]`);
    expect(body("dead")).toBe(`[omitted; ${sha("body of dead")}]`);
    expect(body("retry")).toBe("body of retry");
    expect(body("open")).toBe("body of open");
    expect(stored("done").version).toBe(1);
  });

  test("inspect reports the retention classes of this repository only", async () => {
    const { open, db } = storeWorld();
    const store = open();
    await store.create(rec("a-open", "sending"));
    await store.create(rec("b-retry", "failed", { retryable: true }));
    await store.create(rec("c-done", "succeeded"));
    await store.create(rec("d-done", "abandoned"));
    await open("other/repo").create(rec("z-other", "reserved", { repository: "other/repo" }));
    db.prepare("UPDATE ops SET record_json = ? WHERE operation_id = 'd-done'").run(
      JSON.stringify(rec("d-done", "abandoned")),
    );
    expect(await store.inspect()).toEqual({
      operations: 4,
      classes: { unresolved: 1, retryable: 1, "finished-compact": 1, "finished-compactable": 1 },
      unreadable: 0,
    });
  });

  test("compact rewrites only older finished records and keeps identity and version", async () => {
    const { open, db, row, advance } = storeWorld();
    const store = open();
    await store.create(rec("old-done", "succeeded"));
    await store.create(rec("old-open", "indeterminate"));
    await store.create(rec("old-retry", "failed", { retryable: true }));
    advance(60_000);
    await store.create(rec("new-done", "succeeded"));
    // Finished rows an earlier release could have left with their body.
    for (const id of ["old-done", "new-done"])
      db.prepare("UPDATE ops SET record_json = ? WHERE operation_id = ?").run(
        JSON.stringify(rec(id, "succeeded")),
        id,
      );
    const before = Object.fromEntries(
      ["old-open", "old-retry", "new-done"].map((id) => [id, row(id).record_json]),
    );

    const cutoff = new Date(Date.parse("2026-01-01T00:00:30Z"));
    expect((await store.inspect()).classes["finished-compactable"]).toBe(2);
    expect(await store.compact({ before: cutoff, limit: 10 })).toMatchObject({ changed: 1 });

    const done = JSON.parse(row("old-done").record_json as string) as OperationRecord;
    expect(done.operationId).toBe("old-done");
    expect(done.version).toBe(1);
    expect((done.descriptor.payload as { body: string }).body).toBe(
      `[omitted; ${sha("body of old-done")}]`,
    );
    for (const [id, json] of Object.entries(before))
      expect(row(id).record_json).toBe(json as string);
    expect(await store.compact({ before: cutoff, limit: 10 })).toMatchObject({ changed: 0 });
  });

  test("compact honours its limit", async () => {
    const { open, db, row } = storeWorld();
    const store = open();
    for (const id of ["c1", "c2", "c3"]) {
      await store.create(rec(id, "succeeded"));
      db.prepare("UPDATE ops SET record_json = ? WHERE operation_id = ?").run(
        JSON.stringify(rec(id, "succeeded")),
        id,
      );
    }
    const future = new Date(Date.parse("2027-01-01T00:00:00Z"));
    expect(await store.compact({ before: future, limit: 2 })).toMatchObject({ changed: 2 });
    const compacted = ["c1", "c2", "c3"].filter((id) =>
      String(row(id).record_json).includes("[omitted;"),
    );
    expect(compacted).toHaveLength(2);
  });

  test("kind and state columns follow the record and kind cannot change", async () => {
    const { open, row } = storeWorld({ kindAndState: true });
    const store = open();
    await store.create(rec("op-k", "reserved"));
    expect(row("op-k")).toMatchObject({ kind: "issue.comment", state: "reserved", repo: SLUG });
    await store.replace("op-k", 1, rec("op-k", "sending", { version: 2 }));
    expect(row("op-k")).toMatchObject({ state: "sending", version: 2 });
    const changed = { ...rec("op-k", "abandoned", { version: 3 }), kind: "issue.create" };
    const e = await store.replace("op-k", 2, changed as never).then(
      () => null,
      (error: Error) => error,
    );
    expect(e?.message).toContain("fixed column");
    expect(row("op-k")).toMatchObject({ kind: "issue.comment", version: 2 });
  });

  test("another repository's identity is held, never read or replaced", async () => {
    const { open } = storeWorld();
    await open().create(rec("op-own", "reserved"));
    const foreign = open("other/repo");
    const code = (p: Promise<unknown>) =>
      p.then(
        () => null,
        (error: { code?: string }) => error.code,
      );
    expect(await code(foreign.get("op-own"))).toBe("foreign");
    expect(
      await code(
        foreign.replace(
          "op-own",
          1,
          rec("op-own", "sending", { version: 2, repository: "other/repo" }),
        ),
      ),
    ).toBe("foreign");
  });

  test("the database is not touched at construction", async () => {
    let prepared = 0;
    const store = sqliteOperationStore({
      database: {
        prepare() {
          prepared += 1;
          throw new Error("database unavailable");
        },
      },
      repository: SLUG,
    });
    expect(prepared).toBe(0);
    await expect(store.get("op")).rejects.toThrow("database unavailable");
    expect(prepared).toBe(1);
  });

  test("works as the host's operation store: a comment is written once and replayed after reopening", async () => {
    const { open } = storeWorld({ kindAndState: true });
    const fake = createFakeGitHub({ requireToken: true });
    const issue = fake.seedIssue();
    let approvedDigest = "";
    const hostWith = (store: ReturnType<typeof open>): EngineeringHost =>
      createEngineeringHost({
        repository: REPO,
        transport: fetchTransport({ token: TOKEN, fetchImpl: fake.fetchImpl }),
        writes: {
          token: TOKEN,
          capabilities: ["issues:comment"],
          authorize: (d) =>
            d.digest === approvedDigest
              ? { allow: true, descriptorDigest: d.digest, expiresAt: T0 + 60_000 }
              : ({ allow: false } as never),
          operations: store,
          clock: () => T0,
          expectedAuthor: BOT,
          fetchImpl: fake.fetchImpl,
        },
      });
    const op: WriteOperation = {
      kind: "issue.comment",
      operationId: "op-durable-0001",
      issueNumber: issue.number,
      body: "durable",
    };
    approvedDigest = (await hostWith(open()).writes.prepare(op)).digest;
    expect(await hostWith(open()).writes.execute(op)).toMatchObject({ status: "verified" });
    expect(await hostWith(open()).writes.execute(op)).toMatchObject({ replayed: true });
    expect(fake.writes()).toHaveLength(1);
  });
});

describe("retention helpers", () => {
  const cases: [string, OperationRecord, boolean, string][] = [
    ["succeeded", rec("a", "succeeded"), true, "finished-compactable"],
    ["abandoned", rec("b", "abandoned"), true, "finished-compactable"],
    ["failed, not retryable", rec("c", "failed"), true, "finished-compactable"],
    ["failed, retryable", rec("d", "failed", { retryable: true }), false, "retryable"],
    ["reserved", rec("e", "reserved"), false, "unresolved"],
    ["sending", rec("f", "sending"), false, "unresolved"],
    ["indeterminate", rec("g", "indeterminate"), false, "unresolved"],
  ];

  test.each(cases)("%s", (_name, record, finished, klass) => {
    expect(isFinished(record)).toBe(finished);
    expect(retentionClass(record) as string).toBe(klass);
    const minimized = minimizeFinished(record);
    if (finished) {
      expect((minimized.descriptor.payload as { body: string }).body).toBe(
        `[omitted; ${sha((record.descriptor.payload as { body: string }).body)}]`,
      );
      expect(retentionClass(minimized)).toBe("finished-compact");
      expect(minimizeFinished(minimized)).toBe(minimized);
      expect(minimized.operationId).toBe(record.operationId);
      expect(minimized.version).toBe(record.version);
      expect(minimized.fingerprint).toBe(record.fingerprint);
    } else {
      expect(minimized).toBe(record);
    }
  });

  test("a finished record without a text body is already compact", () => {
    const record = rec("h", "succeeded");
    (record.descriptor.payload as Record<string, unknown>).body = undefined;
    expect(minimizeFinished(record)).toBe(record);
    expect(retentionClass(record)).toBe("finished-compact");
  });
});

describe("shared implementation", () => {
  const source = readFileSync(new URL("../src/tools.ts", import.meta.url), "utf8");

  test("the server's tools use createEngineeringHost and no longer build GitHub services directly", () => {
    expect(source).toMatch(
      /import \{[^}]*\bcreateEngineeringHost\b[^}]*\} from "\.\/hostServices\.ts"/,
    );
    expect(source).not.toContain("createGitHubEvidence(");
    expect(source).not.toContain("createFetchTransport(");
    expect(source).not.toContain("listAdvisoryReviews(");
  });
});
