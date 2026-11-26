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
export declare const WRITE_CAPABILITIES: readonly ["issues:create", "issues:comment", "issues:update", "issues:comment:update", "pulls:create", "pulls:update", "pulls:review", "pulls:review:approve", "pulls:review:request-changes"];
export type WriteCapability = (typeof WRITE_CAPABILITIES)[number];
export type ReviewEvent = "COMMENT" | "APPROVE" | "REQUEST_CHANGES";
export type WriteOperation = {
    kind: "issue.create";
    operationId: string;
    title: string;
    body: string;
    labels?: readonly string[];
    assignees?: readonly string[];
} | {
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
} | {
    kind: "pull.review";
    operationId: string;
    pullNumber: number;
    /** The head the review is of; sent as `commit_id`, and the pull request must still be at it. */
    expectedHeadSha: string;
    event: ReviewEvent;
    body: string;
} | {
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
} | {
    kind: "issue.update";
    operationId: string;
    issueNumber: number;
    /** The issue as the caller last read it; any difference before the write is `stale`. */
    expected: {
        updatedAt: string;
        bodyDigest?: string;
        state?: "open" | "closed";
    };
    changes: {
        title?: string;
        body?: string;
        state?: "open" | "closed";
        stateReason?: "completed" | "not_planned" | "reopened";
        labels?: readonly string[];
    };
} | {
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
    expected: {
        bodyDigest: string;
        headSha?: string;
        updatedAt?: string;
    };
    /** The new body. Title, state, base and draft are deliberately not editable here. */
    body: string;
} | {
    kind: "comment.update";
    operationId: string;
    commentId: number;
    /** The comment as the caller last read it; any difference before the write is `stale`. */
    expected: {
        issueNumber: number;
        updatedAt: string;
        bodyDigest?: string;
        author?: string;
    };
    body: string;
};
export type WriteKind = WriteOperation["kind"];
/** The capability an operation needs. A review's event chooses among three. */
export declare function capabilityOf(op: Pick<WriteOperation, "kind"> & {
    event?: ReviewEvent;
}): WriteCapability;
export type DescriptorTarget = {
    type: "repository";
} | {
    type: "issue";
    number: number;
} | {
    type: "pull";
    number: number;
} | {
    type: "comment";
    id: number;
} | {
    type: "branch";
    head: string;
    base: string;
};
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
export declare const MAX_BODY_CHARS = 65536;
export declare const MAX_TITLE_CHARS = 256;
/** Reserved for the writer's own correlation marker; refused in caller text. */
export declare const MARKER_PREFIX = "<!-- comforge-op ";
/** A branch name git and GitHub both accept, kept to a conservative subset. */
export declare function branch(value: unknown, what: string): string;
/** JSON with object keys sorted at every depth: the digest input. */
export declare function canonicalJson(value: unknown): string;
/** `sha256:<hex>` of a string's UTF-8 bytes, through Web Crypto (Node ≥ 22 and Bun). */
export declare function sha256(input: string): Promise<string>;
/** The digest a caller passes as `expected.bodyDigest`: of the body exactly as GitHub returned it. */
export declare const bodyDigest: (body: string | null | undefined) => Promise<string>;
/**
 * Validates an operation and returns its descriptor. Only the named fields are read, each is
 * copied, and the result is frozen: mutating the caller's object afterwards changes nothing.
 */
export declare function describe(repository: string, input: WriteOperation): Promise<OperationDescriptor>;
/**
 * The correlation marker appended to a created body: digests only, never the raw operation id.
 * Anyone who can write to the repository can copy it, so a match is evidence that needs the
 * author check (`expectedAuthor`), not proof.
 */
export declare function correlationMarker(namespace: string, descriptor: OperationDescriptor): Promise<string>;
/** True when `body` carries exactly this operation's marker (same operation, same fingerprint). */
export declare function carriesMarker(body: string | null | undefined, marker: string): boolean;
/** The body sent for a create: the authorized body, a blank line, and the marker. */
export declare function markedBody(body: string, marker: string | null): string;
export declare const isSha: (value: unknown) => value is string;
