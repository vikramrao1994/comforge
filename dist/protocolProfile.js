/**
 * `@comforge/cli/protocols`: the specification, advisory-review and completion protocols as
 * typed services bound to an explicit, versioned compatibility profile.
 *
 * The configuration-bound factories of the package root (`specificationProtocol(config)` and
 * friends) stay the default for a repository that adopts Comforge today. A profile is for a host
 * whose published records predate its configuration: it names every value that reaches a marker
 * or a digest, so those records keep verifying byte for byte.
 *
 * Serialization and policy are separate. A profile chooses only identity (schemes, marker
 * namespaces, publisher names, limits, links). What may be published is not a profile choice:
 * the record's own marker prefix is always reserved, and the built-in credential detector always
 * runs. A host can add a detector, never remove the floor.
 */
import { ADVISORY_REVIEW_NOTICE, COMPLETION_LIMITS, COMPLETION_NOTICE, CONFIDENCES, canonicalBody, canonicalTitle, createCompletionProtocol, createReviewProtocol, createSpecificationProtocol, DISPOSITIONS, deriveDisposition, FINDING_ID_PATTERN, FINDING_SEVERITIES, GATE_STATUSES, ISSUE_TYPE_MATRIX, ISSUE_TYPES, idempotencyKeyDigest, isReviewStale, OUTCOMES, REVIEW_VERDICTS, reviewProvenance, SECTION_KEYS, } from "@comforge/core";
import { detectSecrets, REVIEW_LIMITS } from "./protocols.js";
export const PROTOCOL_PROFILE_SCHEMA = "comforge-protocol-profile/v1";
const NAMESPACE = /^[a-z][a-z0-9-]{0,62}$/;
function refuse(message) {
    throw new TypeError(`@comforge/cli/protocols: ${message}`);
}
/** The protocols of one profile. Throws on a profile this version does not define. */
export function createProtocolServices(profile) {
    if (profile?.schema !== PROTOCOL_PROFILE_SCHEMA)
        refuse(`unsupported profile ${JSON.stringify(profile?.schema)}; this version defines ${PROTOCOL_PROFILE_SCHEMA}`);
    if (!/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(profile.repository))
        refuse("repository must be owner/name");
    if (!(profile.ticketPattern instanceof RegExp))
        refuse("ticketPattern must be a RegExp");
    for (const section of [profile.specification, profile.review, profile.completion])
        if (section && !NAMESPACE.test(section.markerNamespace))
            refuse(`invalid marker namespace ${JSON.stringify(section.markerNamespace)}`);
    const specification = profile.specification
        ? createSpecificationProtocol({ ...profile.specification })
        : null;
    const review = profile.review
        ? createReviewProtocol({
            reviewScheme: profile.review.reviewScheme,
            repository: profile.repository,
            markerNamespace: profile.review.markerNamespace,
            publisherName: profile.review.publisherName,
            publishToolName: profile.review.publishToolName,
            ticketPattern: profile.ticketPattern,
            limits: { ...profile.review.limits },
        })
        : null;
    let completion = null;
    if (profile.completion) {
        const c = profile.completion;
        const extra = c.detectSecrets;
        if (extra !== undefined && typeof extra !== "function")
            refuse("completion.detectSecrets must be a function");
        for (const prefix of c.alsoReserved ?? [])
            if (typeof prefix !== "string" || !/^[a-z][a-z0-9-]{0,62}:$/.test(prefix))
                refuse(`invalid reserved marker prefix ${JSON.stringify(prefix)}`);
        // Fixed first, in this order: a profile adds to the reserved set and cannot shrink it.
        const reserved = [
            ...(specification ? [specification.reservedMarkerPrefix] : []),
            `${c.markerNamespace}:`,
            ...(c.alsoReserved ?? []),
        ];
        completion = createCompletionProtocol({
            completionScheme: c.scheme,
            repository: profile.repository,
            markerNamespace: c.markerNamespace,
            ticketPattern: profile.ticketPattern,
            reservedMarkerPrefixes: [...new Set(reserved)],
            runner: { ...c.runner },
            publishCommand: c.publishCommand,
            links: { comment: c.links.comment, blob: c.links.blob },
            redact(text) {
                const floor = detectSecrets(text);
                if (!extra)
                    return floor;
                const host = extra(text);
                return host.count > 0 ? host : floor;
            },
        });
    }
    return Object.freeze({
        schema: PROTOCOL_PROFILE_SCHEMA,
        repository: profile.repository,
        specification,
        review,
        completion,
    });
}
/**
 * The profile a trusted configuration describes: what the configuration-bound factories of the
 * package root use. Its completion links follow the configured web origin, and the security
 * marker namespace is reserved too.
 */
export function profileFromConfig(config) {
    const { owner, name, webOrigin } = config.repository;
    const slug = `${owner}/${name}`;
    return {
        schema: PROTOCOL_PROFILE_SCHEMA,
        repository: slug,
        ticketPattern: new RegExp(config.tickets.pattern),
        ...(config.specification ? { specification: { ...config.specification } } : {}),
        ...(config.review ? { review: { ...config.review, limits: { ...REVIEW_LIMITS } } } : {}),
        ...(config.completion
            ? {
                completion: {
                    scheme: config.completion.scheme,
                    markerNamespace: config.completion.markerNamespace,
                    alsoReserved: [`${config.security.markerNamespace}:`],
                    runner: { ...config.completion.runner },
                    publishCommand: config.completion.publishCommand,
                    links: {
                        comment: (issue, comment) => `${webOrigin}/${slug}/issues/${issue}#issuecomment-${comment}`,
                        blob: (commit, file) => `${webOrigin}/${slug}/blob/${commit}/${file}`,
                    },
                },
            }
            : {}),
    };
}
/** Text canonicalization shared by every specification profile (scheme-independent). */
export const canonicalText = Object.freeze({
    body: canonicalBody,
    title: canonicalTitle,
    idempotencyKeyDigest,
});
/** Whether a review's author and reviewed head can be relied on; from the forge's own data. */
export const reviewTrust = Object.freeze({
    isStale: isReviewStale,
    provenance: reviewProvenance,
});
/** The fixed vocabulary of an advisory review, the same under every profile. */
export const REVIEW_VOCABULARY = Object.freeze({
    notice: ADVISORY_REVIEW_NOTICE,
    findingIdPattern: FINDING_ID_PATTERN,
    severities: FINDING_SEVERITIES,
    verdicts: REVIEW_VERDICTS,
});
/** The fixed vocabulary of a completion result, the same under every profile. */
export const COMPLETION_VOCABULARY = Object.freeze({
    limits: COMPLETION_LIMITS,
    notice: COMPLETION_NOTICE,
    confidences: CONFIDENCES,
    dispositions: DISPOSITIONS,
    gateStatuses: GATE_STATUSES,
    issueTypes: ISSUE_TYPES,
    issueTypeMatrix: ISSUE_TYPE_MATRIX,
    outcomes: OUTCOMES,
    sectionKeys: SECTION_KEYS,
    deriveDisposition,
});
