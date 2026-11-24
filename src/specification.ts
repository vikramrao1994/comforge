import { createHash } from "node:crypto";

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

const DIGEST_SCHEME = /^[a-z0-9][a-z0-9.-]{0,79}\/v[0-9]{1,4}$/;
const MARKER_NAMESPACE = /^[a-z][a-z0-9-]{0,39}$/;
const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;
// A printable single line that cannot open or close an HTML comment or inline code.
const PUBLISHER_NAME = /^[A-Za-z0-9][A-Za-z0-9 .()-]{0,79}$/;

export function canonicalTitle(title: string): string {
  return title.normalize("NFC").trim();
}

export function canonicalBody(body: string): string {
  const lines = body
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""));
  while (lines.length > 0 && lines[0] === "") lines.shift();
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n");
}

/** Stored instead of the key itself, so a published issue never republishes a client value. */
export function idempotencyKeyDigest(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex").slice(0, 32);
}

function assertConfig(config: SpecificationProtocolConfig): void {
  const invalid = (field: keyof SpecificationProtocolConfig) =>
    new TypeError(`factory-core: invalid specification protocol ${field}`);
  if (!DIGEST_SCHEME.test(config.digestScheme)) throw invalid("digestScheme");
  if (!MARKER_NAMESPACE.test(config.markerNamespace)) throw invalid("markerNamespace");
  if (!PUBLISHER_NAME.test(config.publisherName)) throw invalid("publisherName");
  if (!TOOL_NAME.test(config.publishToolName)) throw invalid("publishToolName");
}

/**
 * Binds the pure specification functions to one publisher's wire format. The
 * configuration is validated and fixed at construction; invalid values throw
 * rather than produce a protocol that could emit unparseable markers.
 */
export function createSpecificationProtocol(
  config: SpecificationProtocolConfig,
): SpecificationProtocol {
  assertConfig(config);
  const { digestScheme, markerNamespace, publisherName, publishToolName } = config;
  const specBegin = `<!-- ${markerNamespace}:spec-begin -->`;
  const specEnd = `<!-- ${markerNamespace}:spec-end -->`;
  // The namespace alphabet has no regular-expression metacharacters except `-`,
  // which is literal outside a character class.
  const markerPattern = new RegExp(
    `<!-- ${markerNamespace}:engineering-spec v1 ticket=([A-Z0-9-]{1,80}) digest=([0-9a-f]{64}) key=([0-9a-f]{32}) -->`,
  );
  const executionNotAuthorized =
    "Publishing this specification does not authorize, approve, assign or schedule its execution. " +
    `Execution requires a separate owner authorization that the ${publisherName} cannot grant.`;

  const specificationDigest = (spec: SpecificationInput): string => {
    const canonical = JSON.stringify([
      spec.ticketId,
      canonicalTitle(spec.title),
      canonicalBody(spec.body),
    ]);
    return createHash("sha256").update(`${digestScheme}\n${canonical}`, "utf8").digest("hex");
  };

  const composeIssueBody: SpecificationProtocol["composeIssueBody"] = (spec) =>
    [
      "> [!IMPORTANT]",
      "> **Proposed engineering specification — execution NOT authorized.**",
      `> ${executionNotAuthorized}`,
      "",
      specBegin,
      canonicalBody(spec.body),
      specEnd,
      "",
      "---",
      `<sub>Ticket \`${spec.ticketId}\` · specification digest \`${digestScheme}:${spec.digest}\` · published via ${publisherName} \`${publishToolName}\`</sub>`,
      `<!-- ${markerNamespace}:engineering-spec v1 ticket=${spec.ticketId} digest=${spec.digest} key=${spec.keyDigest} -->`,
    ].join("\n");

  const parsePublishedMarker: SpecificationProtocol["parsePublishedMarker"] = (issueBody) => {
    const match = markerPattern.exec(issueBody ?? "");
    if (!match) return null;
    const [, ticketId, digest, keyDigest] = match;
    return ticketId && digest && keyDigest ? { ticketId, digest, keyDigest } : null;
  };

  const extractSpecificationBody: SpecificationProtocol["extractSpecificationBody"] = (
    issueBody,
  ) => {
    const body = issueBody ?? "";
    const begin = body.indexOf(specBegin);
    const end = body.lastIndexOf(specEnd);
    return begin >= 0 && end > begin ? body.slice(begin + specBegin.length, end) : null;
  };

  const verifyPublishedSpecification: SpecificationProtocol["verifyPublishedSpecification"] = (
    issue,
  ) => {
    const marker = parsePublishedMarker(issue.body);
    if (!marker) return null;
    const spec = extractSpecificationBody(issue.body);
    const digestMatches =
      spec !== null &&
      specificationDigest({ ticketId: marker.ticketId, title: issue.title, body: spec }) ===
        marker.digest;
    return { ticketId: marker.ticketId, digest: marker.digest, digestScheme, digestMatches };
  };

  return Object.freeze({
    digestScheme,
    reservedMarkerPrefix: `${markerNamespace}:`,
    executionNotAuthorized,
    specificationDigest,
    composeIssueBody,
    parsePublishedMarker,
    extractSpecificationBody,
    verifyPublishedSpecification,
  });
}
