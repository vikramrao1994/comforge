import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { z } from "zod";
import { assertIdentity, hasControlCharacter } from "./identity.ts";
import { canonicalBody } from "./specification.ts";

/**
 * Advisory PR reviews: input contract, canonical payload, digest, rendering and
 * marker decoding. Pure: no I/O, no environment, no clock.
 *
 * A review is published as one PR conversation comment, never as a forge review
 * event, so it can never carry an approval state. The comment has a human-readable
 * rendering and one hidden marker that carries the structured review:
 *
 *   <!-- <namespace>:engineering-review v1 pr=<n> head=<40 hex> ticket=<id>
 *        digest=<64 hex> key=<32 hex> payload=<base64url JSON> -->
 *
 * digest = SHA-256 of `<reviewScheme>\n` + the payload JSON, which is serialized in
 * schema field order and so is its own canonical form. A reader recomputes the digest
 * from the decoded payload, so an edited payload reads as `integrity: "mismatch"`;
 * edits to the rendered Markdown do not change the structured review.
 *
 * The marker is unkeyed: anyone who can comment can forge one. `verified` integrity
 * proves only that the content is unaltered under the scheme. Who wrote it, whether
 * that author is trusted, and what the pull request's head is now are observations
 * the caller makes through its own trusted adapter and passes in; a review is
 * evidence, never an authorization of anything.
 */

export const ADVISORY_REVIEW_NOTICE =
  "Advisory review. It is not an approval, not a merge or deployment authorization and " +
  "not an authorization to implement a revision; each requires a separate explicit owner decision.";

export const REVIEW_VERDICTS = [
  "no_blocking_findings",
  "revision_recommended",
  "insufficient_evidence",
] as const;
export const FINDING_SEVERITIES = ["critical", "high", "medium", "low", "info"] as const;

// Stable, reviewer-chosen identifiers such as H1, M2, L1, SEC-3.
export const FINDING_ID_PATTERN = /^[A-Z][A-Z0-9]{0,7}(?:-[0-9]{1,4}|[0-9]{1,4})$/;

const SHA_PATTERN = /^[0-9a-f]{40}$/;

const singleLine = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((v) => v.trim().length > 0 && !hasControlCharacter(v), "a non-empty single line");
const text = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((v) => v.trim().length > 0, "non-empty text");

export interface ReviewLimits {
  summaryMaxChars: number;
  findingsMax: number;
  findingTitleMaxChars: number;
  findingTextMaxChars: number;
  notesMax: number;
  noteMaxChars: number;
}

function buildInputSchema(ticketPattern: RegExp, limits: ReviewLimits) {
  const FindingInputSchema = z
    .object({
      id: z.string().regex(FINDING_ID_PATTERN, "a stable finding ID such as H1, M2 or SEC-3"),
      severity: z.enum(FINDING_SEVERITIES),
      title: singleLine(limits.findingTitleMaxChars),
      evidence: text(limits.findingTextMaxChars),
      requiredCorrection: text(limits.findingTextMaxChars).optional(),
    })
    .strict();
  return z
    .object({
      prNumber: z.number().int().min(1).max(10_000_000),
      expectedHeadSha: z.string().regex(SHA_PATTERN, "the full 40-character head SHA reviewed"),
      ticketId: z.string().max(80).regex(ticketPattern, "an engineering ticket ID"),
      specificationIssueNumber: z.number().int().min(1).max(10_000_000).optional(),
      verdict: z.enum(REVIEW_VERDICTS),
      summary: text(limits.summaryMaxChars),
      findings: z
        .array(FindingInputSchema)
        .max(limits.findingsMax)
        .refine(
          (items) => new Set(items.map((item) => item.id)).size === items.length,
          "finding IDs must be unique",
        ),
      acceptedLimitations: z.array(text(limits.noteMaxChars)).max(limits.notesMax).default([]),
      outOfScope: z.array(text(limits.noteMaxChars)).max(limits.notesMax).default([]),
      idempotencyKey: z
        .string()
        .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/, "16–128 characters of [A-Za-z0-9._:-]"),
    })
    .strict();
}

function buildPayloadSchema(reviewScheme: string, ticketPattern: RegExp) {
  return z
    .object({
      scheme: z.literal(reviewScheme),
      repository: z.string(),
      prNumber: z.number().int().positive(),
      reviewedHeadSha: z.string().regex(SHA_PATTERN),
      ticketId: z.string().regex(ticketPattern),
      specification: z
        .object({
          issueNumber: z.number().int().positive(),
          digest: z.string().regex(/^[0-9a-f]{64}$/),
          digestVerified: z.boolean(),
        })
        .strict()
        .nullable(),
      verdict: z.enum(REVIEW_VERDICTS),
      summary: z.string(),
      findings: z.array(
        z
          .object({
            id: z.string(),
            severity: z.enum(FINDING_SEVERITIES),
            title: z.string(),
            evidence: z.string(),
            requiredCorrection: z.string().nullable(),
          })
          .strict(),
      ),
      acceptedLimitations: z.array(z.string()),
      outOfScope: z.array(z.string()),
    })
    .strict();
}

