import { describe, expect, test } from "bun:test";
import { createReviewProtocol } from "@comforge/core";
import {
  createFetchTransport,
  createGitHubEvidence,
  GitHubAdapterError,
  type GitHubErrorCode,
  latestAdvisoryReview,
  listAdvisoryReviews,
} from "../src/index.ts";

// Read primitives: issue comments, pull request listing, file at commit, advisory reviews.
// No network: a fake fetch stands in for GitHub.

const TOKEN = "ghs_SECRETtokenSECRETtoken9876";
const HEAD = "a".repeat(40);
const OTHER = "b".repeat(40);
const ROOT = "/repos/acme/widgets";

type Route = (url: URL) => Response | Promise<Response>;
const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });

function evidenceFor(
  route: Route,
  limits?: Parameters<typeof createGitHubEvidence>[0]["limits"],
  fetchOverride?: typeof fetch,
) {
  const calls: URL[] = [];
  const impl =
    fetchOverride ??
    ((async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      calls.push(url);
      return route(url);
    }) as typeof fetch);
  return {
    calls,
    evidence: createGitHubEvidence({
      transport: createFetchTransport({ token: TOKEN, fetchImpl: impl }),
      repository: { owner: "acme", name: "widgets" },
      limits,
    }),
  };
}

async function failure(promise: Promise<unknown>): Promise<GitHubAdapterError> {
  try {
    await promise;
  } catch (e) {
    if (e instanceof GitHubAdapterError) return e;
    throw e;
  }
  throw new Error("expected a refusal");
}

const comment = (id: number, body: string, login: string | null = "alice", created = id) => ({
  id,
  user: login === null ? null : { login, type: "User" },
  author_association: "MEMBER",
  created_at: `2026-01-01T00:00:${String(created).padStart(2, "0")}Z`,
  updated_at: "2026-01-02T00:00:00Z",
  body,
});

const paged = (items: unknown[], url: URL) => {
  const per = Number(url.searchParams.get("per_page"));
  const page = Number(url.searchParams.get("page"));
  return json(items.slice((page - 1) * per, page * per));
};

describe("listIssueComments", () => {
  test("maps comments and reads every page", async () => {
    const all = Array.from({ length: 5 }, (_, i) => comment(i + 1, `body ${i}`));
    const { evidence, calls } = evidenceFor((u) => paged(all, u), { perPage: 2, maxPages: 5 });
    const got = await evidence.listIssueComments(7, { since: "2026-01-01T00:00:00Z" });
    expect(got).toHaveLength(5);
    expect(got[0]).toMatchObject({
      id: 1,
      author: "alice",
      authorType: "User",
      authorAssociation: "MEMBER",
      body: { text: "body 0", truncated: false, trust: "untrusted" },
    });
    expect(calls[0]?.pathname).toBe(`${ROOT}/issues/7/comments`);
    expect(calls[0]?.searchParams.get("since")).toBe("2026-01-01T00:00:00Z");
  });

  test("a null author is kept as null", async () => {
    const { evidence } = evidenceFor(() => json([comment(1, "x", null)]));
    expect((await evidence.listIssueComments(1))[0]?.author).toBeNull();
  });

  test("a listing beyond maxPages is refused as incomplete, never truncated", async () => {
    const all = Array.from({ length: 9 }, (_, i) => comment(i + 1, "x"));
    const { evidence } = evidenceFor((u) => paged(all, u), { perPage: 2, maxPages: 3 });
    expect((await failure(evidence.listIssueComments(1))).code).toBe("incomplete");
  });

  test("oversized text is truncated and flagged", async () => {
    const { evidence } = evidenceFor(() => json([comment(1, "z".repeat(50))]), {
      maxTextChars: 10,
    });
    const [c] = await evidence.listIssueComments(1);
    expect(c?.body).toEqual({ text: "z".repeat(10), truncated: true, trust: "untrusted" });
  });

  test("invalid issue number and since are refused before any request", async () => {
    const { evidence, calls } = evidenceFor(() => json([]));
    expect((await failure(evidence.listIssueComments(0))).code).toBe("invalid-input");
    expect((await failure(evidence.listIssueComments(1, { since: "yesterday" }))).code).toBe(
      "invalid-input",
    );
    expect(calls).toHaveLength(0);
  });
});

