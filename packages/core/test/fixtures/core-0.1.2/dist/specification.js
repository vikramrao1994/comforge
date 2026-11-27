import { createHash } from "node:crypto";
const DIGEST_SCHEME = /^[a-z0-9][a-z0-9.-]{0,79}\/v[0-9]{1,4}$/;
const MARKER_NAMESPACE = /^[a-z][a-z0-9-]{0,39}$/;
const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;
// A printable single line that cannot open or close an HTML comment or inline code.
const PUBLISHER_NAME = /^[A-Za-z0-9][A-Za-z0-9 .()-]{0,79}$/;
export function canonicalTitle(title) {
    return title.normalize("NFC").trim();
}
export function canonicalBody(body) {
    const lines = body
        .normalize("NFC")
        .replace(/\r\n?/g, "\n")
        .split("\n")
        .map((line) => line.replace(/[ \t]+$/, ""));
    while (lines.length > 0 && lines[0] === "")
        lines.shift();
    while (lines.length > 0 && lines[lines.length - 1] === "")
        lines.pop();
    return lines.join("\n");
}
/** Stored instead of the key itself, so a published issue never republishes a client value. */
export function idempotencyKeyDigest(key) {
    return createHash("sha256").update(key, "utf8").digest("hex").slice(0, 32);
}
function assertConfig(config) {
    const invalid = (field) => new TypeError(`factory-core: invalid specification protocol ${field}`);
    if (!DIGEST_SCHEME.test(config.digestScheme))
        throw invalid("digestScheme");
    if (!MARKER_NAMESPACE.test(config.markerNamespace))
        throw invalid("markerNamespace");
    if (!PUBLISHER_NAME.test(config.publisherName))
        throw invalid("publisherName");
    if (!TOOL_NAME.test(config.publishToolName))
        throw invalid("publishToolName");
}
/**
 * Binds the pure specification functions to one publisher's wire format. The
 * configuration is validated and fixed at construction; invalid values throw
 * rather than produce a protocol that could emit unparseable markers.
 */
export function createSpecificationProtocol(config) {
    assertConfig(config);
    const { digestScheme, markerNamespace, publisherName, publishToolName } = config;
    const specBegin = `<!-- ${markerNamespace}:spec-begin -->`;
    const specEnd = `<!-- ${markerNamespace}:spec-end -->`;
    // The namespace alphabet has no regular-expression metacharacters except `-`,
    // which is literal outside a character class.
    const markerPattern = new RegExp(`<!-- ${markerNamespace}:engineering-spec v1 ticket=([A-Z0-9-]{1,80}) digest=([0-9a-f]{64}) key=([0-9a-f]{32}) -->`);
    const executionNotAuthorized = "Publishing this specification does not authorize, approve, assign or schedule its execution. " +
        `Execution requires a separate owner authorization that the ${publisherName} cannot grant.`;
    const specificationDigest = (spec) => {
        const canonical = JSON.stringify([
            spec.ticketId,
            canonicalTitle(spec.title),
            canonicalBody(spec.body),
        ]);
        return createHash("sha256").update(`${digestScheme}\n${canonical}`, "utf8").digest("hex");
    };
    const composeIssueBody = (spec) => [
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
    const parsePublishedMarker = (issueBody) => {
        const match = markerPattern.exec(issueBody ?? "");
        if (!match)
            return null;
        const [, ticketId, digest, keyDigest] = match;
        return ticketId && digest && keyDigest ? { ticketId, digest, keyDigest } : null;
    };
    const extractSpecificationBody = (issueBody) => {
        const body = issueBody ?? "";
        const begin = body.indexOf(specBegin);
        const end = body.lastIndexOf(specEnd);
        return begin >= 0 && end > begin ? body.slice(begin + specBegin.length, end) : null;
    };
    const verifyPublishedSpecification = (issue) => {
        const marker = parsePublishedMarker(issue.body);
        if (!marker)
            return null;
        const spec = extractSpecificationBody(issue.body);
        const digestMatches = spec !== null &&
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
