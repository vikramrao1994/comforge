import { type Authorized, authorizeGovernanceWrite } from "../authorization.ts";
import { type ComforgeConfig } from "../config.ts";
import type { CommandContext } from "../context.ts";
import { type GitHubAccess } from "../github.ts";
import type { CommandResult } from "./lifecycle.ts";
/**
 * What a governance command needs, and nothing else (0.6.0): the trusted configuration, GitHub
 * access under it, the write authorization, a clock and cancellation. A checkout-backed command
 * builds it from its CommandContext (`governanceOf`); a checkout-free host builds it from a
 * configuration it has already verified against GitHub (`createRemoteGovernance`). The commands
 * cannot tell the two apart, so both publish the same records under the same checks.
 */
export interface GovernanceContext {
    /** The configuration of the base revision: candidate text cannot change what is checked. */
    trusted(): ComforgeConfig;
    github(trusted: ComforgeConfig): GitHubAccess;
    authorize(trusted: ComforgeConfig, options: AuthorizationRequest): Promise<Authorized>;
    now(): number;
    checkpoint(): void;
}
/** A governance write to authorize: a grant-scoped command, or a discussion comment. */
export type AuthorizationRequest = {
    grantFile?: string;
    context: Parameters<typeof authorizeGovernanceWrite>[2]["context"];
} | {
    grantFile?: string;
    context: {
        command: "publish-comment";
        ticket: string;
        issue: number;
        specification: {
            ticketId: string;
            digest: string;
            digestMatches: boolean;
        };
    };
};
/**
 * Discussion comments have no owner-grant command scope (the grant protocol cannot bind one), so
 * an owner-grant repository refuses them rather than accept a grant scoped to something else.
 */
export declare function discussionAuthorization(trusted: ComforgeConfig): Authorized;
/** The governance context of a checkout: the base revision's configuration and the CLI's own authorization. */
export declare function governanceOf(ctx: CommandContext): GovernanceContext;
declare function publishSpecificationWith(ctx: GovernanceContext, options: {
    ticket: string;
    title: string;
    body: string;
    /** Replace the specification of this existing issue instead of creating one. */
    issue?: number;
    idempotencyKey?: string;
    execute: boolean;
    grantFile?: string;
}): Promise<CommandResult>;
declare function publishReviewWith(ctx: GovernanceContext, options: {
    review: unknown;
    execute: boolean;
    grantFile?: string;
}): Promise<CommandResult>;
/**
 * One owner-confirmed discussion comment on an open, published specification issue: never a
 * comment on any other issue or on a pull request, never a review, completion or authorization.
 * Idempotent per key: an earlier comment with the same key and content is replayed, the same key
 * with other content is a conflict, and the send goes through the writer's durable operation
 * identity, reconciled against GitHub first. A replay is answered even on a closed issue; a new
 * comment needs an open one.
 */
declare function publishCommentWith(ctx: GovernanceContext, options: {
    issue: number;
    body: string;
    idempotencyKey: string;
    relatedReview?: {
        prNumber: number;
        commentId: number;
        reviewedHeadSha: string;
    };
    execute: boolean;
    grantFile?: string;
}): Promise<CommandResult>;
declare function issueCommentsWith(ctx: GovernanceContext, options: {
    issue: number;
}): Promise<CommandResult>;
declare function pullRequestsWith(ctx: GovernanceContext, options: {
    state?: "open" | "closed" | "all";
}): Promise<CommandResult>;
declare function advisoryReviewsWith(ctx: GovernanceContext, options: {
    pr: number;
}): Promise<CommandResult>;
/**
 * Whether `file` may be read remotely under the trusted configuration's artifact policy. Only a
 * canonical path is matched (no `..`, `.`, empty segment or backslash), and only at a directory
 * boundary; a non-canonical spelling is refused, never normalized into a match.
 */
export declare function artifactReadable(trusted: ComforgeConfig, file: string): boolean;
declare function artifactWith(ctx: GovernanceContext, options: {
    commit: string;
    path: string;
}): Promise<CommandResult>;
export declare function publishSpecification(ctx: CommandContext, options: Parameters<typeof publishSpecificationWith>[1]): Promise<CommandResult>;
export declare function publishReview(ctx: CommandContext, options: Parameters<typeof publishReviewWith>[1]): Promise<CommandResult>;
export declare function issueComments(ctx: CommandContext, options: Parameters<typeof issueCommentsWith>[1]): Promise<CommandResult>;
export declare function pullRequests(ctx: CommandContext, options: Parameters<typeof pullRequestsWith>[1]): Promise<CommandResult>;
export declare function advisoryReviews(ctx: CommandContext, options: Parameters<typeof advisoryReviewsWith>[1]): Promise<CommandResult>;
export declare function artifact(ctx: CommandContext, options: Parameters<typeof artifactWith>[1]): Promise<CommandResult>;
export declare function publishComment(ctx: CommandContext, options: Parameters<typeof publishCommentWith>[1]): Promise<CommandResult>;
/** The same commands over a supplied governance context (a checkout-free host). */
export declare const governanceCommands: {
    readonly publishSpecification: typeof publishSpecificationWith;
    readonly publishReview: typeof publishReviewWith;
    readonly publishComment: typeof publishCommentWith;
    readonly issueComments: typeof issueCommentsWith;
    readonly pullRequests: typeof pullRequestsWith;
    readonly advisoryReviews: typeof advisoryReviewsWith;
    readonly artifact: typeof artifactWith;
};
export {};
