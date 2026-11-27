/**
 * Published engineering specifications: canonicalization, digest, issue-body
 * composition, marker parsing and verification. Pure: no I/O, no environment,
 * no clock.
 *
 * A specification is published as Markdown between two delimiters, after a
 * non-executable banner and before a footer whose hidden marker records the
 * ticket, the digest and a digest of the publisher's idempotency key. Only the
 * delimited text and the title are digested, so the banner and footer may be
 * reworded without invalidating published issues.
 *
 * Digest canonicalization, for a configured `digestScheme`:
 *   1. title: Unicode NFC, surrounding whitespace trimmed;
 *   2. body: Unicode NFC, CRLF and lone CR → LF, trailing spaces/tabs removed
 *      from every line, leading and trailing blank lines removed;
 *   3. digest = SHA-256 (lowercase hex) of the UTF-8 bytes of
 *      `<digestScheme>\n` + JSON.stringify([ticketId, title, body]).
 * The rules absorb only the normalizations a forge or a browser may apply in
 * transit, so a published issue's digest can be recomputed from what is read
 * back. A digest identifies a specification; it authorizes nothing.
 *
 * Every byte this module emits or accepts is a compatibility contract with
 * issues already published under the same configuration. The marker grammar
 * (ticket, digest and key alphabets and lengths) is fixed here on purpose and is
 * not configurable: widening it would let text that is not a marker today become one.
 */
/**
 * Trusted, construction-time identity of one publisher's wire format. Supplied by
 * the consuming application from committed code, never from environment, request
 * or issue content: changing any value makes every issue published under the old
 * value fail verification.
 */
export interface SpecificationProtocolConfig {
    /** Digest domain separator, e.g. `example-engineering-spec/v1`. */
    digestScheme: string;
    /** Namespace of every hidden marker, e.g. `example-mcp` → `<!-- example-mcp:spec-begin -->`. */
    markerNamespace: string;
    /** Human-readable publisher named in the banner and footer, e.g. `Example MCP`. */
    publisherName: string;
    /** The publishing tool named in the footer, e.g. `engineering_create_issue`. */
    publishToolName: string;
}
export interface PublishedMarker {
    ticketId: string;
    digest: string;
    keyDigest: string;
}
export interface SpecificationVerification {
    ticketId: string;
    digest: string;
    digestScheme: string;
    /** False when the current title or delimited body no longer hash to the marker's digest. */
    digestMatches: boolean;
}
export interface SpecificationInput {
    ticketId: string;
    title: string;
    body: string;
}
export interface SpecificationProtocol {
    readonly digestScheme: string;
    /** Any client text containing this prefix could forge a marker and must be rejected. */
    readonly reservedMarkerPrefix: string;
    /** The banner sentence stating that publication authorizes nothing. */
    readonly executionNotAuthorized: string;
    specificationDigest(spec: SpecificationInput): string;
    composeIssueBody(spec: {
        ticketId: string;
        body: string;
        digest: string;
        keyDigest: string;
    }): string;
    parsePublishedMarker(issueBody: string | null | undefined): PublishedMarker | null;
    /** The text the digest covers: between the begin and the last end delimiter. */
    extractSpecificationBody(issueBody: string | null | undefined): string | null;
    /** The marker of a published specification and whether the issue still hashes to it. */
    verifyPublishedSpecification(issue: {
        title: string;
        body: string | null | undefined;
    }): SpecificationVerification | null;
}
export declare function canonicalTitle(title: string): string;
export declare function canonicalBody(body: string): string;
/** Stored instead of the key itself, so a published issue never republishes a client value. */
export declare function idempotencyKeyDigest(key: string): string;
/**
 * Binds the pure specification functions to one publisher's wire format. The
 * configuration is validated and fixed at construction; invalid values throw
 * rather than produce a protocol that could emit unparseable markers.
 */
export declare function createSpecificationProtocol(config: SpecificationProtocolConfig): SpecificationProtocol;
