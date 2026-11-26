import { GitHubAdapterError } from "./errors.ts";

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
] as const;
export type WriteCapability = (typeof WRITE_CAPABILITIES)[number];

export type ReviewEvent = "COMMENT" | "APPROVE" | "REQUEST_CHANGES";

export type WriteOperation =
  | {
      kind: "issue.create";
      operationId: string;
      title: string;
      body: string;
      labels?: readonly string[];
      assignees?: readonly string[];
    }
  | {
      kind: "issue.comment";
      operationId: string;
      issueNumber: number;
      body: string;
      /** The thread the number must be. Defaults to `issue`; a mismatch is `wrong-target`. */
      thread?: "issue" | "pull-request";
      /** Defaults to false: a closed thread is refused. */
      allowClosed?: boolean;
      /** Defaults to false: a locked thread is refused. */
      allowLocked?: boolean;
    }
  | {
      kind: "pull.review";
      operationId: string;
      pullNumber: number;
      /** The head the review is of; sent as `commit_id`, and the pull request must still be at it. */
      expectedHeadSha: string;
      event: ReviewEvent;
      body: string;
    }
  | {
      kind: "pull.create";
      operationId: string;
      title: string;
      body: string;
      /** A branch of this repository (cross-repository heads are not supported). */
      head: string;
      base: string;
      /** The commit `head` must point at, checked before and after the create. */
      expectedHeadSha: string;
      /** When given, the commit `base` must point at before the create. */
      expectedBaseSha?: string;
      draft?: boolean;
    }
  | {
      kind: "issue.update";
      operationId: string;
      issueNumber: number;
      /** The issue as the caller last read it; any difference before the write is `stale`. */
      expected: { updatedAt: string; bodyDigest?: string; state?: "open" | "closed" };
      changes: {
        title?: string;
        body?: string;
        state?: "open" | "closed";
        stateReason?: "completed" | "not_planned" | "reopened";
        labels?: readonly string[];
      };
    }
  | {
      kind: "pull.update";
      operationId: string;
      pullNumber: number;
      /**
       * The pull request as the caller last read it. `bodyDigest` is required: an edit replaces
       * the whole body, so a body changed by anyone since is `stale`. With `headSha`, a moved
       * head is `stale` too. A closed or merged pull request is refused.
       * The check is a read before the write, not a compare-and-swap (GitHub offers none): an
       * edit landing between that read and the PATCH is overwritten, and the outcome is still
       * `verified`, because it describes this write, not what it replaced.
       */
      expected: { bodyDigest: string; headSha?: string; updatedAt?: string };
      /** The new body. Title, state, base and draft are deliberately not editable here. */
      body: string;
    }
  | {
      kind: "comment.update";
      operationId: string;
      commentId: number;
      /** The comment as the caller last read it; any difference before the write is `stale`. */
      expected: { issueNumber: number; updatedAt: string; bodyDigest?: string; author?: string };
      body: string;
    };

export type WriteKind = WriteOperation["kind"];

