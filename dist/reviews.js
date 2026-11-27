import { isReviewStale, reviewProvenance, } from "@comforge/core";
export async function listAdvisoryReviews(evidence, protocol, pullRequest, options) {
    const comments = await evidence.listIssueComments(pullRequest.number);
    const reviews = [];
    for (const c of comments) {
        if (!c.body.text.includes(`${protocol.reservedMarkerPrefix}engineering-review`))
            continue;
        const common = {
            kind: "advisory",
            commentId: c.id,
            author: c.author,
            authorAssociation: c.authorAssociation,
            createdAt: c.createdAt,
            provenance: reviewProvenance(c.author, options.trustedAuthors),
        };
        // A truncated body may have lost the end of its marker: it cannot be verified.
        const marker = c.body.truncated ? null : protocol.parseReviewMarker(c.body.text);
        if (!marker) {
            reviews.push({
                ...common,
                integrity: "unreadable",
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
        const integrity = decoded.integrity === "verified" && marker.prNumber !== pullRequest.number
            ? "mismatch"
            : decoded.integrity;
        const base = {
            ...common,
            integrity,
            reviewedHeadSha: marker.headSha,
            stale: isReviewStale(marker.headSha, pullRequest.headSha),
            reviewDigest: marker.digest,
            ticketId: marker.ticketId,
        };
        if (integrity === "verified" && decoded.payload) {
            const findingsBySeverity = {};
            for (const f of decoded.payload.findings)
                findingsBySeverity[f.severity] = (findingsBySeverity[f.severity] ?? 0) + 1;
            reviews.push({
                ...base,
                verdict: decoded.payload.verdict,
                findingsBySeverity,
                review: decoded.payload,
            });
        }
        else
            reviews.push({ ...base, verdict: null });
    }
    return reviews;
}
/** The newest advisory review (verified or not) by `createdAt`, then comment id; null when none. */
export async function latestAdvisoryReview(evidence, protocol, pullRequest, options) {
    const all = await listAdvisoryReviews(evidence, protocol, pullRequest, options);
    return (all.reduce((best, r) => best === null ||
        r.createdAt > best.createdAt ||
        (r.createdAt === best.createdAt && r.commentId > best.commentId)
        ? r
        : best, null) ?? null);
}
