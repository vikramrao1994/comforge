import { z } from "zod";
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
export declare const ADVISORY_REVIEW_NOTICE: string;
export declare const REVIEW_VERDICTS: readonly ["no_blocking_findings", "revision_recommended", "insufficient_evidence"];
export declare const FINDING_SEVERITIES: readonly ["critical", "high", "medium", "low", "info"];
export declare const FINDING_ID_PATTERN: RegExp;
export interface ReviewLimits {
    summaryMaxChars: number;
    findingsMax: number;
    findingTitleMaxChars: number;
    findingTextMaxChars: number;
    notesMax: number;
    noteMaxChars: number;
}
declare function buildInputSchema(ticketPattern: RegExp, limits: ReviewLimits): z.ZodObject<{
    prNumber: z.ZodNumber;
    expectedHeadSha: z.ZodString;
    ticketId: z.ZodString;
    specificationIssueNumber: z.ZodOptional<z.ZodNumber>;
    verdict: z.ZodEnum<{
        insufficient_evidence: "insufficient_evidence";
        no_blocking_findings: "no_blocking_findings";
        revision_recommended: "revision_recommended";
    }>;
    summary: z.ZodString;
    findings: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        severity: z.ZodEnum<{
            critical: "critical";
            high: "high";
            info: "info";
            low: "low";
            medium: "medium";
        }>;
        title: z.ZodString;
        evidence: z.ZodString;
        requiredCorrection: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>>;
    acceptedLimitations: z.ZodDefault<z.ZodArray<z.ZodString>>;
    outOfScope: z.ZodDefault<z.ZodArray<z.ZodString>>;
    idempotencyKey: z.ZodString;
}, z.core.$strict>;
declare function buildPayloadSchema(reviewScheme: string, ticketPattern: RegExp): z.ZodObject<{
    scheme: z.ZodLiteral<string>;
    repository: z.ZodString;
    prNumber: z.ZodNumber;
    reviewedHeadSha: z.ZodString;
    ticketId: z.ZodString;
    specification: z.ZodNullable<z.ZodObject<{
        issueNumber: z.ZodNumber;
        digest: z.ZodString;
        digestVerified: z.ZodBoolean;
    }, z.core.$strict>>;
    verdict: z.ZodEnum<{
        insufficient_evidence: "insufficient_evidence";
        no_blocking_findings: "no_blocking_findings";
        revision_recommended: "revision_recommended";
    }>;
    summary: z.ZodString;
    findings: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        severity: z.ZodEnum<{
            critical: "critical";
            high: "high";
            info: "info";
            low: "low";
            medium: "medium";
        }>;
        title: z.ZodString;
        evidence: z.ZodString;
        requiredCorrection: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>>;
    acceptedLimitations: z.ZodArray<z.ZodString>;
    outOfScope: z.ZodArray<z.ZodString>;
}, z.core.$strict>;
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
    buildReviewPayload(input: CreatePrReviewInput, specification: ReviewPayload["specification"]): ReviewPayload;
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
    decodeReview(marker: ReviewMarker): {
        integrity: ReviewIntegrity;
        payload: ReviewPayload | null;
    };
}
export declare function createReviewProtocol(config: ReviewProtocolConfig): ReviewProtocol;
/**
 * A review applies only to the exact head it names. `currentHeadSha` must come from
 * the caller's trusted read of the pull request, never from the review itself.
 */
export declare function isReviewStale(reviewedHeadSha: string, currentHeadSha: string): boolean;
/**
 * Who may author a usable review is the caller's configuration. With no configured
 * authors, no review's author is verified; otherwise only a listed login is trusted.
 * `author` must be the forge's authenticated comment author, never text from the review.
 */
export type ReviewProvenance = "trusted_author" | "untrusted_author" | "author_not_verified";
export declare function reviewProvenance(author: string | null, trustedAuthors: readonly string[]): ReviewProvenance;
export {};
