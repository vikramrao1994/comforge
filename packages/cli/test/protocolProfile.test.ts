import { describe, expect, test } from "bun:test";
import {
  ADVISORY_REVIEW_NOTICE,
  COMPLETION_NOTICE,
  canonicalBody,
  canonicalTitle,
  idempotencyKeyDigest,
  isReviewStale,
  reviewProvenance,
} from "@comforge/core";
import { type ComforgeConfig, parseConfig } from "../src/config.ts";
import {
  COMPLETION_VOCABULARY,
  canonicalText,
  createProtocolServices,
  PROTOCOL_PROFILE_SCHEMA,
  type ProtocolProfile,
  profileFromConfig,
  REVIEW_VOCABULARY,
  reviewTrust,
} from "../src/protocolProfile.ts";
import { completionProtocol, reviewProtocol, specificationProtocol } from "../src/protocols.ts";
import { baseConfig } from "./harness.ts";

// The profile interface must serialize exactly what the configuration-bound factories do, and
// its policy floor (reserved prefixes, credential detection) must never be loosened by a host.

const REVIEW = {
  reviewScheme: "acme-review/v1",
  markerNamespace: "acme-review",
  publisherName: "Acme Reviews",
  publishToolName: "acme_create_review",
};

function configWith(extra: Record<string, unknown> = {}): ComforgeConfig {
  return parseConfig(JSON.stringify(baseConfig({ review: REVIEW, ...extra })), "test");
}

const SHA = "a".repeat(40);
const DIGEST = "b".repeat(64);
const TICKET = "WID-7";

function completionInput(
  protocol: ReturnType<typeof completionProtocol>,
  over: Record<string, unknown> = {},
) {
  return protocol.inputSchema.parse({
    contract: protocol.scheme,
    issueNumber: 5,
    ticketId: TICKET,
    specificationDigest: DIGEST,
    issueType: "audit",
    outcome: "completed",
    sourceRevision: SHA,
    execution: { runner: "test-agent" },
    summary: "Checked the widget pipeline.",
    sections: { verdict: "Sound.", recommendations: "None." },
    ...over,
  });
}

function reviewInput(over: Record<string, unknown> = {}) {
  return {
    prNumber: 9,
    expectedHeadSha: SHA,
    ticketId: TICKET,
    verdict: "no_blocking_findings" as const,
    summary: "Looks fine.",
    findings: [],
    acceptedLimitations: [],
    outOfScope: [],
    idempotencyKey: "review-key-0123456789",
    ...over,
  };
}

/** A neutral profile that does not come from a configuration. */
function profile(over: Partial<ProtocolProfile> = {}): ProtocolProfile {
  return {
    schema: PROTOCOL_PROFILE_SCHEMA,
    repository: "acme/widgets",
    ticketPattern: /^WID-[0-9]+$/,
    specification: {
      digestScheme: "acme-spec/v1",
      markerNamespace: "acme-spec",
      publisherName: "Acme Specs",
      publishToolName: "acme_create_issue",
    },
    review: {
      ...REVIEW,
      limits: {
        summaryMaxChars: 4000,
        findingsMax: 50,
        findingTitleMaxChars: 200,
        findingTextMaxChars: 4000,
        notesMax: 20,
        noteMaxChars: 1000,
      },
    },
    completion: {
      scheme: "acme-completion/v1",
      markerNamespace: "acme-lifecycle",
      runner: { id: "test-agent", label: "test agent" },
      publishCommand: "acme complete",
      links: {
        comment: (issue, comment) => `https://example.test/${issue}#c${comment}`,
        blob: (commit, file) => `https://example.test/blob/${commit}/${file}`,
      },
    },
    ...over,
  };
}

function completionOf(p: ProtocolProfile) {
  const completion = createProtocolServices(p).completion;
  if (!completion) throw new Error("profile has no completion section");
  return completion;
}

const TOKEN = `ghp_${"A1b2".repeat(9)}`;