export type ReviewInputSchemaType = ReturnType<typeof buildInputSchema>;
export type ReviewPayloadSchemaType = ReturnType<typeof buildPayloadSchema>;
export type CreatePrReviewInput = z.infer<ReviewInputSchemaType>;
export type ReviewPayload = z.infer<ReviewPayloadSchemaType>;

export interface ReviewMarker {
  prNumber: number;
  headSha: string;
  ticketId: string;
  digest: string;
  keyDigest: string;
  payload: string;
}

export type ReviewIntegrity = "verified" | "mismatch" | "unreadable";

/** Trusted, construction-time identity, supplied from committed code. */
export interface ReviewProtocolConfig {
  reviewScheme: string;
  repository: string;
  markerNamespace: string;
  publisherName: string;
  publishToolName: string;
  ticketPattern: RegExp;
  limits: ReviewLimits;
}

export interface ReviewProtocol {
  readonly scheme: string;
  readonly repository: string;
  /** Client text containing this prefix could forge a server marker. */
  readonly reservedMarkerPrefix: string;
  readonly inputSchema: ReviewInputSchemaType;
  readonly payloadSchema: ReviewPayloadSchemaType;
  reviewTexts(input: CreatePrReviewInput): string[];
  containsReservedMarker(input: CreatePrReviewInput): boolean;
  buildReviewPayload(
    input: CreatePrReviewInput,
    specification: ReviewPayload["specification"],
  ): ReviewPayload;
  serializeReviewPayload(payload: ReviewPayload): string;
  reviewDigest(serializedPayload: string): string;
  /** Display only: readers use the marker payload, never this rendering. */
  composeReviewComment(payload: ReviewPayload, keyDigest: string): string;
  parseReviewMarker(body: string | null | undefined): ReviewMarker | null;
  /**
   * `verified` means the payload hashes to the marker's digest and agrees with the
   * marker's PR, head and ticket and with this protocol's repository. It says nothing
   * about who wrote it or whether the head is still current.
   */
  decodeReview(marker: ReviewMarker): { integrity: ReviewIntegrity; payload: ReviewPayload | null };
}

const SEVERITY_LABEL: Record<(typeof FINDING_SEVERITIES)[number], string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
  info: "Info",
};

const VERDICT_LABEL: Record<(typeof REVIEW_VERDICTS)[number], string> = {
  no_blocking_findings: "No blocking findings",
  revision_recommended: "Revision recommended",
  insufficient_evidence: "Insufficient evidence",
};