/** The capability an operation needs. A review's event chooses among three. */
export function capabilityOf(
  op: Pick<WriteOperation, "kind"> & { event?: ReviewEvent },
): WriteCapability {
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

export type DescriptorTarget =
  | { type: "repository" }
  | { type: "issue"; number: number }
  | { type: "pull"; number: number }
  | { type: "comment"; id: number }
  | { type: "branch"; head: string; base: string };

/** What the consumer authorizes. Deeply frozen; `digest` covers every other field. */
export interface OperationDescriptor {
  readonly schema: "comforge-github-write/v1";
  readonly operationId: string;
  readonly kind: WriteKind;
  readonly capability: WriteCapability;
  readonly repository: string;
  readonly target: Readonly<DescriptorTarget>;
  /** The exact JSON body the writer sends, before its correlation marker is appended. */
  readonly payload: Readonly<Record<string, unknown>>;
  /** What must hold on GitHub immediately before the write. */
  readonly precondition: Readonly<Record<string, unknown>>;
  /** `sha256:` of the canonical JSON of every field above. */
  readonly digest: string;
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

function invalid(message: string): GitHubAdapterError {
  return new GitHubAdapterError("invalid-input", message);
}

function text(
  value: unknown,
  what: string,
  max: number,
  options: { allowEmpty?: boolean } = {},
): string {
  if (typeof value !== "string") throw invalid(`${what} must be a string`);
  // The bytes authorized are the bytes sent: line endings are canonicalized before the digest.
  const canonical = value.replace(/\r\n?/g, "\n");
  if (CONTROL.test(canonical)) throw invalid(`${what} contains control characters`);
  if (!options.allowEmpty && canonical.trim().length === 0)
    throw invalid(`${what} must not be empty`);
  if (canonical.length > max) throw invalid(`${what} exceeds ${max} characters`);
  if (canonical.includes(MARKER_PREFIX))
    throw invalid(`${what} contains the reserved marker prefix`);
  return canonical;
}

function positive(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    throw invalid(`Invalid ${what}`);
  return value;
}

function sha(value: unknown, what: string): string {
  if (typeof value !== "string" || !SHA.test(value))
    throw invalid(`${what} must be a full 40-character lowercase SHA`);
  return value;
}

function timestamp(value: unknown, what: string): string {
  if (typeof value !== "string" || !TIMESTAMP.test(value))
    throw invalid(`${what} must be an ISO-8601 UTC timestamp`);
  return value;
}

function optionalDigest(value: unknown, what: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !DIGEST.test(value))
    throw invalid(`${what} must be sha256:<64 hex>`);
  return value;
}

function list(
  value: unknown,
  what: string,
  max: number,
  item: (v: unknown) => string,
): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > max)
    throw invalid(`${what} must be a list of at most ${max}`);
  const items = value.map(item);
  if (new Set(items).size !== items.length) throw invalid(`${what} has duplicates`);
  return items;
}

const label = (v: unknown) => {
  const name = text(v, "A label", 50);
  if (name.includes("\n") || name.includes(","))
    throw invalid("A label must be one line without commas");
  return name;
};
const login = (v: unknown) => {
  if (typeof v !== "string" || !LOGIN.test(v)) throw invalid("Invalid GitHub login");
  return v;
};

/** A branch name git and GitHub both accept, kept to a conservative subset. */
export function branch(value: unknown, what: string): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9._/-]{1,200}$/.test(value) ||
    /^[-./]|\/$|\/\/|\.\.|\.lock(\/|$)|\/\.|^\.|@\{/.test(value)
  )
    throw invalid(`${what} is not a supported branch name`);
  return value;
}

function bool(value: unknown, what: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw invalid(`${what} must be a boolean`);
  return value;
}

function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  what: string,
): T | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value))
    throw invalid(`Invalid ${what}`);
  return value as T;
}

/** Object with `undefined` fields removed: absent and undefined must digest identically. */
function defined(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, v]) => v !== undefined));
}