describe("profile parity with the configuration-bound factories", () => {
  const config = configWith();
  const services = createProtocolServices(profileFromConfig(config));
  const oldSpec = specificationProtocol(config);
  const oldReview = reviewProtocol(config);
  const oldCompletion = completionProtocol(config);

  test("every section is present and carries the same identity", () => {
    expect(services.schema).toBe(PROTOCOL_PROFILE_SCHEMA);
    expect(services.repository).toBe("acme/widgets");
    expect(services.specification?.digestScheme).toBe(oldSpec?.digestScheme as string);
    expect(services.specification?.reservedMarkerPrefix).toBe(
      oldSpec?.reservedMarkerPrefix as string,
    );
    expect(services.specification?.executionNotAuthorized).toBe(
      oldSpec?.executionNotAuthorized as string,
    );
    expect(services.review?.scheme).toBe(oldReview?.scheme as string);
    expect(services.review?.reservedMarkerPrefix).toBe(oldReview?.reservedMarkerPrefix as string);
    expect(services.completion?.scheme).toBe(oldCompletion.scheme);
    expect(services.completion?.markerPrefix).toBe(oldCompletion.markerPrefix);
    expect(Object.isFrozen(services)).toBe(true);
  });

  test("specification: digest, body and verification are byte-identical and cross-verify", () => {
    const a = services.specification;
    const b = oldSpec;
    if (!a || !b) throw new Error("missing specification protocol");
    const spec = { ticketId: TICKET, title: "  Widget spec ", body: "Line one  \r\nLine two\n\n" };
    const digest = a.specificationDigest(spec);
    expect(digest).toBe(b.specificationDigest(spec));
    const compose = { ticketId: TICKET, body: spec.body, digest, keyDigest: "c".repeat(32) };
    const bodyA = a.composeIssueBody(compose);
    expect(bodyA).toBe(b.composeIssueBody(compose));
    expect(a.parsePublishedMarker(bodyA)).toEqual(b.parsePublishedMarker(bodyA) as never);
    expect(a.extractSpecificationBody(bodyA)).toBe(b.extractSpecificationBody(bodyA) as string);
    const issue = { title: spec.title, body: bodyA };
    expect(a.verifyPublishedSpecification(issue)?.digestMatches).toBe(true);
    expect(b.verifyPublishedSpecification(issue)).toEqual(a.verifyPublishedSpecification(issue));
  });

  test("review: comment bytes, digest and decoding are identical in both directions", () => {
    const a = services.review;
    const b = oldReview;
    if (!a || !b) throw new Error("missing review protocol");
    const payloadA = a.buildReviewPayload(a.inputSchema.parse(reviewInput()), null);
    const payloadB = b.buildReviewPayload(b.inputSchema.parse(reviewInput()), null);
    expect(a.serializeReviewPayload(payloadA)).toBe(b.serializeReviewPayload(payloadB));
    expect(a.reviewDigest(a.serializeReviewPayload(payloadA))).toBe(
      b.reviewDigest(b.serializeReviewPayload(payloadB)),
    );
    const keyDigest = idempotencyKeyDigest("review-key-0123456789");
    const commentA = a.composeReviewComment(payloadA, keyDigest);
    const commentB = b.composeReviewComment(payloadB, keyDigest);
    expect(commentA).toBe(commentB);
    for (const [reader, comment] of [
      [a, commentB],
      [b, commentA],
    ] as const) {
      const marker = reader.parseReviewMarker(comment);
      expect(marker).not.toBeNull();
      expect(reader.decodeReview(marker as never).integrity).toBe("verified");
    }
  });

  test("completion: comment bytes, digest and decoding are identical in both directions", () => {
    const a = services.completion;
    if (!a) throw new Error("missing completion protocol");
    const b = oldCompletion;
    const ctx = { digestVerified: true, ledgerGates: [], supersedes: [3] };
    const payloadA = a.buildCompletionPayload(completionInput(a), ctx);
    const payloadB = b.buildCompletionPayload(completionInput(b), ctx);
    const serialized = a.serializeCompletionPayload(payloadA);
    expect(serialized).toBe(b.serializeCompletionPayload(payloadB));
    expect(a.completionDigest(serialized)).toBe(b.completionDigest(serialized));
    const commentA = a.composeCompletionComment(payloadA);
    const commentB = b.composeCompletionComment(payloadB);
    expect(commentA).toBe(commentB);
    expect(commentA).toContain(`https://github.com/acme/widgets/issues/5#issuecomment-3`);
    for (const [reader, comment] of [
      [a, commentB],
      [b, commentA],
    ] as const) {
      const marker = reader.parseCompletionMarker(comment);
      expect(marker).not.toBeNull();
      expect(reader.decodeCompletion(marker as never).integrity).toBe("verified");
    }
  });

  test("completion text checks agree with the configuration-bound policy", () => {
    const a = completionOf(profileFromConfig(config));
    const samples = [
      "plain text",
      `token ${TOKEN}`,
      "contains acme-spec: prefix",
      "contains acme-lifecycle: prefix",
      "contains comforge-cli: prefix",
      "<!-- hidden -->",
      "see /Users/someone/file",
      "ping @someone",
    ];
    for (const sample of samples)
      expect(a.textProblems([sample])).toEqual(oldCompletion.textProblems([sample]));
    expect(a.textProblems(["contains comforge-cli: prefix"]).length).toBeGreaterThan(0);
  });
});

