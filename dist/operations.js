import { GitHubAdapterError } from "./errors.js";
/**
 * Write operations as canonical, frozen descriptors. A descriptor is the one object a consumer
 * authorizes: the request the writer sends is derived from it and nothing else, so an
 * authorization of one descriptor can never be spent on other bytes, another target or another
 * capability. This module only validates and canonicalizes; it sends nothing.
 */
/**
 * Capabilities a writer may be constructed with. Each names exactly one kind of write; nothing
 * is implied by a broader one, and none is inferred from what a token happens to permit.
 */
export const WRITE_CAPABILITIES = [
    "issues:create",
    "issues:comment",
    "issues:update",
    "issues:comment:update",
    "pulls:create",
    "pulls:update",
    "pulls:review",
    "pulls:review:approve",
    "pulls:review:request-changes",
];
/** The capability an operation needs. A review's event chooses among three. */
export function capabilityOf(op) {
    switch (op.kind) {
        case "issue.create":
            return "issues:create";
        case "issue.comment":
            return "issues:comment";
        case "issue.update":
            return "issues:update";
        case "comment.update":
            return "issues:comment:update";
        case "pull.create":
            return "pulls:create";
        case "pull.update":
            return "pulls:update";
        case "pull.review":
            return op.event === "APPROVE"
                ? "pulls:review:approve"
                : op.event === "REQUEST_CHANGES"
                    ? "pulls:review:request-changes"
                    : "pulls:review";
    }
}
/** GitHub's documented body limit for issues, comments, reviews and pull requests. */
export const MAX_BODY_CHARS = 65_536;
export const MAX_TITLE_CHARS = 256;
const MAX_LABELS = 20;
const MAX_ASSIGNEES = 10;
const SHA = /^[0-9a-f]{40}$/;
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\[bot\])?$/;
const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
/** Control characters other than tab and line feed: binary or terminal-escape content. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: the point is to find them
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/;
/** Reserved for the writer's own correlation marker; refused in caller text. */
export const MARKER_PREFIX = "<!-- comforge-op ";
function invalid(message) {
    return new GitHubAdapterError("invalid-input", message);
}
function text(value, what, max, options = {}) {
    if (typeof value !== "string")
        throw invalid(`${what} must be a string`);
    // The bytes authorized are the bytes sent: line endings are canonicalized before the digest.
    const canonical = value.replace(/\r\n?/g, "\n");
    if (CONTROL.test(canonical))
        throw invalid(`${what} contains control characters`);
    if (!options.allowEmpty && canonical.trim().length === 0)
        throw invalid(`${what} must not be empty`);
    if (canonical.length > max)
        throw invalid(`${what} exceeds ${max} characters`);
    if (canonical.includes(MARKER_PREFIX))
        throw invalid(`${what} contains the reserved marker prefix`);
    return canonical;
}
function positive(value, what) {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
        throw invalid(`Invalid ${what}`);
    return value;
}
function sha(value, what) {
    if (typeof value !== "string" || !SHA.test(value))
        throw invalid(`${what} must be a full 40-character lowercase SHA`);
    return value;
}
function timestamp(value, what) {
    if (typeof value !== "string" || !TIMESTAMP.test(value))
        throw invalid(`${what} must be an ISO-8601 UTC timestamp`);
    return value;
}
function optionalDigest(value, what) {
    if (value === undefined)
        return undefined;
    if (typeof value !== "string" || !DIGEST.test(value))
        throw invalid(`${what} must be sha256:<64 hex>`);
    return value;
}
function list(value, what, max, item) {
    if (value === undefined)
        return undefined;
    if (!Array.isArray(value) || value.length > max)
        throw invalid(`${what} must be a list of at most ${max}`);
    const items = value.map(item);
    if (new Set(items).size !== items.length)
        throw invalid(`${what} has duplicates`);
    return items;
}
const label = (v) => {
    const name = text(v, "A label", 50);
    if (name.includes("\n") || name.includes(","))
        throw invalid("A label must be one line without commas");
    return name;
};
const login = (v) => {
    if (typeof v !== "string" || !LOGIN.test(v))
        throw invalid("Invalid GitHub login");
    return v;
};
/** A branch name git and GitHub both accept, kept to a conservative subset. */
export function branch(value, what) {
    if (typeof value !== "string" ||
        !/^[A-Za-z0-9._/-]{1,200}$/.test(value) ||
        /^[-./]|\/$|\/\/|\.\.|\.lock(\/|$)|\/\.|^\.|@\{/.test(value))
        throw invalid(`${what} is not a supported branch name`);
    return value;
}
function bool(value, what) {
    if (value === undefined)
        return undefined;
    if (typeof value !== "boolean")
        throw invalid(`${what} must be a boolean`);
    return value;
}
function oneOf(value, allowed, what) {
    if (value === undefined)
        return undefined;
    if (typeof value !== "string" || !allowed.includes(value))
        throw invalid(`Invalid ${what}`);
    return value;
}
/** Object with `undefined` fields removed: absent and undefined must digest identically. */
function defined(record) {
    return Object.fromEntries(Object.entries(record).filter(([, v]) => v !== undefined));
}
/** JSON with object keys sorted at every depth: the digest input. */
export function canonicalJson(value) {
    if (value === null || typeof value !== "object")
        return JSON.stringify(value);
    if (Array.isArray(value))
        return `[${value.map(canonicalJson).join(",")}]`;
    const entries = Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}
/** `sha256:<hex>` of a string's UTF-8 bytes, through Web Crypto (Node ≥ 22 and Bun). */
export async function sha256(input) {
    const bytes = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
    return `sha256:${[...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}
/** The digest a caller passes as `expected.bodyDigest`: of the body exactly as GitHub returned it. */
export const bodyDigest = (body) => sha256(body ?? "");
function deepFreeze(value) {
    if (value && typeof value === "object") {
        for (const inner of Object.values(value))
            deepFreeze(inner);
        Object.freeze(value);
    }
    return value;
}
/**
 * Validates an operation and returns its descriptor. Only the named fields are read, each is
 * copied, and the result is frozen: mutating the caller's object afterwards changes nothing.
 */
export async function describe(repository, input) {
    if (!input || typeof input !== "object")
        throw invalid("An operation is required");
    const operationId = input.operationId;
    if (typeof operationId !== "string" || !OPERATION_ID.test(operationId))
        throw invalid("operationId must be 8–128 characters of [A-Za-z0-9._:-]");
    let target;
    let payload;
    let precondition = {};
    let capability;
    const kind = input.kind;
    switch (kind) {
        case "issue.create": {
            target = { type: "repository" };
            payload = defined({
                title: text(input.title, "title", MAX_TITLE_CHARS),
                body: text(input.body, "body", MAX_BODY_CHARS),
                labels: list(input.labels, "labels", MAX_LABELS, label),
                assignees: list(input.assignees, "assignees", MAX_ASSIGNEES, login),
            });
            capability = capabilityOf({ kind });
            break;
        }
        case "issue.comment": {
            const number = positive(input.issueNumber, "issue number");
            target = { type: "issue", number };
            payload = { body: text(input.body, "body", MAX_BODY_CHARS) };
            precondition = {
                thread: oneOf(input.thread, ["issue", "pull-request"], "thread") ?? "issue",
                allowClosed: bool(input.allowClosed, "allowClosed") ?? false,
                allowLocked: bool(input.allowLocked, "allowLocked") ?? false,
            };
            capability = capabilityOf({ kind });
            break;
        }
        case "pull.review": {
            const number = positive(input.pullNumber, "pull request number");
            const event = oneOf(input.event, ["COMMENT", "APPROVE", "REQUEST_CHANGES"], "review event");
            if (!event)
                throw invalid("A review event is required; a pending review is not supported");
            const head = sha(input.expectedHeadSha, "expectedHeadSha");
            target = { type: "pull", number };
            payload = {
                commit_id: head,
                event,
                // GitHub requires a body for COMMENT and REQUEST_CHANGES; APPROVE may be empty.
                body: text(input.body, "body", MAX_BODY_CHARS, { allowEmpty: event === "APPROVE" }),
            };
            precondition = { headSha: head, open: true };
            capability = capabilityOf({ kind, event });
            break;
        }
        case "pull.create": {
            const head = branch(input.head, "head");
            const base = branch(input.base, "base");
            if (head === base)
                throw invalid("head and base must differ");
            target = { type: "branch", head, base };
            payload = defined({
                title: text(input.title, "title", MAX_TITLE_CHARS),
                body: text(input.body, "body", MAX_BODY_CHARS),
                head,
                base,
                draft: bool(input.draft, "draft"),
                // Never let a head-branch owner's maintainers push into the PR implicitly.
                maintainer_can_modify: false,
            });
            precondition = defined({
                headSha: sha(input.expectedHeadSha, "expectedHeadSha"),
                baseSha: input.expectedBaseSha === undefined
                    ? undefined
                    : sha(input.expectedBaseSha, "expectedBaseSha"),
            });
            capability = capabilityOf({ kind });
            break;
        }
        case "issue.update": {
            const number = positive(input.issueNumber, "issue number");
            const changes = input.changes ?? {};
            const expected = input.expected ?? {};
            target = { type: "issue", number };
            payload = defined({
                title: changes.title === undefined ? undefined : text(changes.title, "title", MAX_TITLE_CHARS),
                body: changes.body === undefined
                    ? undefined
                    : text(changes.body, "body", MAX_BODY_CHARS, { allowEmpty: true }),
                state: oneOf(changes.state, ["open", "closed"], "state"),
                state_reason: oneOf(changes.stateReason, ["completed", "not_planned", "reopened"], "stateReason"),
                labels: list(changes.labels, "labels", MAX_LABELS, label),
            });
            if (Object.keys(payload).length === 0)
                throw invalid("An update needs at least one change");
            if (payload.state_reason !== undefined && payload.state === undefined)
                throw invalid("stateReason needs state");
            precondition = defined({
                updatedAt: timestamp(expected.updatedAt, "expected.updatedAt"),
                bodyDigest: optionalDigest(expected.bodyDigest, "expected.bodyDigest"),
                state: oneOf(expected.state, ["open", "closed"], "expected.state"),
            });
            capability = capabilityOf({ kind });
            break;
        }
        case "pull.update": {
            const number = positive(input.pullNumber, "pull request number");
            const expected = input.expected ?? {};
            const digest = optionalDigest(expected.bodyDigest, "expected.bodyDigest");
            if (digest === undefined)
                throw invalid("expected.bodyDigest is required");
            target = { type: "pull", number };
            payload = { body: text(input.body, "body", MAX_BODY_CHARS, { allowEmpty: true }) };
            precondition = defined({
                bodyDigest: digest,
                headSha: expected.headSha === undefined ? undefined : sha(expected.headSha, "expected.headSha"),
                updatedAt: expected.updatedAt === undefined
                    ? undefined
                    : timestamp(expected.updatedAt, "expected.updatedAt"),
            });
            capability = capabilityOf({ kind });
            break;
        }
        case "comment.update": {
            const id = positive(input.commentId, "comment id");
            const expected = input.expected ?? {};
            target = { type: "comment", id };
            payload = { body: text(input.body, "body", MAX_BODY_CHARS) };
            precondition = defined({
                issueNumber: positive(expected.issueNumber, "expected.issueNumber"),
                updatedAt: timestamp(expected.updatedAt, "expected.updatedAt"),
                bodyDigest: optionalDigest(expected.bodyDigest, "expected.bodyDigest"),
                author: expected.author === undefined ? undefined : login(expected.author),
            });
            capability = capabilityOf({ kind });
            break;
        }
        default:
            throw invalid("Unknown write operation kind");
    }
    const unsigned = {
        schema: "comforge-github-write/v1",
        operationId,
        kind,
        capability,
        repository,
        target,
        payload,
        precondition,
    };
    return deepFreeze({ ...unsigned, digest: await sha256(canonicalJson(unsigned)) });
}
/**
 * The correlation marker appended to a created body: digests only, never the raw operation id.
 * Anyone who can write to the repository can copy it, so a match is evidence that needs the
 * author check (`expectedAuthor`), not proof.
 */
export async function correlationMarker(namespace, descriptor) {
    const op = (await sha256(`${descriptor.repository}\n${descriptor.operationId}`)).slice(7, 39);
    return `${MARKER_PREFIX}v1 ns=${namespace} op=${op} fp=${descriptor.digest.slice(7, 39)} -->`;
}
/** True when `body` carries exactly this operation's marker (same operation, same fingerprint). */
export function carriesMarker(body, marker) {
    return typeof body === "string" && body.endsWith(marker);
}
/** The body sent for a create: the authorized body, a blank line, and the marker. */
export function markedBody(body, marker) {
    if (marker === null)
        return body;
    const joined = body.length === 0 ? marker : `${body}\n\n${marker}`;
    if (joined.length > MAX_BODY_CHARS)
        throw invalid(`body exceeds ${MAX_BODY_CHARS} characters with the correlation marker`);
    return joined;
}
export const isSha = (value) => typeof value === "string" && SHA.test(value);
