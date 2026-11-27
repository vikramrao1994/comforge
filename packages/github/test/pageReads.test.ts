import { describe, expect, test } from "bun:test";
import { createReviewProtocol } from "@comforge/core";
import {
  createFetchTransport,
  createGitHubEvidence,
  GitHubAdapterError,
  listAdvisoryReviews,
} from "../src/index.ts";

// 0.6.0 additive reads: page windows, raw attribution fields, single comment, exact bytes and
// commit membership. A fake fetch stands in for GitHub.

const TOKEN = "ghs_SECRETtokenSECRETtoken9876";
const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const OLDER = "c".repeat(40);
const ROOT = "/repos/acme/widgets";
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
const BOM_TEXT = Buffer.from([0xef, 0xbb, 0xbf, 0x68, 0x69]); // BOM + "hi"

type Route = (url: URL) => Response | Promise<Response>;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function evidenceFor(route: Route) {
  const calls: URL[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    calls.push(url);
    return route(url);
  }) as typeof fetch;
  return {
    calls,
    evidence: createGitHubEvidence({
      transport: createFetchTransport({ token: TOKEN, fetchImpl }),
      repository: { owner: "acme", name: "widgets" },
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

const issue = (number: number, extra: Record<string, unknown> = {}) => ({
  number,
  title: `Issue ${number}`,
  body: "body",
  state: "open",
  html_url: `https://github.com/acme/widgets/issues/${number}`,
  user: { login: "alice" },
  labels: [{ name: "bug" }],
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-02T00:00:00Z",
  author_association: "OWNER",
  performed_via_github_app: { slug: "portfolio-mcp" },
  closed_at: null,
  comments: 3,
  ...extra,
});

const contents = (bytes: Buffer, extra: Record<string, unknown> = {}) => ({
  type: "file",
  path: "docs/a.png",
  sha: OLDER,
  size: bytes.length,
  encoding: "base64",
  content: bytes.toString("base64").replace(/(.{4})/g, "$1\n"),
  ...extra,
});

describe("page windows", () => {
  test("an issue page keeps GitHub's window, drops pull requests and counts them", async () => {
    const { evidence, calls } = evidenceFor(() =>
      json([issue(9), issue(8, { pull_request: { url: "x" } }), issue(7)]),
    );
    const w = await evidence.listIssuesPage({
      state: "open",
      labels: ["bug", "p1"],
      sort: "updated",
      direction: "desc",
      page: 2,
      perPage: 3,
    });
    expect(w.items.map((i) => i.number)).toEqual([9, 7]);
    expect(w).toMatchObject({ page: 2, perPage: 3, hasMore: true, excludedPullRequests: 1 });
    expect(Object.fromEntries(calls[0].searchParams)).toEqual({
      state: "open",
      sort: "updated",
      direction: "desc",
      labels: "bug,p1",
      per_page: "3",
      page: "2",
    });
    expect(calls).toHaveLength(1);
    expect(w.items[0]).toMatchObject({
      authorAssociation: "OWNER",
      performedViaGitHubApp: "portfolio-mcp",
      closedAt: null,
      commentCount: 3,
    });
  });

  test("a short page has no more; a page larger than requested is refused", async () => {
    const short = evidenceFor(() => json([issue(1)]));
    expect((await short.evidence.listIssuesPage({ perPage: 5 })).hasMore).toBe(false);
    const long = evidenceFor(() => json([issue(1), issue(2), issue(3)]));
    expect((await failure(long.evidence.listIssuesPage({ perPage: 2 }))).code).toBe(
      "malformed-response",
    );
  });

  test("page requests and filters are validated before any request", async () => {
    const { evidence, calls } = evidenceFor(() => json([]));
    for (const bad of [{ page: 0 }, { perPage: 101 }, { perPage: 1.5 }])
      expect((await failure(evidence.listIssuesPage(bad))).code).toBe("invalid-input");
    expect((await failure(evidence.listIssuesPage({ labels: ["a,b"] }))).code).toBe(
      "invalid-input",
    );
    expect(
      (await failure(evidence.listPullRequestsPage({ sort: "popularity" as "created" }))).code,
    ).toBe("invalid-input");
    expect(calls).toHaveLength(0);
  });

  test("pull request pages carry the base SHA", async () => {
    const { evidence, calls } = evidenceFor(() =>
      json([
        {
          number: 4,
          title: "t",
          state: "open",
          draft: true,
          merged_at: null,
          user: { login: "bob" },
          head: { ref: "feature", sha: HEAD },
          base: { ref: "main", sha: BASE },
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-03T00:00:00Z",
        },
      ]),
    );
    const w = await evidence.listPullRequestsPage({ state: "all", sort: "updated", perPage: 10 });
    expect(w.items[0]).toMatchObject({ number: 4, baseSha: BASE, draft: true, merged: false });
    expect(calls[0].searchParams.get("sort")).toBe("updated");
    expect(w.hasMore).toBe(false);
  });

  test("comments, events, reviews and inline review comments are windowed with attribution", async () => {
    const { evidence } = evidenceFor((url) => {
      if (url.pathname.endsWith("/issues/5/comments"))
        return json([
          {
            id: 1,
            user: { login: "app[bot]", type: "Bot" },
            author_association: "NONE",
            created_at: "c",
            updated_at: "u",
            body: "x",
            html_url: "https://github.com/acme/widgets/issues/5#issuecomment-1",
            performed_via_github_app: { slug: "portfolio-mcp" },
          },
        ]);
      if (url.pathname.endsWith("/issues/5/events"))
        return json([
          { event: "labeled", actor: { login: "owner" }, created_at: "t", label: { name: "go" } },
          { event: "closed", actor: null, created_at: "t2" },
        ]);
      if (url.pathname.endsWith("/pulls/5/reviews"))
        return json([
          { id: 2, user: { login: "r" }, state: "APPROVED", commit_id: HEAD, body: null },
        ]);
      if (url.pathname.endsWith("/pulls/5/comments"))
        return json([
          {
            id: 3,
            user: { login: "r" },
            path: "a.ts",
            line: null,
            commit_id: HEAD,
            created_at: "t",
            body: "nit",
          },
        ]);
      return json({}, 404);
    });
    const comments = await evidence.listIssueCommentsPage(5, { perPage: 50 });
    expect(comments.items[0]).toMatchObject({
      url: "https://github.com/acme/widgets/issues/5#issuecomment-1",
      performedViaGitHubApp: "portfolio-mcp",
      authorType: "Bot",
    });
    const events = await evidence.listIssueEventsPage(5, { perPage: 100 });
    expect(events.items).toEqual([
      {
        event: "labeled",
        actor: "owner",
        label: "go",
        performedViaGitHubApp: null,
        createdAt: "t",
      },
      { event: "closed", actor: null, label: null, performedViaGitHubApp: null, createdAt: "t2" },
    ]);
    const reviews = await evidence.listReviewsPage(5);
    expect(reviews.items[0]).toMatchObject({ id: 2, commitSha: HEAD, submittedAt: null });
    expect(reviews.items[0].body.text).toBe("");
    const inline = await evidence.listReviewCommentsPage(5);
    expect(inline.items[0]).toMatchObject({ path: "a.ts", line: null, commitSha: HEAD });
    expect(inline.items[0].body).toEqual({ text: "nit", truncated: false, trust: "untrusted" });
  });
});

describe("added fields on existing reads", () => {
  test("a pull request carries its body, timestamps and counts", async () => {
    const { evidence } = evidenceFor(() =>
      json({
        number: 5,
        title: "t",
        state: "closed",
        merged_at: "2026-01-05T00:00:00Z",
        html_url: "u",
        user: { login: "a" },
        base: { ref: "main", sha: BASE },
        head: { ref: "f", sha: HEAD, repo: { full_name: "acme/widgets" } },
        body: "Closes #4",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-05T00:00:00Z",
        commits: 3,
        changed_files: 7,
      }),
    );
    expect(await evidence.getPullRequest(5)).toMatchObject({
      merged: true,
      body: { text: "Closes #4", truncated: false },
      createdAt: "2026-01-01T00:00:00Z",
      mergedAt: "2026-01-05T00:00:00Z",
      commits: 3,
      changedFiles: 7,
    });
  });

  test("a response without the new fields still reads, with nulls", async () => {
    const { evidence } = evidenceFor(() =>
      json({
        number: 9,
        title: "t",
        body: null,
        state: "open",
        html_url: "u",
        user: null,
        created_at: "c",
        updated_at: "u",
      }),
    );
    expect(await evidence.getIssue(9)).toMatchObject({
      authorAssociation: "",
      performedViaGitHubApp: null,
      closedAt: null,
      commentCount: null,
    });
  });
});

describe("single comment", () => {
  const comment = (issueUrl: string) => ({
    id: 77,
    user: { login: "alice" },
    author_association: "OWNER",
    created_at: "c",
    updated_at: "u",
    body: "hello",
    html_url: "https://github.com/acme/widgets/pull/12#issuecomment-77",
    issue_url: issueUrl,
  });

  test("reads one comment with the issue it belongs to", async () => {
    const { evidence, calls } = evidenceFor(() =>
      json(comment("https://api.github.com/repos/acme/widgets/issues/12")),
    );
    const c = await evidence.getIssueComment(77);
    expect(c).toMatchObject({
      id: 77,
      issueNumber: 12,
      url: "https://github.com/acme/widgets/pull/12#issuecomment-77",
    });
    expect(calls[0].pathname).toBe(`${ROOT}/issues/comments/77`);
  });

  test("a comment of another repository is refused", async () => {
    const { evidence } = evidenceFor(() =>
      json(comment("https://api.github.com/repos/evil/widgets/issues/12")),
    );
    expect((await failure(evidence.getIssueComment(77))).code).toBe("wrong-target");
  });
});

describe("exact bytes at a commit", () => {
  test("binary bytes come back exactly, never decoded", async () => {
    const { evidence, calls } = evidenceFor(() => json(contents(PNG)));
    const f = await evidence.getFileBytesAtCommit(HEAD, "docs/a.png");
    expect(f.kind).toBe("bytes");
    if (f.kind !== "bytes") throw new Error("unreachable");
    expect(Buffer.from(f.bytes).equals(PNG)).toBe(true);
    expect(calls[0].searchParams.get("ref")).toBe(HEAD);
  });

  test("a byte-order mark survives (the text read would strip it)", async () => {
    const { evidence } = evidenceFor(() => json(contents(BOM_TEXT, { path: "docs/a.txt" })));
    const f = await evidence.getFileBytesAtCommit(HEAD, "docs/a.txt");
    if (f.kind !== "bytes") throw new Error("expected bytes");
    expect(Buffer.from(f.bytes).equals(BOM_TEXT)).toBe(true);
  });

  test("over the limit or without inline content is too-large; size mismatch is refused", async () => {
    expect(
      (
        await evidenceFor(() => json(contents(PNG))).evidence.getFileBytesAtCommit(
          HEAD,
          "docs/a.png",
          { maxBytes: 4 },
        )
      ).kind,
    ).toBe("too-large");
    expect(
      (
        await evidenceFor(() => json(contents(PNG, { content: "" }))).evidence.getFileBytesAtCommit(
          HEAD,
          "docs/a.png",
        )
      ).kind,
    ).toBe("too-large");
    const lying = evidenceFor(() => json(contents(PNG, { size: 99 })));
    expect((await failure(lying.evidence.getFileBytesAtCommit(HEAD, "docs/a.png"))).code).toBe(
      "malformed-response",
    );
  });

  test("a directory, a non-file or another path is refused with its reason", async () => {
    const dir = await failure(
      evidenceFor(() => json([])).evidence.getFileBytesAtCommit(HEAD, "docs"),
    );
    expect([dir.code, dir.detail.reason]).toEqual(["wrong-target", "not-a-file"]);
    const link = await failure(
      evidenceFor(() => json(contents(PNG, { type: "symlink" }))).evidence.getFileBytesAtCommit(
        HEAD,
        "docs/a.png",
      ),
    );
    expect(link.detail.reason).toBe("not-a-file");
    const moved = await failure(
      evidenceFor(() => json(contents(PNG, { path: "other.png" }))).evidence.getFileBytesAtCommit(
        HEAD,
        "docs/a.png",
      ),
    );
    expect(moved.detail.reason).toBe("other-path");
  });

  test("a branch name, unsafe path or bad limit is refused before any request", async () => {
    const { evidence, calls } = evidenceFor(() => json(contents(PNG)));
    expect((await failure(evidence.getFileBytesAtCommit("main", "a.png"))).code).toBe(
      "invalid-input",
    );
    expect((await failure(evidence.getFileBytesAtCommit(HEAD, "../a.png"))).code).toBe(
      "invalid-input",
    );
    expect(
      (await failure(evidence.getFileBytesAtCommit(HEAD, "a.png", { maxBytes: 0 }))).code,
    ).toBe("invalid-input");
    expect(calls).toHaveLength(0);
  });
});

describe("commit membership", () => {
  const pull = {
    number: 3,
    title: "t",
    state: "open",
    html_url: "u",
    user: null,
    base: { ref: "main", sha: BASE },
    head: { ref: "f", sha: HEAD },
  };

  test("the head, an earlier commit, or neither", async () => {
    const commits = [{ sha: OLDER }];
    const route: Route = (url) => (url.pathname.endsWith("/commits") ? json(commits) : json(pull));
    expect(await evidenceFor(route).evidence.pullRequestContainsCommit(3, HEAD)).toEqual({
      belongs: true,
      isHead: true,
    });
    expect(await evidenceFor(route).evidence.pullRequestContainsCommit(3, OLDER)).toEqual({
      belongs: true,
      isHead: false,
    });
    expect(await evidenceFor(route).evidence.pullRequestContainsCommit(3, BASE)).toEqual({
      belongs: false,
      isHead: false,
    });
  });

  test("reads at most maxCommits, in pages of 100", async () => {
    const full = Array.from({ length: 100 }, (_, i) => ({ sha: i.toString(16).padStart(40, "0") }));
    const { evidence, calls } = evidenceFor((url) =>
      url.pathname.endsWith("/commits") ? json(full) : json(pull),
    );
    expect(
      await evidence.pullRequestContainsCommit(3, "e".repeat(40), { maxCommits: 200 }),
    ).toEqual({
      belongs: false,
      isHead: false,
    });
    expect(calls.filter((c) => c.pathname.endsWith("/commits"))).toHaveLength(2);
  });
});

describe("advisory review metadata", () => {
  const protocol = createReviewProtocol({
    reviewScheme: "acme-review/v1",
    repository: "acme/widgets",
    markerNamespace: "acme",
    publisherName: "Acme",
    publishToolName: "acme_review",
    ticketPattern: /^[A-Z]+-\d+$/,
    limits: {
      summaryMaxChars: 2000,
      findingsMax: 20,
      findingTitleMaxChars: 120,
      findingTextMaxChars: 2000,
      notesMax: 10,
      noteMaxChars: 400,
    },
  });

  test("a review carries its URL, last edit and the pull request its marker names", async () => {
    const payload = protocol.buildReviewPayload(
      {
        prNumber: 5,
        expectedHeadSha: HEAD,
        ticketId: "ACME-1",
        verdict: "no_blocking_findings",
        summary: "fine",
        findings: [],
        acceptedLimitations: [],
        outOfScope: [],
        idempotencyKey: "k".repeat(32),
      } as never,
      null,
    );
    const body = protocol.composeReviewComment(payload, "f".repeat(32));
    const { evidence } = evidenceFor(() =>
      json([
        {
          id: 10,
          user: { login: "bot[bot]" },
          author_association: "NONE",
          created_at: "c",
          updated_at: "u2",
          body,
          html_url: "https://github.com/acme/widgets/pull/5#issuecomment-10",
        },
      ]),
    );
    const [review] = await listAdvisoryReviews(
      evidence,
      protocol,
      { number: 5, headSha: HEAD },
      { trustedAuthors: [] },
    );
    expect(review).toMatchObject({
      updatedAt: "u2",
      commentUrl: "https://github.com/acme/widgets/pull/5#issuecomment-10",
      markerPrNumber: 5,
    });
  });
});