describe("profiles with only some sections", () => {
  test("absent sections are null, present ones are built", () => {
    const only = createProtocolServices({
      ...profile(),
      specification: undefined,
      review: undefined,
    });
    expect(only.specification).toBeNull();
    expect(only.review).toBeNull();
    expect(only.completion).not.toBeNull();

    const specOnly = createProtocolServices({
      ...profile(),
      review: undefined,
      completion: undefined,
    });
    expect(specOnly.specification).not.toBeNull();
    expect(specOnly.review).toBeNull();
    expect(specOnly.completion).toBeNull();

    const bare = createProtocolServices({
      schema: PROTOCOL_PROFILE_SCHEMA,
      repository: "acme/widgets",
      ticketPattern: /^WID-[0-9]+$/,
    });
    expect([bare.specification, bare.review, bare.completion]).toEqual([null, null, null]);
  });

  test("a configuration without optional sections yields a matching profile", () => {
    const config = parseConfig(JSON.stringify(baseConfig()), "test");
    const services = createProtocolServices(profileFromConfig(config));
    expect(services.review).toBeNull();
    expect(services.specification).not.toBeNull();
    expect(services.completion).not.toBeNull();
  });
});

describe("profile version handling", () => {
  test.each([
    ["missing", undefined],
    ["v0", "comforge-protocol-profile/v0"],
    ["v2", "comforge-protocol-profile/v2"],
  ])("a profile whose schema is %s is refused", (_name, schema) => {
    const bad = { ...profile(), schema } as unknown as ProtocolProfile;
    expect(() => createProtocolServices(bad)).toThrow(TypeError);
    expect(() => createProtocolServices(bad)).toThrow(/unsupported profile/);
  });

  test("a missing profile is refused rather than guessed", () => {
    expect(() => createProtocolServices(undefined as never)).toThrow(TypeError);
  });
});

describe("malformed profiles are refused", () => {
  test.each([
    ["repository without owner", { repository: "widgets" }],
    ["repository with extra segment", { repository: "a/b/c" }],
    ["ticketPattern that is a string", { ticketPattern: "^WID-[0-9]+$" }],
  ])("%s", (_name, patch) => {
    expect(() =>
      createProtocolServices({ ...profile(), ...patch } as unknown as ProtocolProfile),
    ).toThrow(TypeError);
  });

  test("a marker namespace outside the grammar", () => {
    const base = profile();
    for (const markerNamespace of ["Acme", "1acme", "acme_x", "", "a".repeat(64)]) {
      expect(() =>
        createProtocolServices({
          ...base,
          completion: { ...(base.completion as object), markerNamespace } as never,
        }),
      ).toThrow(/invalid marker namespace/);
      expect(() =>
        createProtocolServices({
          ...base,
          specification: { ...(base.specification as object), markerNamespace } as never,
        }),
      ).toThrow(/invalid marker namespace/);
    }
  });

  test("a malformed alsoReserved entry", () => {
    const base = profile();
    for (const entry of ["acme-sec", "Acme:", ":", "acme sec:", 7]) {
      expect(() =>
        createProtocolServices({
          ...base,
          completion: { ...(base.completion as object), alsoReserved: [entry] } as never,
        }),
      ).toThrow(/invalid reserved marker prefix/);
    }
  });

  test("a detectSecrets that is not a function", () => {
    const base = profile();
    expect(() =>
      createProtocolServices({
        ...base,
        completion: { ...(base.completion as object), detectSecrets: "nope" } as never,
      }),
    ).toThrow(/detectSecrets must be a function/);
  });
});