describe("listPullRequests", () => {
  const pull = (n: number, extra: Record<string, unknown> = {}) => ({
    number: n,
    title: `PR ${n}`,
    state: "open",
    draft: false,
    merged_at: null,
    user: { login: "bob" },
    head: { ref: `feature-${n}`, sha: HEAD },
    base: { ref: "main" },
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-02T00:00:00Z",
    ...extra,
  });

  test("maps summaries, merged derives from merged_at, query is forwarded", async () => {
    const { evidence, calls } = evidenceFor(() =>
      json([
        pull(1),
        pull(2, { state: "closed", merged_at: "2026-01-03T00:00:00Z" }),
        pull(3, { draft: true, user: null }),
      ]),
    );
    const got = await evidence.listPullRequests({ state: "all", base: "release/1.x" });
    expect(got.map((p) => [p.number, p.merged, p.draft, p.author])).toEqual([
      [1, false, false, "bob"],
      [2, true, false, "bob"],
      [3, false, true, null],
    ]);
    expect(got[0]).toMatchObject({ headRef: "feature-1", headSha: HEAD, baseRef: "main" });
    expect(calls[0]?.searchParams.get("state")).toBe("all");
    expect(calls[0]?.searchParams.get("base")).toBe("release/1.x");
  });

  test("beyond maxPages is refused as incomplete", async () => {
    const all = Array.from({ length: 9 }, (_, i) => pull(i + 1));
    const { evidence } = evidenceFor((u) => paged(all, u), { perPage: 2, maxPages: 2 });
    expect((await failure(evidence.listPullRequests())).code).toBe("incomplete");
  });

  test("unsafe base refs are refused before any request", async () => {
    const { evidence, calls } = evidenceFor(() => json([]));
    for (const base of ["", "../main", "a//b", "-x", "/x", "x/", "a b", "a?b=1", "x.", "a\nb"])
      expect((await failure(evidence.listPullRequests({ base }))).code).toBe("invalid-input");
    expect(calls).toHaveLength(0);
  });
});

describe("getFileAtCommit", () => {
  const b64 = (bytes: Uint8Array | string) => Buffer.from(bytes).toString("base64");
  const file = (
    path: string,
    content: Uint8Array | string,
    extra: Record<string, unknown> = {},
  ) => ({
    type: "file",
    path,
    sha: "c".repeat(40),
    size: Buffer.from(content).length,
    encoding: "base64",
    content: b64(content),
    ...extra,
  });

  test("reads text at an exact commit with encoded segments and ref", async () => {
    const { evidence, calls } = evidenceFor(() => json(file("docs/a b.md", "héllo\n")));
    const got = await evidence.getFileAtCommit(HEAD, "docs/a b.md");
    expect(got).toEqual({
      commitSha: HEAD,
      path: "docs/a b.md",
      blobSha: "c".repeat(40),
      size: Buffer.from("héllo\n").length,
      kind: "text",
      text: { text: "héllo\n", truncated: false, trust: "untrusted" },
    });
    expect(calls[0]?.pathname).toBe(`${ROOT}/contents/docs/a%20b.md`);
    expect(calls[0]?.searchParams.get("ref")).toBe(HEAD);
  });

  test("anything but a 40-hex commit is refused", async () => {
    const { evidence, calls } = evidenceFor(() => json(file("a", "x")));
    for (const ref of ["main", "v1.0.0", "HEAD", HEAD.slice(1), HEAD.toUpperCase(), `${HEAD}0`])
      expect((await failure(evidence.getFileAtCommit(ref, "a"))).code).toBe("invalid-input");
    expect(calls).toHaveLength(0);
  });

  test("every invalid path form is refused with no request", async () => {
    const { evidence, calls } = evidenceFor(() => json(file("a", "x")));
    const bad = [
      "",
      "/etc/passwd",
      "a\\b",
      "../x",
      "a/../b",
      "./a",
      "a/./b",
      "a//b",
      "a/",
      "a/..",
      "a\u0000b",
      "a\nb",
      "a\u007fb",
      "x".repeat(1025),
    ];
    for (const path of bad)
      expect((await failure(evidence.getFileAtCommit(HEAD, path))).code).toBe("invalid-input");
    expect(calls).toHaveLength(0);
  });

  test("a response for another path is refused", async () => {
    const { evidence } = evidenceFor(() => json(file("other.md", "x")));
    expect((await failure(evidence.getFileAtCommit(HEAD, "a.md"))).code).toBe("wrong-target");
  });

  test("directories, symlinks and submodules are refused", async () => {
    const dir = evidenceFor(() => json([file("a/x", "x")]));
    expect((await failure(dir.evidence.getFileAtCommit(HEAD, "a"))).code).toBe("wrong-target");
    for (const type of ["symlink", "submodule"]) {
      const { evidence } = evidenceFor(() => json(file("a", "x", { type })));
      expect((await failure(evidence.getFileAtCommit(HEAD, "a"))).code).toBe("wrong-target");
    }
  });

  test("binary content (NUL or invalid UTF-8) returns no text", async () => {
    for (const bytes of [new Uint8Array([104, 0, 105]), new Uint8Array([0xff, 0xfe, 0x41])]) {
      const { evidence } = evidenceFor(() => json(file("a.bin", bytes)));
      const got = await evidence.getFileAtCommit(HEAD, "a.bin");
      expect(got.kind).toBe("binary");
      expect(got.text).toBeUndefined();
      expect(JSON.stringify(got)).not.toContain(b64(bytes));
    }
  });

  test("too large by size or without inline content", async () => {
    const big = evidenceFor(() => json(file("a", "x".repeat(20))));
    const got = await big.evidence.getFileAtCommit(HEAD, "a", { maxBytes: 10 });
    expect(got).toMatchObject({ kind: "too-large", size: 20 });
    expect(got.text).toBeUndefined();
    const none = evidenceFor(() =>
      json(file("a", "x", { size: 2_000_000, encoding: "none", content: "" })),
    );
    expect((await none.evidence.getFileAtCommit(HEAD, "a")).kind).toBe("too-large");
  });

  test("content that disagrees with its size is malformed", async () => {
    const { evidence } = evidenceFor(() => json(file("a", "abc", { size: 99 })));
    expect((await failure(evidence.getFileAtCommit(HEAD, "a"))).code).toBe("malformed-response");
  });

  test("text over maxTextChars is truncated and flagged", async () => {
    const { evidence } = evidenceFor(() => json(file("a", "y".repeat(40))), { maxTextChars: 8 });
    expect((await evidence.getFileAtCommit(HEAD, "a")).text).toEqual({
      text: "y".repeat(8),
      truncated: true,
      trust: "untrusted",
    });
  });
});

