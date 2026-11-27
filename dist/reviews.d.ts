import { type ReviewIntegrity, type ReviewPayload, type ReviewProtocol, type ReviewProvenance } from "@comforge/core";
import type { GitHubEvidence } from "./evidence.ts";
/**
 * Advisory reviews of a pull request, read back from its conversation comments through
 * `@comforge/core`'s review protocol. An advisory review is ONE ordinary PR comment carrying
 * the protocol's hidden marker; it is never a native GitHub review (`listReviews`), carries
 * no approval state, and authorizes nothing.
 *
 * The marker is unkeyed: anyone who can comment can forge one. `integrity: "verified"` proves
 * only that the payload is unaltered under the protocol's scheme and agrees with the marker,
 * the protocol's repository and this pull request. Whether the author is trusted
 * (`provenance`) and whether the head moved (`stale`) are separate observations; a caller
 * that acts on a review needs `verified`, `trusted_author` and `stale === false`.
 * The structured `review` is present only when integrity is `verified`; otherwise the
 * marker-claimed fields are exposed for diagnosis only and are not evidence.
 */
export interface AdvisoryReview {
    kind: "advisory";
    commentId: number;
    author: string | null;
    authorAssociation: string;
    createdAt: string;
    provenance: ReviewProvenance;
    integrity: ReviewIntegrity;
    /** The head the marker names (null when no marker could be read). Unverified unless `integrity` is `verified`. */
    reviewedHeadSha: string | null;
    /** `isReviewStale` against the supplied current head; true when no head could be read. */
    stale: boolean;
    /** From the verified payload only; null otherwise. */
    verdict: ReviewPayload["verdict"] | null;
    /** The marker's digest (null when unreadable). */
    reviewDigest: string | null;
    ticketId: string | null;
    /** Present only when `integrity` is `verified`. */
    findingsBySeverity?: Record<string, number>;
    /** The decoded payload; present only when `integrity` is `verified`. */
    review?: ReviewPayload;
}
export interface AdvisoryReviewOptions {
    /** Logins whose comments are trusted review authors; with none, no author is verified. */
    trustedAuthors: readonly string[];
}
export declare function listAdvisoryReviews(evidence: GitHubEvidence, protocol: ReviewProtocol, pullRequest: {
    number: number;
    headSha: string;
}, options: AdvisoryReviewOptions): Promise<AdvisoryReview[]>;
/** The newest advisory review (verified or not) by `createdAt`, then comment id; null when none. */
export declare function latestAdvisoryReview(evidence: GitHubEvidence, protocol: ReviewProtocol, pullRequest: {
    number: number;
    headSha: string;
}, options: AdvisoryReviewOptions): Promise<AdvisoryReview | null>;
