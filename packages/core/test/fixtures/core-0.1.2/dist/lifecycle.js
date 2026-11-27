import { z } from "zod";
import { ISSUE_TYPE_MATRIX } from "./completion.js";
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
export const LIFECYCLE_ACTIONS = [
    "publish",
    "publication-target",
    "pull-request-handoff",
    "complete",
    "deliver",
];
export const LIFECYCLE_DECISIONS = ["allow", "deny", "insufficient_evidence"];
/** Each reason code and the decision it always produces. */
export const LIFECYCLE_REASONS = {
    unsupported_action: "deny",
    malformed_evidence: "deny",
    evidence_missing: "insufficient_evidence",
    validation_missing: "insufficient_evidence",
    validation_not_passing: "deny",
    remote_not_ancestor: "deny",
    multiple_open_pull_requests: "deny",
    closed_pull_request_exists: "deny",
    pull_request_not_into_base: "deny",
    pull_request_not_open: "deny",
    head_moved: "deny",
    pull_request_draft: "deny",
    assignee_missing: "deny",
    foreign_head_repository: "deny",
    wrong_branch: "deny",
    ledger_missing: "insufficient_evidence",
    publication_not_recorded: "insufficient_evidence",
    unsupported_issue_type: "deny",
    implementation_requires_pull_request: "deny",
    source_revision_mismatch: "deny",
};
// A commit as the caller's Git observed it. Only compared for equality, so any object
// format (SHA-1 or SHA-256) is accepted; the decision never parses it.
const COMMIT = z.string().min(1);
const PR_STATE = z.enum(["OPEN", "CLOSED", "MERGED"]);
const ValidationObservation = z.object({ commit: z.string().min(1), status: z.string().min(1) });
const EVIDENCE = {
    /** Exact-commit validation before publication: the ledger's validations, oldest first. */
    publish: z.object({ head: COMMIT, validations: z.array(ValidationObservation) }),
    /** Where a publication would land: the remote branch tip and every PR for the branch. */
    "publication-target": z.object({
        head: COMMIT,
        remoteSha: COMMIT.nullable(),
        /** Required only when the remote branch exists and is not the head itself. */
        remoteIsAncestor: z.boolean().optional(),
        pullRequests: z.array(z.object({
            number: z.number().int().positive(),
            state: PR_STATE,
            crossRepository: z.boolean(),
            baseRef: z.string(),
        })),
        baseBranch: z.string().min(1),
    }),
    /** The PR as read back after a publication or delivery. */
    "pull-request-handoff": z.object({
        head: COMMIT,
        pullRequest: z.object({
            state: PR_STATE,
            headSha: z.string(),
            isDraft: z.boolean(),
            assignees: z.array(z.string()),
        }),
        requireReady: z.boolean(),
        assignee: z.string().min(1).nullable(),
    }),
    /** A completion record's pull request against the lifecycle ledger. */
    complete: z.object({
        issueType: z.string(),
        outcome: z.string(),
        head: z.string().min(1),
        ticketBranch: z.string().min(1),
        repository: z.string().min(1),
        pullRequest: z.object({
            number: z.number().int().positive(),
            headRef: z.string(),
            headRepository: z.string().nullable(),
        }),
        ledger: z
            .object({
            validations: z.array(ValidationObservation),
            publications: z.array(z.object({ commit: z.string(), prNumber: z.number().int().positive() })),
        })
            .nullable(),
    }),
    /** Whether a result is delivered with a pull request, and which revision it describes. */
    deliver: z.object({
        issueType: z.string(),
        outcome: z.string(),
        head: COMMIT,
        baseSha: COMMIT,
        /** As the result states it; absent when the result does not name one. */
        sourceRevision: z.string().optional(),
        withoutPullRequest: z.boolean(),
    }),
};
const SCOPE = {
    publish: "The exact head has a passing snapshot validation. It does not authorize publication.",
    "publication-target": "Publishing the head would neither force-push nor reopen or duplicate a pull request. It does not authorize publication.",
    "pull-request-handoff": "The pull request reads back as the handoff that was requested. It is not an approval.",
    complete: "The ledger shows this head was validated and published to this pull request. A completion record is not merge or deployment authority.",
    deliver: "The result's delivery path and revision are consistent. It does not authorize delivery.",
};
class Refusal {
    reasons;
    constructor(reasons) {
        this.reasons = reasons;
    }
}
const reason = (code, message, detail) => (detail ? { code, message, detail } : { code, message });
function refuse(code, message, detail) {
    throw new Refusal([reason(code, message, detail)]);
}
/** The latest validation of exactly this commit; any earlier result for it is superseded. */
function latestValidationIndex(validations, head) {
    for (let i = validations.length - 1; i >= 0; i -= 1)
        if (validations[i]?.commit === head)
            return i;
    return -1;
}
function familyOf(issueType) {
    return Object.hasOwn(ISSUE_TYPE_MATRIX, issueType)
        ? ISSUE_TYPE_MATRIX[issueType].family
        : null;
}
const EVALUATE = {
    publish(e) {
        const index = latestValidationIndex(e.validations, e.head);
        const latest = index < 0 ? null : (e.validations[index]?.status ?? null);
        if (latest === null)
            refuse("validation_missing", "The exact head has no snapshot validation", {
                head: e.head,
                latest,
            });
        if (latest !== "PASS")
            refuse("validation_not_passing", "The latest snapshot validation of the head is not PASS", {
                head: e.head,
                latest,
            });
        return { validationIndex: index };
    },
    "publication-target"(e) {
        if (e.remoteSha && e.remoteSha !== e.head) {
            if (e.remoteIsAncestor === undefined)
                refuse("evidence_missing", "Whether the remote branch is an ancestor of the head", {
                    fields: ["remoteIsAncestor"],
                });
            if (!e.remoteIsAncestor)
                refuse("remote_not_ancestor", "The remote branch is not an ancestor of the head", {
                    remote: e.remoteSha,
                    head: e.head,
                });
        }
        const open = e.pullRequests.flatMap((p, i) => (p.state === "OPEN" ? [i] : []));
        if (open.length > 1)
            refuse("multiple_open_pull_requests", "More than one open pull request for the branch", {
                prs: open.map((i) => e.pullRequests[i]?.number),
            });
        if (open.length === 0 && e.pullRequests.length > 0)
            refuse("closed_pull_request_exists", "A closed or merged pull request exists for the branch", {
                prs: e.pullRequests.map((p) => ({ number: p.number, state: p.state })),
            });
        const index = open[0] ?? null;
        const existing = index === null ? null : e.pullRequests[index];
        if (existing && (existing.crossRepository || existing.baseRef !== e.baseBranch))
            refuse("pull_request_not_into_base", "The open pull request is not a same-repository pull request into the base branch");
        return {
            openPullRequestIndex: index,
            push: e.remoteSha === e.head ? "up-to-date" : e.remoteSha ? "fast-forward" : "create-branch",
        };
    },
    "pull-request-handoff"(e) {
        const pr = e.pullRequest;
        const reasons = [
            pr.state !== "OPEN"
                ? reason("pull_request_not_open", "The pull request is not open", { state: pr.state })
                : null,
            pr.headSha !== e.head
                ? reason("head_moved", "The pull request head is not the expected head", {
                    expected: e.head,
                    actual: pr.headSha,
                })
                : null,
            e.requireReady && pr.isDraft
                ? reason("pull_request_draft", "The pull request is still a draft")
                : null,
            e.assignee !== null && !pr.assignees.includes(e.assignee)
                ? reason("assignee_missing", "The pull request is not assigned as requested", {
                    assignee: e.assignee,
                })
                : null,
        ].filter((r) => r !== null);
        if (reasons.length > 0)
            throw new Refusal(reasons);
        return {};
    },
    complete(e) {
        const family = familyOf(e.issueType);
        if (family === null)
            refuse("unsupported_issue_type", "The issue type is not supported", {
                issueType: e.issueType,
            });
        // Implementation PRs always; another type's PR when it is the ticket's own branch.
        const applies = family === "implementation" || e.pullRequest.headRef === e.ticketBranch;
        if (!applies)
            return { applies: false, validationIndex: null };
        if (e.pullRequest.headRepository !== e.repository)
            refuse("foreign_head_repository", "The pull request head is not in this repository", {
                headRepository: e.pullRequest.headRepository,
            });
        if (e.pullRequest.headRef !== e.ticketBranch)
            refuse("wrong_branch", "The pull request is not from the ticket's branch", {
                headRef: e.pullRequest.headRef,
                ticketBranch: e.ticketBranch,
            });
        if (!e.ledger)
            refuse("ledger_missing", "There is no lifecycle record for the ticket");
        const index = latestValidationIndex(e.ledger.validations, e.head);
        if (index < 0)
            refuse("validation_missing", "The head has no snapshot validation", { head: e.head });
        if (!e.ledger.publications.some((p) => p.commit === e.head && p.prNumber === e.pullRequest.number))
            refuse("publication_not_recorded", "The ledger has no publication of this head to this pull request", { head: e.head });
        const status = e.ledger.validations[index]?.status;
        if (e.outcome === "completed" && status !== "PASS")
            refuse("validation_not_passing", "A completed result needs a PASS validation of the head", {
                status,
            });
        return { applies: true, validationIndex: index };
    },
    deliver(e) {
        const family = familyOf(e.issueType);
        if (family === null)
            refuse("unsupported_issue_type", "The issue type is not supported", {
                issueType: e.issueType,
            });
        if (family === "implementation" && e.withoutPullRequest)
            refuse("implementation_requires_pull_request", "An implementation is always delivered with its pull request");
        // A blocked or failed result publishes only its record: there is nothing to review.
        const delivered = e.outcome === "completed" || e.outcome === "partial";
        const required = delivered && !e.withoutPullRequest;
        if (required && family === "implementation") {
            if (e.sourceRevision !== undefined && e.sourceRevision !== e.head)
                refuse("source_revision_mismatch", "The result describes another revision than the head", {
                    result: e.sourceRevision,
                    head: e.head,
                });
            return { pullRequest: "required", sourceRevision: e.head, reportPullRequest: false };
        }
        // A report (or a result without a PR) describes the audited revision, by default the
        // initiative's base; a report PR's head is recorded separately.
        return {
            pullRequest: required ? "required" : "none",
            sourceRevision: e.sourceRevision ?? e.baseSha,
            reportPullRequest: required,
        };
    },
};
function valueAt(root, path) {
    let value = root;
    for (const key of path) {
        if (value === null || typeof value !== "object")
            return undefined;
        value = value[key];
    }
    return value;
}
function freeze(value) {
    if (value && typeof value === "object") {
        for (const inner of Object.values(value))
            freeze(inner);
        Object.freeze(value);
    }
    return value;
}
export function evaluateLifecycleAction(request) {
    const action = request !== null && typeof request === "object" && "action" in request
        ? request.action
        : undefined;
    if (typeof action !== "string" || !LIFECYCLE_ACTIONS.includes(action))
        return freeze({
            action: typeof action === "string" ? action : "",
            decision: "deny",
            reasons: [
                reason("unsupported_action", "The action is not a supported lifecycle decision", {
                    action: typeof action === "string" ? action : null,
                }),
            ],
        });
    const name = action;
    const raw = request.evidence;
    const parsed = EVIDENCE[name].safeParse(raw);
    if (!parsed.success) {
        const missing = [
            ...new Set(parsed.error.issues
                .filter((issue) => valueAt(raw, issue.path) === undefined)
                .map((issue) => issue.path.join(".") || "evidence")),
        ];
        return freeze({
            action: name,
            decision: missing.length > 0 ? "insufficient_evidence" : "deny",
            reasons: [
                missing.length > 0
                    ? reason("evidence_missing", "Required evidence was not supplied", { fields: missing })
                    : reason("malformed_evidence", "The evidence does not match the decision's schema", {
                        fields: [...new Set(parsed.error.issues.map((issue) => issue.path.join(".")))],
                    }),
            ],
        });
    }
    try {
        const facts = EVALUATE[name](parsed.data);
        return freeze({ action: name, decision: "allow", scope: SCOPE[name], facts });
    }
    catch (err) {
        if (!(err instanceof Refusal))
            throw err;
        const denied = err.reasons.some((r) => LIFECYCLE_REASONS[r.code] === "deny");
        return freeze({
            action: name,
            decision: denied ? "deny" : "insufficient_evidence",
            reasons: err.reasons,
        });
    }
}