describe("failures and credentials", () => {
  test("5xx, rate limit, forbidden and not-found keep the transport classification", async () => {
    const cases: [number, Record<string, string>, GitHubErrorCode][] = [
      [503, {}, "http-error"],
      [429, { "retry-after": "12" }, "rate-limited"],
      [403, { "x-ratelimit-remaining": "0" }, "rate-limited"],
      [403, {}, "forbidden"],
      [401, {}, "unauthorized"],
      [404, {}, "not-found"],
    ];
    for (const [status, headers, code] of cases) {
      const { evidence } = evidenceFor(() => new Response("nope", { status, headers }));
      for (const read of [
        () => evidence.listIssueComments(1),
        () => evidence.listPullRequests(),
        () => evidence.getFileAtCommit(HEAD, "a"),
      ]) {
        const e = await failure(read());
        expect(e.code).toBe(code);
        expect(e.message).not.toContain(TOKEN);
        expect(JSON.stringify(e.detail)).not.toContain(TOKEN);
      }
    }
  });

  test("a network failure is typed and does not leak the credential", async () => {
    const { evidence } = evidenceFor(() => json([]), undefined, (async () => {
      throw new TypeError(`fetch failed for ${TOKEN}`);
    }) as unknown as typeof fetch);
    const e = await failure(evidence.listIssueComments(1));
    expect(e.code).toBe("network");
    expect(e.message).not.toContain(TOKEN);
  });

  test("a timeout abort is typed as timeout", async () => {
    const { evidence } = evidenceFor(() => json([]), undefined, (async () => {
      throw new DOMException("aborted", "TimeoutError");
    }) as unknown as typeof fetch);
    expect((await failure(evidence.listPullRequests())).code).toBe("timeout");
  });
});

