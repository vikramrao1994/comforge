import { createCompletionProtocol, createSpecificationProtocol, } from "@comforge/core";
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