describe("reserved marker prefixes cannot shrink", () => {
  test("the specification's and the completion's own prefix are always reported", () => {
    const completion = completionOf(profile());
    const input = completionInput(completion, {
      summary: "mentions acme-spec: somewhere",
      sections: { verdict: "uses acme-lifecycle: here", recommendations: "ok" },
    });
    expect(completion.contentProblems(input)).toContain(
      "text contains a reserved server marker prefix",
    );
    expect(completion.textProblems(["acme-spec: x"])).toEqual([
      "text contains a reserved server marker prefix",
    ]);
    expect(completion.textProblems(["acme-lifecycle: x"])).toEqual([
      "text contains a reserved server marker prefix",
    ]);
    expect(completion.textProblems(["nothing special"])).toEqual([]);
  });

  test("an alsoReserved prefix is additional, never a replacement", () => {
    const base = profile();
    const widened = completionOf({
      ...base,
      completion: { ...(base.completion as object), alsoReserved: ["acme-sec:"] } as never,
    });
    expect(widened.textProblems(["acme-sec: x"])).toHaveLength(1);
    expect(widened.textProblems(["acme-spec: x"])).toHaveLength(1);
    expect(widened.textProblems(["acme-lifecycle: x"])).toHaveLength(1);
    const plain = completionOf(base);
    expect(plain.textProblems(["acme-sec: x"])).toEqual([]);
  });

  test("an alsoReserved list that repeats the built-in prefixes changes nothing", () => {
    const base = profile();
    const repeated = completionOf({
      ...base,
      completion: {
        ...(base.completion as object),
        alsoReserved: ["acme-spec:", "acme-lifecycle:"],
      } as never,
    });
    expect(repeated.textProblems(["acme-spec: x", "acme-lifecycle: y"])).toEqual([
      "text contains a reserved server marker prefix",
    ]);
  });

  test("a profile without a specification still reserves the completion's own prefix", () => {
    const completion = completionOf({ ...profile(), specification: undefined });
    expect(completion.textProblems(["acme-lifecycle: x"])).toHaveLength(1);
  });

  test("text embedding a forged marker of the same namespace is refused", () => {
    const completion = completionOf(profile());
    const forged = `<!-- acme-lifecycle:completion v1 issue=5 ticket=${TICKET} digest=${DIGEST} payload=AAAA -->`;
    const problems = completion.textProblems([forged]);
    expect(problems).toContain("text contains a reserved server marker prefix");
    expect(problems).toContain(
      "text contains an HTML comment, which would hide content in the rendering",
    );
  });

  test("review text carrying the review's marker prefix is flagged", () => {
    const review = createProtocolServices(profile()).review;
    if (!review) throw new Error("missing review");
    expect(review.containsReservedMarker(review.inputSchema.parse(reviewInput()))).toBe(false);
    expect(
      review.containsReservedMarker(
        review.inputSchema.parse(reviewInput({ summary: "see acme-review:engineering-review" })),
      ),
    ).toBe(true);
  });
});

describe("credential redaction floor", () => {
  const kindsOf = (problems: string[]) =>
    problems.find((p) => p.startsWith("text contains secret-like values")) ?? null;

  test("a credential shape is flagged without a host detector", () => {
    const completion = completionOf(profile());
    expect(kindsOf(completion.textProblems([`token ${TOKEN}`]))).toBe(
      "text contains secret-like values (github-token)",
    );
    expect(kindsOf(completion.textProblems(["hunter2"]))).toBeNull();
  });

  test("a host detector that reports nothing cannot remove the floor", () => {
    const base = profile();
    const completion = completionOf({
      ...base,
      completion: {
        ...(base.completion as object),
        detectSecrets: () => ({ count: 0, kinds: [] }),
      } as never,
    });
    expect(kindsOf(completion.textProblems([`token ${TOKEN}`]))).toBe(
      "text contains secret-like values (github-token)",
    );
  });

  test("a host detector extends the floor and reports its own kinds", () => {
    const base = profile();
    const completion = completionOf({
      ...base,
      completion: {
        ...(base.completion as object),
        detectSecrets: (text: string) =>
          text.includes("hunter2") ? { count: 1, kinds: ["password"] } : { count: 0, kinds: [] },
      } as never,
    });
    expect(kindsOf(completion.textProblems(["the word hunter2"]))).toBe(
      "text contains secret-like values (password)",
    );
    expect(kindsOf(completion.textProblems(["nothing here"]))).toBeNull();
  });

  test("when both detectors flag a text, the host's kinds are reported", () => {
    const base = profile();
    const completion = completionOf({
      ...base,
      completion: {
        ...(base.completion as object),
        detectSecrets: () => ({ count: 2, kinds: ["custom-a", "custom-b"] }),
      } as never,
    });
    expect(kindsOf(completion.textProblems([`token ${TOKEN}`]))).toBe(
      "text contains secret-like values (custom-a, custom-b)",
    );
  });

  test("content checks over a whole result also apply the floor", () => {
    const completion = completionOf(profile());
    const input = completionInput(completion, { summary: `leaked ${TOKEN}` });
    expect(completion.contentProblems(input)).toEqual([
      "text contains secret-like values (github-token)",
    ]);
  });
});

