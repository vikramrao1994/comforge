import { type ComforgeConfig } from "../config.ts";
import type { CommandContext } from "../context.ts";
import type { CommandResult } from "./lifecycle.ts";
export declare function publishSpecification(ctx: CommandContext, options: {
    ticket: string;
    title: string;
    body: string;
    /** Replace the specification of this existing issue instead of creating one. */
    issue?: number;
    idempotencyKey?: string;
    execute: boolean;
    grantFile?: string;
}): Promise<CommandResult>;
export declare function publishReview(ctx: CommandContext, options: {
    review: unknown;
    execute: boolean;
    grantFile?: string;
}): Promise<CommandResult>;
export declare function issueComments(ctx: CommandContext, options: {
    issue: number;
}): Promise<CommandResult>;
export declare function pullRequests(ctx: CommandContext, options: {
    state?: "open" | "closed" | "all";
}): Promise<CommandResult>;
export declare function advisoryReviews(ctx: CommandContext, options: {
    pr: number;
}): Promise<CommandResult>;
/**
 * Whether `file` may be read remotely under the trusted configuration's artifact policy. Only a
 * canonical path is matched (no `..`, `.`, empty segment or backslash), and only at a directory
 * boundary; a non-canonical spelling is refused, never normalized into a match.
 */
export declare function artifactReadable(trusted: ComforgeConfig, file: string): boolean;
export declare function artifact(ctx: CommandContext, options: {
    commit: string;
    path: string;
}): Promise<CommandResult>;
