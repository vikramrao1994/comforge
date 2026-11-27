import { describe, expect, test } from "bun:test";
import {
  type CompletionProtocolConfig,
  createCompletionProtocol,
  createReviewProtocol,
  isReviewStale,
  type ReviewProtocolConfig,
  reviewProvenance,
} from "../src/index.ts";

// Review and completion-record contracts under a neutral identity. Records published under a
// consumer's own identity are frozen in that consumer's tests.

const REVIEW: ReviewProtocolConfig = {
  reviewScheme: "example-engineering-review/v1",
  repository: "example/widgets",
  markerNamespace: "example-bot",
  publisherName: "Example Bot",
  publishToolName: "post_review",
  ticketPattern: /^WID-[0-9]+$/,
  limits: {
    summaryMaxChars: 500,
    findingsMax: 5,
    findingTitleMaxChars: 80,
    findingTextMaxChars: 500,
    notesMax: 3,
    noteMaxChars: 200,
  },
};
const redacted: string[] = [];
const COMPLETION: CompletionProtocolConfig = {
  completionScheme: "example-engineering-completion/v1",
  repository: "example/widgets",
  markerNamespace: "example-records",
  ticketPattern: /^WID-[0-9]+$/,
  reservedMarkerPrefixes: ["example-bot:", "example-records:"],
  runner: { id: "example-runner", label: "Example Runner" },
  publishCommand: "make complete",
  links: {
    comment: (issue, id) => `https://forge.example/widgets/issues/${issue}/comments/${id}`,
    blob: (commit, path) => `https://forge.example/widgets/raw/${commit}/${path}`,
  },
  redact: (value) => {
    redacted.push(value);
    return value.includes("TOPSECRET")
      ? { count: 1, kinds: ["example-secret"] }
      : { count: 0, kinds: [] };
  },
};
const reviews = createReviewProtocol(REVIEW);
const completions = createCompletionProtocol(COMPLETION);
const HEAD = "a".repeat(40);

describe("review protocol", () => {
  const input = reviews.inputSchema.parse({
    prNumber: 3,
    expectedHeadSha: HEAD,
    ticketId: "WID-1",
    verdict: "no_blocking_findings",
    summary: "Looks fine.",
    findings: [],
    idempotencyKey: "example-review-key-01",
  });
  const payload = reviews.buildReviewPayload(input, null);
  const comment = reviews.composeReviewComment(payload, "f".repeat(32));

  test("renders and parses under the configured identity only", () => {
    expect(payload.repository).toBe("example/widgets");
    expect(comment).toContain("published via Example Bot `post_review`");
    expect(comment).toContain(
      `<!-- example-bot:engineering-review v1 pr=3 head=${HEAD} ticket=WID-1 `,
    );
    const marker = reviews.parseReviewMarker(comment);
    expect(marker && reviews.decodeReview(marker).integrity).toBe("verified");
    const other = createReviewProtocol({ ...REVIEW, markerNamespace: "other-bot" });
    expect(other.parseReviewMarker(comment)).toBeNull();
    const otherRepo = createReviewProtocol({ ...REVIEW, repository: "example/other" });
    expect(marker && otherRepo.decodeReview(marker).integrity).toBe("mismatch");
  });

  test("the payload carries no author: trust is the caller's observation", () => {
    expect(Object.keys(payload)).not.toContain("author");
    expect(reviews.payloadSchema.safeParse({ ...payload, author: "owner" }).success).toBe(false);
    expect(reviewProvenance("owner", [])).toBe("author_not_verified");
    expect(reviewProvenance("owner", ["owner"])).toBe("trusted_author");
    expect(reviewProvenance("mallory", ["owner"])).toBe("untrusted_author");
    expect(reviewProvenance(null, ["owner"])).toBe("untrusted_author");
  });

  test("a review is current only at the exact head the caller observed", () => {
    expect(isReviewStale(payload.reviewedHeadSha, HEAD)).toBe(false);
    expect(isReviewStale(payload.reviewedHeadSha, "b".repeat(40))).toBe(true);
  });

  test("the reserved prefix follows the namespace", () => {
    expect(reviews.reservedMarkerPrefix).toBe("example-bot:");
    expect(reviews.containsReservedMarker({ ...input, summary: "x example-bot:y" })).toBe(true);
    expect(reviews.containsReservedMarker({ ...input, summary: "x other-mcp:y" })).toBe(false);
  });
});

