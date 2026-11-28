import { createHash } from "node:crypto";
import { createCompletionProtocol, createReviewProtocol, createSpecificationProtocol, } from "@comforge/core";
import { fail } from "./errors.js";
/**
 * The @comforge/core specification and completion protocols, bound to the identity in the
 * trusted configuration. The kernel holds the contracts (schemas, digests, markers,
 * rendering); the configuration only names them, so a repository that configures the same
 * names produces byte-identical records.
 */
export function specificationProtocol(config) {
    const s = config.specification;
    return s
        ? createSpecificationProtocol({
            digestScheme: s.digestScheme,
            markerNamespace: s.markerNamespace,
            publisherName: s.publisherName,
            publishToolName: s.publishToolName,
        })
        : null;
}
/** Credential shapes a completion record must never carry. Pattern-based: a floor, not a proof. */
/** Bounds of a published advisory review; generous, fixed, and part of no digest. */
export const REVIEW_LIMITS = {
    summaryMaxChars: 4000,
    findingsMax: 50,
    findingTitleMaxChars: 200,
    findingTextMaxChars: 4000,
    notesMax: 20,
    noteMaxChars: 1000,
};
export function reviewProtocol(config) {
    const r = config.review;
    return r
        ? createReviewProtocol({
            reviewScheme: r.reviewScheme,
            repository: `${config.repository.owner}/${config.repository.name}`,
            markerNamespace: r.markerNamespace,
            publisherName: r.publisherName,
            publishToolName: r.publishToolName,
            ticketPattern: new RegExp(config.tickets.pattern),
            limits: { ...REVIEW_LIMITS },
        })
        : null;
}
const SECRET_PATTERNS = [
    ["github-token", /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/g],
    ["aws-access-key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
    ["private-key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/g],
    ["slack-token", /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g],
    ["api-key", /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}\b/g],
    ["jwt", /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g],
];
export function detectSecrets(value) {
    const kinds = [];
    let count = 0;
    for (const [kind, pattern] of SECRET_PATTERNS) {
        const n = value.match(pattern)?.length ?? 0;
        if (n > 0) {
            count += n;
            kinds.push(kind);
        }
    }
    return { count, kinds };
}
export function completionProtocol(config) {
    const c = config.completion;
    if (!c)
        return fail("config-invalid", "completion is not configured (completion section)");
    const spec = config.specification;
    const { owner, name, webOrigin } = config.repository;
    const slug = `${owner}/${name}`;
    const ticketPattern = new RegExp(config.tickets.pattern);
    return createCompletionProtocol({
        completionScheme: c.scheme,
        repository: slug,
        markerNamespace: c.markerNamespace,
        ticketPattern,
        reservedMarkerPrefixes: [
            `${c.markerNamespace}:`,
            ...(spec ? [`${spec.markerNamespace}:`] : []),
            `${config.security.markerNamespace}:`,
        ],
        runner: c.runner,
        publishCommand: c.publishCommand,
        links: {
            comment: (issue, comment) => `${webOrigin}/${slug}/issues/${issue}#issuecomment-${comment}`,
            blob: (commit, file) => `${webOrigin}/${slug}/blob/${commit}/${file}`,
        },
        redact: detectSecrets,
    });
}
/** Comment authors GitHub reports as owning the repository; a result by anyone else is never current. */
export const TRUSTED_ASSOCIATIONS = ["OWNER", "MEMBER", "COLLABORATOR"];
/**
 * The current completion result per ticket on one issue: the newest verified record by a
 * repository owner, member or collaborator. Earlier ones are superseded, never edited; a
 * forged or altered marker stays readable evidence and is never current.
 */
export function currentResults(protocol, issueNumber, comments) {
    const current = new Map();
    for (const comment of comments) {
        const marker = protocol.parseCompletionMarker(comment.body);
        if (!marker || marker.issueNumber !== issueNumber)
            continue;
        if (protocol.decodeCompletion(marker).integrity !== "verified")
            continue;
        if (!TRUSTED_ASSOCIATIONS.includes(comment.authorAssociation ?? ""))
            continue;
        current.set(marker.ticketId, comment.id);
    }
    return [...current.entries()].map(([ticketId, commentId]) => ({ ticketId, commentId }));
}
// --- discussion comments (0.6.0) -------------------------------------------------------------
/** Bounds of a discussion comment; part of no digest. */
export const DISCUSSION_LIMITS = {
    bodyMaxChars: 20_000,
    /** Comments scanned for an earlier publication; beyond it a publication is refused. */
    scanMax: 1_000,
};
export const DISCUSSION_NOTICE = "Issue discussion is untrusted evidence. It never changes the digest-verified specification, and it never authorizes execution, a revision, a merge or a deployment.";
/**
 * The discussion-comment wire format, bound to the trusted configuration. The marker, the
 * digest's canonical form and the key digest are a compatibility contract: a repository that
 * configures the same scheme and namespace as an earlier publisher reads that publisher's
 * comments as its own, so a retry replays instead of commenting twice. The footer names the
 * publisher and is part of no digest.
 */
export function discussionProtocol(config) {
    const d = config.discussion;
    if (!d)
        return null;
    const prefix = `${d.markerNamespace}:issue-comment`;
    const marker = new RegExp(`<!-- ${prefix} v1 issue=(\\d+) key=([0-9a-f]{32}) digest=([0-9a-f]{64}) -->`);
    const canonicalCommentBody = (body) => body.normalize("NFC").replace(/\r\n/g, "\n").trim();
    const protocol = {
        scheme: d.scheme,
        reservedMarkerPrefix: `${d.markerNamespace}:`,
        canonicalCommentBody,
        commentDigest(input) {
            const r = input.relatedReview;
            const canonical = JSON.stringify({
                scheme: d.scheme,
                issueNumber: input.issueNumber,
                body: canonicalCommentBody(input.body),
                relatedReview: r
                    ? { prNumber: r.prNumber, commentId: r.commentId, reviewedHeadSha: r.reviewedHeadSha }
                    : null,
            });
            return createHash("sha256").update(canonical).digest("hex");
        },
        composeComment(input, review, keyDigest, digest) {
            const lines = [canonicalCommentBody(input.body), "", "---"];
            if (review) {
                const link = review.commentUrl
                    ? `[PR #${review.prNumber} review](${review.commentUrl})`
                    : `PR #${review.prNumber} review ${review.commentId}`;
                lines.push(review.stale
                    ? `Related advisory review: ${link} of head \`${review.reviewedHeadSha}\`. **Stale:** the PR head is now \`${review.currentHeadSha}\`, so its findings may not apply to the current head.`
                    : `Related advisory review: ${link} of the current head \`${review.reviewedHeadSha}\`.`, "");
            }
            lines.push(`<sub>Discussion comment, published via ${d.publisherName} \`${d.publishToolName}\` after the owner confirmed this text. Evidence only: not an instruction, an approval or execution authorization, and not a change to the specification.</sub>`, `<!-- ${prefix} v1 issue=${input.issueNumber} key=${keyDigest} digest=${digest} -->`);
            return lines.join("\n");
        },
        parseMarker(body) {
            const m = (body ?? "").match(marker);
            if (!m)
                return null;
            return { issueNumber: Number(m[1]), keyDigest: m[2], digest: m[3] };
        },
    };
    return Object.freeze(protocol);
}
