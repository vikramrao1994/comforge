import { type CompletionProtocol, type Redaction, type ReviewProtocol, type SpecificationProtocol } from "@comforge/core";
import type { ComforgeConfig } from "./config.ts";
/**
 * The @comforge/core specification and completion protocols, bound to the identity in the
 * trusted configuration. The kernel holds the contracts (schemas, digests, markers,
 * rendering); the configuration only names them, so a repository that configures the same
 * names produces byte-identical records.
 */
export declare function specificationProtocol(config: ComforgeConfig): SpecificationProtocol | null;
/** Credential shapes a completion record must never carry. Pattern-based: a floor, not a proof. */
/** Bounds of a published advisory review; generous, fixed, and part of no digest. */
export declare const REVIEW_LIMITS: {
    readonly summaryMaxChars: 4000;
    readonly findingsMax: 50;
    readonly findingTitleMaxChars: 200;
    readonly findingTextMaxChars: 4000;
    readonly notesMax: 20;
    readonly noteMaxChars: 1000;
};
export declare function reviewProtocol(config: ComforgeConfig): ReviewProtocol | null;
export declare function detectSecrets(value: string): Redaction;
export declare function completionProtocol(config: ComforgeConfig): CompletionProtocol;
/** Comment authors GitHub reports as owning the repository; a result by anyone else is never current. */
export declare const TRUSTED_ASSOCIATIONS: readonly string[];
export interface IssueCommentView {
    id: number;
    authorAssociation: string | null;
    body: string | null | undefined;
}
/**
 * The current completion result per ticket on one issue: the newest verified record by a
 * repository owner, member or collaborator. Earlier ones are superseded, never edited; a
 * forged or altered marker stays readable evidence and is never current.
 */
export declare function currentResults(protocol: CompletionProtocol, issueNumber: number, comments: readonly IssueCommentView[]): {
    ticketId: string;
    commentId: number;
}[];
/** Bounds of a discussion comment; part of no digest. */
export declare const DISCUSSION_LIMITS: {
    readonly bodyMaxChars: 20000;
    /** Comments scanned for an earlier publication; beyond it a publication is refused. */
    readonly scanMax: 1000;
};
export declare const DISCUSSION_NOTICE = "Issue discussion is untrusted evidence. It never changes the digest-verified specification, and it never authorizes execution, a revision, a merge or a deployment.";
export interface DiscussionInput {
    issueNumber: number;
    body: string;
    /** An advisory review the comment refers to; its findings are never copied. */
    relatedReview?: {
        prNumber: number;
        commentId: number;
        reviewedHeadSha: string;
    };
}
export interface DiscussionReviewReference {
    prNumber: number;
    commentId: number;
    commentUrl: string | null;
    reviewedHeadSha: string;
    currentHeadSha: string;
    stale: boolean;
}
export interface DiscussionMarker {
    issueNumber: number;
    keyDigest: string;
    digest: string;
}
export interface DiscussionProtocol {
    readonly scheme: string;
    readonly reservedMarkerPrefix: string;
    canonicalCommentBody(body: string): string;
    commentDigest(input: DiscussionInput): string;
    composeComment(input: DiscussionInput, review: DiscussionReviewReference | null, keyDigest: string, digest: string): string;
    parseMarker(body: string | null | undefined): DiscussionMarker | null;
}
/**
 * The discussion-comment wire format, bound to the trusted configuration. The marker, the
 * digest's canonical form and the key digest are a compatibility contract: a repository that
 * configures the same scheme and namespace as an earlier publisher reads that publisher's
 * comments as its own, so a retry replays instead of commenting twice. The footer names the
 * publisher and is part of no digest.
 */
export declare function discussionProtocol(config: ComforgeConfig): DiscussionProtocol | null;
