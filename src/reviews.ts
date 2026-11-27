import {
  isReviewStale,
  type ReviewIntegrity,
  type ReviewPayload,
  type ReviewProtocol,
  type ReviewProvenance,
  reviewProvenance,
} from "@comforge/core";
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
  /** The comment's last edit, as GitHub reported it (0.6.0). */
  updatedAt: string;
  /** The comment's web URL, when GitHub sent it (0.6.0). */
  commentUrl: string | null;
  /** The pull request the marker names; null when no marker could be read (0.6.0). */
  markerPrNumber: number | null;
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

export async function listAdvisoryReviews(
  evidence: GitHubEvidence,
  protocol: ReviewProtocol,
  pullRequest: { number: number; headSha: string },
  options: AdvisoryReviewOptions,
): Promise<AdvisoryReview[]> {
  const comments = await evidence.listIssueComments(pullRequest.number);
  const reviews: AdvisoryReview[] = [];
  for (const c of comments) {
    if (!c.body.text.includes(`${protocol.reservedMarkerPrefix}engineering-review`)) continue;
    const common = {
      kind: "advisory" as const,
      commentId: c.id,
      author: c.author,
      authorAssociation: c.authorAssociation,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      commentUrl: c.url,
      provenance: reviewProvenance(c.author, options.trustedAuthors),
    };
    // A truncated body may have lost the end of its marker: it cannot be verified.
    const marker = c.body.truncated ? null : protocol.parseReviewMarker(c.body.text);
    if (!marker) {
      reviews.push({
        ...common,
        integrity: "unreadable",
        markerPrNumber: null,
        reviewedHeadSha: null,
        stale: true,
        verdict: null,
        reviewDigest: null,
        ticketId: null,
      });
      continue;
    }
    const decoded = protocol.decodeReview(marker);
    // A marker copied from another pull request's review is not a review of this one.
    const integrity: ReviewIntegrity =
      decoded.integrity === "verified" && marker.prNumber !== pullRequest.number
        ? "mismatch"
        : decoded.integrity;
    const base = {
      ...common,
      integrity,
      markerPrNumber: marker.prNumber,
      reviewedHeadSha: marker.headSha,
      stale: isReviewStale(marker.headSha, pullRequest.headSha),
      reviewDigest: marker.digest,
      ticketId: marker.ticketId,
    };
    if (integrity === "verified" && decoded.payload) {
      const findingsBySeverity: Record<string, number> = {};
      for (const f of decoded.payload.findings)
        findingsBySeverity[f.severity] = (findingsBySeverity[f.severity] ?? 0) + 1;
      reviews.push({
        ...base,
        verdict: decoded.payload.verdict,
        findingsBySeverity,
        review: decoded.payload,
      });
    } else reviews.push({ ...base, verdict: null });
  }
  return reviews;
}

/** The newest advisory review (verified or not) by `createdAt`, then comment id; null when none. */
export async function latestAdvisoryReview(
  evidence: GitHubEvidence,
  protocol: ReviewProtocol,
  pullRequest: { number: number; headSha: string },
  options: AdvisoryReviewOptions,
): Promise<AdvisoryReview | null> {
  const all = await listAdvisoryReviews(evidence, protocol, pullRequest, options);
  return (
    all.reduce<AdvisoryReview | null>(
      (best, r) =>
        best === null ||
        r.createdAt > best.createdAt ||
        (r.createdAt === best.createdAt && r.commentId > best.commentId)
          ? r
          : best,
      null,
    ) ?? null
  );
}