/** JSON with object keys sorted at every depth: the digest input. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/** `sha256:<hex>` of a string's UTF-8 bytes, through Web Crypto (Node ≥ 22 and Bun). */
export async function sha256(input: string): Promise<string> {
  const bytes = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return `sha256:${[...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** The digest a caller passes as `expected.bodyDigest`: of the body exactly as GitHub returned it. */
export const bodyDigest = (body: string | null | undefined) => sha256(body ?? "");

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const inner of Object.values(value)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
}

/**
 * Validates an operation and returns its descriptor. Only the named fields are read, each is
 * copied, and the result is frozen: mutating the caller's object afterwards changes nothing.
 */
export async function describe(
  repository: string,
  input: WriteOperation,
): Promise<OperationDescriptor> {
  if (!input || typeof input !== "object") throw invalid("An operation is required");
  const operationId = input.operationId;
  if (typeof operationId !== "string" || !OPERATION_ID.test(operationId))
    throw invalid("operationId must be 8–128 characters of [A-Za-z0-9._:-]");
  let target: DescriptorTarget;
  let payload: Record<string, unknown>;
  let precondition: Record<string, unknown> = {};
  let capability: WriteCapability;
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
        thread: oneOf(input.thread, ["issue", "pull-request"] as const, "thread") ?? "issue",
        allowClosed: bool(input.allowClosed, "allowClosed") ?? false,
        allowLocked: bool(input.allowLocked, "allowLocked") ?? false,
      };
      capability = capabilityOf({ kind });
      break;
    }
    case "pull.review": {
      const number = positive(input.pullNumber, "pull request number");
      const event = oneOf(
        input.event,
        ["COMMENT", "APPROVE", "REQUEST_CHANGES"] as const,
        "review event",
      );
      if (!event) throw invalid("A review event is required; a pending review is not supported");
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
      if (head === base) throw invalid("head and base must differ");
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
        baseSha:
          input.expectedBaseSha === undefined
            ? undefined
            : sha(input.expectedBaseSha, "expectedBaseSha"),
      });
      capability = capabilityOf({ kind });
      break;
    }
    case "issue.update": {
      const number = positive(input.issueNumber, "issue number");
      const changes = input.changes ?? {};
      const expected = input.expected ?? ({} as never);
      target = { type: "issue", number };
      payload = defined({
        title:
          changes.title === undefined ? undefined : text(changes.title, "title", MAX_TITLE_CHARS),
        body:
          changes.body === undefined
            ? undefined
            : text(changes.body, "body", MAX_BODY_CHARS, { allowEmpty: true }),
        state: oneOf(changes.state, ["open", "closed"] as const, "state"),
        state_reason: oneOf(
          changes.stateReason,
          ["completed", "not_planned", "reopened"] as const,
          "stateReason",
        ),
        labels: list(changes.labels, "labels", MAX_LABELS, label),
      });
      if (Object.keys(payload).length === 0) throw invalid("An update needs at least one change");
      if (payload.state_reason !== undefined && payload.state === undefined)
        throw invalid("stateReason needs state");
      precondition = defined({
        updatedAt: timestamp(expected.updatedAt, "expected.updatedAt"),
        bodyDigest: optionalDigest(expected.bodyDigest, "expected.bodyDigest"),
        state: oneOf(expected.state, ["open", "closed"] as const, "expected.state"),
      });
      capability = capabilityOf({ kind });
      break;
    }
    case "pull.update": {
      const number = positive(input.pullNumber, "pull request number");
      const expected = input.expected ?? ({} as never);
      const digest = optionalDigest(expected.bodyDigest, "expected.bodyDigest");
      if (digest === undefined) throw invalid("expected.bodyDigest is required");
      target = { type: "pull", number };
      payload = { body: text(input.body, "body", MAX_BODY_CHARS, { allowEmpty: true }) };
      precondition = defined({
        bodyDigest: digest,
        headSha:
          expected.headSha === undefined ? undefined : sha(expected.headSha, "expected.headSha"),
        updatedAt:
          expected.updatedAt === undefined
            ? undefined
            : timestamp(expected.updatedAt, "expected.updatedAt"),
      });
      capability = capabilityOf({ kind });
      break;
    }
    case "comment.update": {
      const id = positive(input.commentId, "comment id");
      const expected = input.expected ?? ({} as never);
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
    schema: "comforge-github-write/v1" as const,
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
export async function correlationMarker(
  namespace: string,
  descriptor: OperationDescriptor,
): Promise<string> {
  const op = (await sha256(`${descriptor.repository}\n${descriptor.operationId}`)).slice(7, 39);
  return `${MARKER_PREFIX}v1 ns=${namespace} op=${op} fp=${descriptor.digest.slice(7, 39)} -->`;
}

/** True when `body` carries exactly this operation's marker (same operation, same fingerprint). */
export function carriesMarker(body: string | null | undefined, marker: string): boolean {
  return typeof body === "string" && body.endsWith(marker);
}

/** The body sent for a create: the authorized body, a blank line, and the marker. */
export function markedBody(body: string, marker: string | null): string {
  if (marker === null) return body;
  const joined = body.length === 0 ? marker : `${body}\n\n${marker}`;
  if (joined.length > MAX_BODY_CHARS)
    throw invalid(`body exceeds ${MAX_BODY_CHARS} characters with the correlation marker`);
  return joined;
}

export const isSha = (value: unknown): value is string =>
  typeof value === "string" && SHA.test(value);