describe("forged, stale and malformed markers", () => {
  const services = createProtocolServices(profile());
  const review = services.review;
  const completion = services.completion;
  if (!review || !completion) throw new Error("profile sections missing");

  const reviewComment = review.composeReviewComment(
    review.buildReviewPayload(review.inputSchema.parse(reviewInput()), null),
    idempotencyKeyDigest("review-key-0123456789"),
  );
  const completionComment = completion.composeCompletionComment(
    completion.buildCompletionPayload(completionInput(completion), {
      digestVerified: true,
      ledgerGates: [],
      supersedes: [],
    }),
  );
  const retarget = (comment: string, from: RegExp, to: string) => comment.replace(from, to);
  const reencode = (comment: string, edit: (json: Record<string, unknown>) => void) =>
    comment.replace(/payload=([A-Za-z0-9_-]+)/, (_m, payload: string) => {
      const json = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
      edit(json);
      return `payload=${Buffer.from(JSON.stringify(json), "utf8").toString("base64url")}`;
    });

  test("an untouched review and completion verify", () => {
    expect(review.decodeReview(review.parseReviewMarker(reviewComment) as never).integrity).toBe(
      "verified",
    );
    expect(
      completion.decodeCompletion(completion.parseCompletionMarker(completionComment) as never)
        .integrity,
    ).toBe("verified");
  });

  test("a tampered review payload or digest is a mismatch", () => {
    const edited = reencode(reviewComment, (j) => {
      j.summary = "Approved by everyone.";
    });
    expect(review.decodeReview(review.parseReviewMarker(edited) as never).integrity).toBe(
      "mismatch",
    );
    const digestEdited = retarget(reviewComment, /digest=[0-9a-f]{64}/, `digest=${"0".repeat(64)}`);
    expect(review.decodeReview(review.parseReviewMarker(digestEdited) as never).integrity).toBe(
      "mismatch",
    );
    const headEdited = retarget(reviewComment, /head=[0-9a-f]{40}/, `head=${"d".repeat(40)}`);
    expect(review.decodeReview(review.parseReviewMarker(headEdited) as never).integrity).toBe(
      "mismatch",
    );
  });

  test("a tampered completion payload or digest is a mismatch", () => {
    const edited = reencode(completionComment, (j) => {
      j.outcome = "failed";
    });
    expect(
      completion.decodeCompletion(completion.parseCompletionMarker(edited) as never).integrity,
    ).toBe("mismatch");
    const digestEdited = retarget(
      completionComment,
      /digest=[0-9a-f]{64}/,
      `digest=${"0".repeat(64)}`,
    );
    expect(
      completion.decodeCompletion(completion.parseCompletionMarker(digestEdited) as never)
        .integrity,
    ).toBe("mismatch");
    const ticketEdited = retarget(completionComment, /ticket=WID-7/, "ticket=WID-8");
    expect(
      completion.decodeCompletion(completion.parseCompletionMarker(ticketEdited) as never)
        .integrity,
    ).toBe("mismatch");
  });

  test("an undecodable payload is unreadable, never verified", () => {
    const garbage = retarget(completionComment, /payload=[A-Za-z0-9_-]+/, "payload=AAAA");
    expect(completion.decodeCompletion(completion.parseCompletionMarker(garbage) as never)).toEqual(
      { integrity: "unreadable", payload: null },
    );
    const notJson = retarget(
      reviewComment,
      /payload=[A-Za-z0-9_-]+/,
      `payload=${Buffer.from("not json").toString("base64url")}`,
    );
    expect(review.decodeReview(review.parseReviewMarker(notJson) as never)).toEqual({
      integrity: "unreadable",
      payload: null,
    });
  });

  test("a record for another repository does not verify", () => {
    const other = createProtocolServices(profile({ repository: "acme/other" }));
    const comment = other.completion?.composeCompletionComment(
      other.completion.buildCompletionPayload(completionInput(other.completion), {
        digestVerified: true,
        ledgerGates: [],
        supersedes: [],
      }),
    ) as string;
    expect(
      completion.decodeCompletion(completion.parseCompletionMarker(comment) as never).integrity,
    ).toBe("mismatch");
  });

  test("a marker under another namespace or scheme is not parsed or does not verify", () => {
    const foreign = createProtocolServices(
      profile({
        completion: {
          ...(profile().completion as object),
          markerNamespace: "other-lifecycle",
        } as never,
        review: { ...(profile().review as object), markerNamespace: "other-review" } as never,
      }),
    );
    const foreignCompletion = foreign.completion?.composeCompletionComment(
      foreign.completion.buildCompletionPayload(completionInput(foreign.completion), {
        digestVerified: true,
        ledgerGates: [],
        supersedes: [],
      }),
    ) as string;
    expect(completion.parseCompletionMarker(foreignCompletion)).toBeNull();
    const foreignReview = foreign.review?.composeReviewComment(
      foreign.review.buildReviewPayload(foreign.review.inputSchema.parse(reviewInput()), null),
      idempotencyKeyDigest("review-key-0123456789"),
    ) as string;
    expect(review.parseReviewMarker(foreignReview)).toBeNull();
  });

  test("a record under another scheme parses but is unreadable here", () => {
    const rescheme = createProtocolServices(
      profile({
        completion: { ...(profile().completion as object), scheme: "acme-other/v1" } as never,
      }),
    );
    const comment = rescheme.completion?.composeCompletionComment(
      rescheme.completion.buildCompletionPayload(completionInput(rescheme.completion), {
        digestVerified: true,
        ledgerGates: [],
        supersedes: [],
      }),
    ) as string;
    const marker = completion.parseCompletionMarker(comment);
    expect(marker).not.toBeNull();
    expect(completion.decodeCompletion(marker as never).integrity).toBe("unreadable");
  });

  test("a body with no marker, or an empty one, parses to null", () => {
    expect(completion.parseCompletionMarker("just a comment")).toBeNull();
    expect(completion.parseCompletionMarker(null)).toBeNull();
    expect(review.parseReviewMarker(undefined)).toBeNull();
  });
});