describe("advisory reviews", () => {
  const protocol = createReviewProtocol({
    reviewScheme: "acme-review/v1",
    repository: "acme/widgets",
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
  const input = (
    pr: number,
    head: string,
    verdict: "revision_recommended" | "no_blocking_findings" = "revision_recommended",
  ) =>
    protocol.inputSchema.parse({
      prNumber: pr,
      expectedHeadSha: head,
      ticketId: "ACME-TICKET-001",
      verdict,
      summary: "Looks fine overall.",
      findings: [
        { id: "H1", severity: "high", title: "One", evidence: "e1" },
        { id: "H2", severity: "high", title: "Two", evidence: "e2" },
        { id: "L1", severity: "low", title: "Three", evidence: "e3" },
      ],
      idempotencyKey: "key-0123456789abcdef",
    });
  const render = (pr: number, head: string, verdict?: "no_blocking_findings") => {
    const payload = protocol.buildReviewPayload(input(pr, head, verdict), null);
    return protocol.composeReviewComment(payload, "e".repeat(32));
  };
  const PR = { number: 5, headSha: HEAD };
  const trusted = { trustedAuthors: ["reviewer-bot"] };
  const withComments = (comments: unknown[]) =>
    evidenceFor((u) =>
      u.pathname.endsWith("/comments") ? json(comments) : json({}, { status: 404 }),
    ).evidence;

  test("a genuine review verifies, carries its payload and is fresh", async () => {
    const ev = withComments([
      comment(1, "just chatting"),
      comment(2, render(5, HEAD), "reviewer-bot"),
    ]);
    const got = await listAdvisoryReviews(ev, protocol, PR, trusted);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({
      kind: "advisory",
      commentId: 2,
      author: "reviewer-bot",
      provenance: "trusted_author",
      integrity: "verified",
      reviewedHeadSha: HEAD,
      stale: false,
      verdict: "revision_recommended",
      ticketId: "ACME-TICKET-001",
      findingsBySeverity: { high: 2, low: 1 },
    });
    expect(got[0]?.review?.summary).toBe("Looks fine overall.");
    expect(got[0]?.reviewDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  test("an altered payload is a mismatch with no payload", async () => {
    const body = render(5, HEAD);
    const forged = body.replace(/payload=([A-Za-z0-9_-]+)/, (_m, p: string) => {
      const obj = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
      obj.verdict = "no_blocking_findings";
      return `payload=${Buffer.from(JSON.stringify(obj)).toString("base64url")}`;
    });
    const [r] = await listAdvisoryReviews(
      withComments([comment(1, forged)]),
      protocol,
      PR,
      trusted,
    );
    expect(r?.integrity).toBe("mismatch");
    expect(r?.review).toBeUndefined();
    expect(r?.verdict).toBeNull();
    expect(r?.findingsBySeverity).toBeUndefined();
  });

  test("a garbled or truncated marker is unreadable, stale and payload-free", async () => {
    const garbled = `<!-- ${protocol.reservedMarkerPrefix}engineering-review v1 pr=x -->`;
    const bodies = [
      `<!-- ${protocol.reservedMarkerPrefix}engineering-review v1 nonsense -->`,
      garbled,
    ];
    const [a, b] = await listAdvisoryReviews(
      withComments(bodies.map((b, i) => comment(i + 1, b))),
      protocol,
      PR,
      trusted,
    );
    for (const r of [a, b]) {
      expect(r?.integrity).toBe("unreadable");
      expect(r?.stale).toBe(true);
      expect(r?.review).toBeUndefined();
      expect(r?.reviewedHeadSha).toBeNull();
    }
    const full = render(5, HEAD);
    const cut = full.indexOf("payload=") + 20;
    const ev = evidenceFor(() => json([comment(1, full)]), { maxTextChars: cut }).evidence;
    const [t] = await listAdvisoryReviews(ev, protocol, PR, trusted);
    expect(t?.integrity).toBe("unreadable");
    expect(t?.review).toBeUndefined();
  });

  test("a marker copied from another PR is a mismatch; another head is stale", async () => {
    const ev = withComments([
      comment(1, render(9, HEAD), "reviewer-bot"),
      comment(2, render(5, OTHER), "reviewer-bot"),
    ]);
    const [copied, old] = await listAdvisoryReviews(ev, protocol, PR, trusted);
    expect(copied?.integrity).toBe("mismatch");
    expect(copied?.review).toBeUndefined();
    expect(old).toMatchObject({ integrity: "verified", stale: true, reviewedHeadSha: OTHER });
  });

  test("provenance follows the caller's trusted authors", async () => {
    const ev = withComments([
      comment(1, render(5, HEAD), "mallory"),
      comment(2, render(5, HEAD), null),
    ]);
    const untrustedList = await listAdvisoryReviews(ev, protocol, PR, trusted);
    expect(untrustedList.map((r) => r.provenance)).toEqual([
      "untrusted_author",
      "untrusted_author",
    ]);
    const none = await listAdvisoryReviews(ev, protocol, PR, { trustedAuthors: [] });
    expect(none.map((r) => r.provenance)).toEqual(["author_not_verified", "author_not_verified"]);
  });

  test("latest is newest by createdAt then id, verified or not", async () => {
    const ev = withComments([
      comment(1, render(5, HEAD), "reviewer-bot", 10),
      comment(3, `<!-- ${protocol.reservedMarkerPrefix}engineering-review junk -->`, "mallory", 20),
      comment(2, render(5, HEAD), "reviewer-bot", 20),
    ]);
    expect((await latestAdvisoryReview(ev, protocol, PR, trusted))?.commentId).toBe(3);
    expect(
      await latestAdvisoryReview(withComments([comment(1, "hi")]), protocol, PR, trusted),
    ).toBeNull();
  });

  test("an incomplete comment listing is refused, not summarized", async () => {
    const all = Array.from({ length: 6 }, (_, i) => comment(i + 1, "x"));
    const { evidence } = evidenceFor((u) => paged(all, u), { perPage: 2, maxPages: 2 });
    expect((await failure(listAdvisoryReviews(evidence, protocol, PR, trusted))).code).toBe(
      "incomplete",
    );
  });
});