export function createReviewProtocol(config: ReviewProtocolConfig): ReviewProtocol {
  assertIdentity("review", "reviewScheme", "scheme", config.reviewScheme);
  assertIdentity("review", "repository", "repository", config.repository);
  assertIdentity("review", "markerNamespace", "markerNamespace", config.markerNamespace);
  assertIdentity("review", "publisherName", "label", config.publisherName);
  assertIdentity("review", "publishToolName", "toolName", config.publishToolName);
  if (!(config.ticketPattern instanceof RegExp))
    throw new TypeError("factory-core: invalid review protocol ticketPattern");
  const {
    reviewScheme,
    repository,
    markerNamespace,
    publisherName,
    publishToolName,
    ticketPattern,
  } = config;
  const limits = Object.freeze({ ...config.limits });
  const inputSchema = buildInputSchema(ticketPattern, limits);
  const payloadSchema = buildPayloadSchema(reviewScheme, ticketPattern);
  const reservedMarkerPrefix = `${markerNamespace}:`;
  const markerPattern = new RegExp(
    `<!-- ${markerNamespace}:engineering-review v1 pr=([0-9]{1,10}) head=([0-9a-f]{40}) ticket=([A-Z0-9-]{1,80}) digest=([0-9a-f]{64}) key=([0-9a-f]{32}) payload=([A-Za-z0-9_-]{1,200000}) -->`,
  );

  const reviewTexts: ReviewProtocol["reviewTexts"] = (input) => [
    input.summary,
    ...input.findings.flatMap((f) => [f.title, f.evidence, f.requiredCorrection ?? ""]),
    ...input.acceptedLimitations,
    ...input.outOfScope,
  ];

  const containsReservedMarker: ReviewProtocol["containsReservedMarker"] = (input) =>
    reviewTexts(input).some((value) => value.includes(reservedMarkerPrefix));

  const buildReviewPayload: ReviewProtocol["buildReviewPayload"] = (input, specification) => ({
    scheme: reviewScheme,
    repository,
    prNumber: input.prNumber,
    reviewedHeadSha: input.expectedHeadSha,
    ticketId: input.ticketId,
    specification,
    verdict: input.verdict,
    summary: canonicalBody(input.summary),
    findings: input.findings.map((f) => ({
      id: f.id,
      severity: f.severity,
      title: f.title.normalize("NFC").trim(),
      evidence: canonicalBody(f.evidence),
      requiredCorrection:
        f.requiredCorrection === undefined ? null : canonicalBody(f.requiredCorrection),
    })),
    acceptedLimitations: input.acceptedLimitations.map(canonicalBody),
    outOfScope: input.outOfScope.map(canonicalBody),
  });

  const serializeReviewPayload: ReviewProtocol["serializeReviewPayload"] = (payload) =>
    JSON.stringify(payloadSchema.parse(payload));

  const reviewDigest: ReviewProtocol["reviewDigest"] = (serializedPayload) =>
    createHash("sha256").update(`${reviewScheme}\n${serializedPayload}`, "utf8").digest("hex");

  const composeReviewComment: ReviewProtocol["composeReviewComment"] = (payload, keyDigest) => {
    const serialized = serializeReviewPayload(payload);
    const digest = reviewDigest(serialized);
    const lines: string[] = [
      `> [!NOTE]`,
      `> **${ADVISORY_REVIEW_NOTICE}**`,
      "",
      `## Advisory review — ${payload.ticketId}`,
      "",
      `- Reviewed head: \`${payload.reviewedHeadSha}\``,
      `- Verdict (advisory): **${VERDICT_LABEL[payload.verdict]}**`,
    ];
    if (payload.specification) {
      lines.push(
        `- Specification: #${payload.specification.issueNumber} \`${payload.specification.digest}\`` +
          (payload.specification.digestVerified
            ? " (digest verified at publication)"
            : " (digest NOT verified)"),
      );
    }
    lines.push("", "### Summary", "", payload.summary, "");
    if (payload.findings.length > 0) {
      lines.push("### Findings", "");
      for (const f of payload.findings) {
        lines.push(`#### ${f.id} · ${SEVERITY_LABEL[f.severity]} · ${f.title}`, "", f.evidence, "");
        if (f.requiredCorrection)
          lines.push(`**Required correction:** ${f.requiredCorrection}`, "");
      }
    }
    if (payload.acceptedLimitations.length > 0)
      lines.push(
        "### Accepted limitations",
        "",
        ...payload.acceptedLimitations.map((l) => `- ${l}`),
        "",
      );
    if (payload.outOfScope.length > 0)
      lines.push("### Out of scope", "", ...payload.outOfScope.map((l) => `- ${l}`), "");
    lines.push(
      "---",
      `<sub>Review digest \`${reviewScheme}:${digest}\` · published via ${publisherName} \`${publishToolName}\`</sub>`,
      `<!-- ${markerNamespace}:engineering-review v1 pr=${payload.prNumber} head=${payload.reviewedHeadSha} ticket=${payload.ticketId} digest=${digest} key=${keyDigest} payload=${Buffer.from(serialized, "utf8").toString("base64url")} -->`,
    );
    return lines.join("\n");
  };

  const parseReviewMarker: ReviewProtocol["parseReviewMarker"] = (body) => {
    const match = markerPattern.exec(body ?? "");
    if (!match) return null;
    const [, pr, headSha, ticketId, digest, keyDigest, payload] = match;
    if (!pr || !headSha || !ticketId || !digest || !keyDigest || !payload) return null;
    return { prNumber: Number(pr), headSha, ticketId, digest, keyDigest, payload };
  };

  const decodeReview: ReviewProtocol["decodeReview"] = (marker) => {
    let serialized: string;
    let parsed: ReviewPayload;
    try {
      serialized = Buffer.from(marker.payload, "base64url").toString("utf8");
      const result = payloadSchema.safeParse(JSON.parse(serialized));
      if (!result.success) return { integrity: "unreadable", payload: null };
      parsed = result.data;
    } catch {
      return { integrity: "unreadable", payload: null };
    }
    const consistent =
      reviewDigest(serialized) === marker.digest &&
      parsed.prNumber === marker.prNumber &&
      parsed.reviewedHeadSha === marker.headSha &&
      parsed.ticketId === marker.ticketId &&
      parsed.repository === repository;
    return { integrity: consistent ? "verified" : "mismatch", payload: parsed };
  };

  return Object.freeze({
    scheme: reviewScheme,
    repository,
    reservedMarkerPrefix,
    inputSchema,
    payloadSchema,
    reviewTexts,
    containsReservedMarker,
    buildReviewPayload,
    serializeReviewPayload,
    reviewDigest,
    composeReviewComment,
    parseReviewMarker,
    decodeReview,
  });
}

/**
 * A review applies only to the exact head it names. `currentHeadSha` must come from
 * the caller's trusted read of the pull request, never from the review itself.
 */
export function isReviewStale(reviewedHeadSha: string, currentHeadSha: string): boolean {
  return reviewedHeadSha !== currentHeadSha;
}

/**
 * Who may author a usable review is the caller's configuration. With no configured
 * authors, no review's author is verified; otherwise only a listed login is trusted.
 * `author` must be the forge's authenticated comment author, never text from the review.
 */
export type ReviewProvenance = "trusted_author" | "untrusted_author" | "author_not_verified";

export function reviewProvenance(
  author: string | null,
  trustedAuthors: readonly string[],
): ReviewProvenance {
  if (trustedAuthors.length === 0) return "author_not_verified";
  return author !== null && trustedAuthors.includes(author) ? "trusted_author" : "untrusted_author";
}