describe("shared helpers and vocabulary", () => {
  test("review trust helpers", () => {
    expect(reviewTrust.isStale(SHA, SHA)).toBe(false);
    expect(reviewTrust.isStale(SHA, "e".repeat(40))).toBe(true);
    expect(reviewTrust.provenance("octo", [])).toBe("author_not_verified");
    expect(reviewTrust.provenance(null, [])).toBe("author_not_verified");
    expect(reviewTrust.provenance("octo", ["octo"])).toBe("trusted_author");
    expect(reviewTrust.provenance("mallory", ["octo"])).toBe("untrusted_author");
    expect(reviewTrust.provenance(null, ["octo"])).toBe("untrusted_author");
    expect(reviewTrust.isStale).toBe(isReviewStale);
    expect(reviewTrust.provenance).toBe(reviewProvenance);
  });

  test("canonical text functions are the kernel's", () => {
    expect(canonicalText.body).toBe(canonicalBody);
    expect(canonicalText.title).toBe(canonicalTitle);
    expect(canonicalText.idempotencyKeyDigest).toBe(idempotencyKeyDigest);
    expect(canonicalText.body("a  \r\n\r\n")).toBe("a");
  });

  test("vocabularies carry the kernel's fixed notices", () => {
    expect(REVIEW_VOCABULARY.notice).toBe(ADVISORY_REVIEW_NOTICE);
    expect(COMPLETION_VOCABULARY.notice).toBe(COMPLETION_NOTICE);
    expect(COMPLETION_VOCABULARY.deriveDisposition("implementation", "completed")).toBe(
      "open_until_merge",
    );
    expect(COMPLETION_VOCABULARY.deriveDisposition("audit", "blocked")).toBe("leave_open");
    expect(REVIEW_VOCABULARY.verdicts).toContain("no_blocking_findings");
  });
});
