import { z } from "zod";
/**
 * Lifecycle decisions: whether a lifecycle step may proceed, given observations the
 * caller has already made through its own trusted adapters (Git, the forge API, the
 * lifecycle ledger). Pure: no I/O, no environment, no clock.
 *
 * Every decision is one of
 *
 *   allow                  every rule of this decision is satisfied by the evidence
 *   deny                   the evidence shows a rule is broken
 *   insufficient_evidence  required trusted evidence is absent, so the rule cannot be
 *                          evaluated; it is never treated as an allow
 *
 * with stable reason codes. An `allow` is scoped to the one decision it answers. It
 * is not an authorization: it grants no implementation, publication, merge, release or
 * deployment authority, and it never replaces a signed grant (grant.ts), a signed
 * receipt (receipt.ts) or the caller's own enforcement at the point it acts. The
 * evidence is only as trustworthy as the adapter that observed it: never pass issue
 * text, agent output or self-reported results as an observation.
 */
export declare const LIFECYCLE_ACTIONS: readonly ["publish", "publication-target", "pull-request-handoff", "complete", "deliver"];
export type LifecycleAction = (typeof LIFECYCLE_ACTIONS)[number];
export declare const LIFECYCLE_DECISIONS: readonly ["allow", "deny", "insufficient_evidence"];
/** Each reason code and the decision it always produces. */
export declare const LIFECYCLE_REASONS: {
    readonly unsupported_action: "deny";
    readonly malformed_evidence: "deny";
    readonly evidence_missing: "insufficient_evidence";
    readonly validation_missing: "insufficient_evidence";
    readonly validation_not_passing: "deny";
    readonly remote_not_ancestor: "deny";
    readonly multiple_open_pull_requests: "deny";
    readonly closed_pull_request_exists: "deny";
    readonly pull_request_not_into_base: "deny";
    readonly pull_request_not_open: "deny";
    readonly head_moved: "deny";
    readonly pull_request_draft: "deny";
    readonly assignee_missing: "deny";
    readonly foreign_head_repository: "deny";
    readonly wrong_branch: "deny";
    readonly ledger_missing: "insufficient_evidence";
    readonly publication_not_recorded: "insufficient_evidence";
    readonly unsupported_issue_type: "deny";
    readonly implementation_requires_pull_request: "deny";
    readonly source_revision_mismatch: "deny";
};
export type LifecycleReasonCode = keyof typeof LIFECYCLE_REASONS;
export interface LifecycleReason {
    code: LifecycleReasonCode;
    message: string;
    detail?: Record<string, unknown>;
}
declare const EVIDENCE: {
    /** Exact-commit validation before publication: the ledger's validations, oldest first. */
    readonly publish: z.ZodObject<{
        head: z.ZodString;
        validations: z.ZodArray<z.ZodObject<{
            commit: z.ZodString;
            status: z.ZodString;
        }, z.core.$strip>>;
    }, z.core.$strip>;
    /** Where a publication would land: the remote branch tip and every PR for the branch. */
    readonly "publication-target": z.ZodObject<{
        head: z.ZodString;
        remoteSha: z.ZodNullable<z.ZodString>;
        remoteIsAncestor: z.ZodOptional<z.ZodBoolean>;
        pullRequests: z.ZodArray<z.ZodObject<{
            number: z.ZodNumber;
            state: z.ZodEnum<{
                CLOSED: "CLOSED";
                MERGED: "MERGED";
                OPEN: "OPEN";
            }>;
            crossRepository: z.ZodBoolean;
            baseRef: z.ZodString;
        }, z.core.$strip>>;
        baseBranch: z.ZodString;
    }, z.core.$strip>;
    /** The PR as read back after a publication or delivery. */
    readonly "pull-request-handoff": z.ZodObject<{
        head: z.ZodString;
        pullRequest: z.ZodObject<{
            state: z.ZodEnum<{
                CLOSED: "CLOSED";
                MERGED: "MERGED";
                OPEN: "OPEN";
            }>;
            headSha: z.ZodString;
            isDraft: z.ZodBoolean;
            assignees: z.ZodArray<z.ZodString>;
        }, z.core.$strip>;
        requireReady: z.ZodBoolean;
        assignee: z.ZodNullable<z.ZodString>;
    }, z.core.$strip>;
    /** A completion record's pull request against the lifecycle ledger. */
    readonly complete: z.ZodObject<{
        issueType: z.ZodString;
        outcome: z.ZodString;
        head: z.ZodString;
        ticketBranch: z.ZodString;
        repository: z.ZodString;
        pullRequest: z.ZodObject<{
            number: z.ZodNumber;
            headRef: z.ZodString;
            headRepository: z.ZodNullable<z.ZodString>;
        }, z.core.$strip>;
        ledger: z.ZodNullable<z.ZodObject<{
            validations: z.ZodArray<z.ZodObject<{
                commit: z.ZodString;
                status: z.ZodString;
            }, z.core.$strip>>;
            publications: z.ZodArray<z.ZodObject<{
                commit: z.ZodString;
                prNumber: z.ZodNumber;
            }, z.core.$strip>>;
        }, z.core.$strip>>;
    }, z.core.$strip>;
    /** Whether a result is delivered with a pull request, and which revision it describes. */
    readonly deliver: z.ZodObject<{
        issueType: z.ZodString;
        outcome: z.ZodString;
        head: z.ZodString;
        baseSha: z.ZodString;
        sourceRevision: z.ZodOptional<z.ZodString>;
        withoutPullRequest: z.ZodBoolean;
    }, z.core.$strip>;
};
export type LifecycleEvidence = {
    [A in LifecycleAction]: z.input<(typeof EVIDENCE)[A]>;
};
export interface LifecycleFacts {
    /** Index into `validations` of the passing validation of the exact head. */
    publish: {
        validationIndex: number;
    };
    "publication-target": {
        /** Index into `pullRequests` of the open PR a publication updates, or null to create one. */
        openPullRequestIndex: number | null;
        push: "create-branch" | "fast-forward" | "up-to-date";
    };
    "pull-request-handoff": Record<string, never>;
    complete: {
        /** False when the PR is not a lifecycle PR: no ledger gate applies to it. */
        applies: boolean;
        /** Index into `ledger.validations` of the latest validation of the head. */
        validationIndex: number | null;
    };
    deliver: {
        pullRequest: "required" | "none";
        /** The revision the result describes, filled in when it named none. */
        sourceRevision: string;
        /** A PR that carries a report rather than an implementation. */
        reportPullRequest: boolean;
    };
}
export type LifecycleRequest = {
    [A in LifecycleAction]: {
        action: A;
        evidence: LifecycleEvidence[A];
    };
}[LifecycleAction];
export type LifecycleDecision<A extends LifecycleAction = LifecycleAction> = {
    action: A;
    decision: "allow";
    scope: string;
    facts: LifecycleFacts[A];
} | {
    action: string;
    decision: "deny" | "insufficient_evidence";
    reasons: LifecycleReason[];
};
/**
 * Evaluates one lifecycle decision. A refusal is returned, never thrown, and any request
 * it cannot evaluate (an unknown action, missing or malformed evidence) is refused, never
 * allowed.
 * The result is deeply frozen, and identical requests always produce equal results.
 */
export declare function evaluateLifecycleAction<A extends LifecycleAction>(request: {
    action: A;
    evidence: LifecycleEvidence[A];
}): LifecycleDecision<A>;
export declare function evaluateLifecycleAction(request: unknown): LifecycleDecision;
export {};