describe("completion protocol", () => {
  const input = completions.inputSchema.parse({
    contract: "example-engineering-completion/v1",
    issueNumber: 9,
    ticketId: "WID-1",
    specificationDigest: "d".repeat(64),
    issueType: "audit",
    outcome: "completed",
    sourceRevision: HEAD,
    execution: { runner: "example-runner" },
    summary: "Audited.",
    sections: { verdict: "Fine.", recommendations: "None." },
    evidence: [{ path: "docs/report.md", commit: HEAD }],
  });
  const payload = completions.buildCompletionPayload(input, {
    digestVerified: true,
    ledgerGates: [],
    supersedes: [41],
  });
  const comment = completions.composeCompletionComment(payload);

  test("renders with the injected runner, command and links, and round-trips", () => {
    expect(comment).toContain("- Executed by: Example Runner");
    expect(comment).toContain("published with `make complete`");
    expect(comment).toContain("- Supersedes: https://forge.example/widgets/issues/9/comments/41");
    expect(comment).toContain(`(https://forge.example/widgets/raw/${HEAD}/docs/report.md)`);
    const marker = completions.parseCompletionMarker(comment);
    expect(marker && completions.decodeCompletion(marker)).toEqual({
      integrity: "verified",
      payload,
    });
    expect(
      completions.inputSchema.safeParse({ ...input, execution: { runner: "claude-code-local" } })
        .success,
    ).toBe(false);
  });

  test("secret detection is the injected redactor's, applied to every published text", () => {
    redacted.length = 0;
    expect(completions.contentProblems(input)).toEqual([]);
    expect(redacted).toContain("Audited.");
    expect(completions.textProblems(["the TOPSECRET value"])).toEqual([
      "text contains secret-like values (example-secret)",
    ]);
    expect(completions.textProblems(["see example-bot:x and example-records:y"])).toEqual([
      "text contains a reserved server marker prefix",
    ]);
  });

  test("supersession is explicit, and replay ignores it", () => {
    expect(payload.supersedes).toEqual([41]);
    expect(completions.sameResult(payload, { ...payload, supersedes: [] })).toBe(true);
  });
});

describe("configuration is validated at construction", () => {
  test("review identity values that could break markers or rendering are refused", () => {
    for (const patch of [
      { reviewScheme: "nope" },
      { repository: "no-slash" },
      { markerNamespace: "Bad:ns" },
      { publisherName: "Evil -->" },
      { publishToolName: "Post-Review" },
      { ticketPattern: "^WID$" as unknown as RegExp },
    ])
      expect(() => createReviewProtocol({ ...REVIEW, ...patch })).toThrow(
        /invalid review protocol/,
      );
  });

  test("completion policy must reserve its own prefix and supply a redactor and links", () => {
    for (const patch of [
      { reservedMarkerPrefixes: ["example-bot:"] },
      { reservedMarkerPrefixes: ["example-records:", ""] },
      { runner: { id: "Example Runner", label: "Example Runner" } },
      { runner: { id: "example-runner", label: "Example `Runner`" } },
      { publishCommand: "make `complete`" },
      { redact: undefined as unknown as CompletionProtocolConfig["redact"] },
      {
        links: {
          comment: COMPLETION.links.comment,
        } as unknown as CompletionProtocolConfig["links"],
      },
    ])
      expect(() => createCompletionProtocol({ ...COMPLETION, ...patch })).toThrow(
        /invalid completion protocol/,
      );
  });
});
