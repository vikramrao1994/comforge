import { type CompletionInput } from "@comforge/core";
import { z } from "zod";
import { type Authorized } from "../authorization.ts";
import type { ComforgeConfig } from "../config.ts";
import { type CommandContext } from "../context.ts";
import { type GitHubAccess } from "../github.ts";
import { type InitiativeRecord } from "../state.ts";
import { type CommandResult } from "./lifecycle.ts";
/** Removes the SDK writer's correlation marker, which caller text may not carry. */
export declare const withoutWriterMarker: (body: string) => string;
declare const PullSchema: z.ZodObject<{
    number: z.ZodNumber;
    state: z.ZodString;
    draft: z.ZodOptional<z.ZodBoolean>;
    merged_at: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    body: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    html_url: z.ZodString;
    head: z.ZodObject<{
        ref: z.ZodString;
        sha: z.ZodString;
        repo: z.ZodNullable<z.ZodObject<{
            full_name: z.ZodString;
        }, z.core.$strip>>;
    }, z.core.$strip>;
    base: z.ZodObject<{
        ref: z.ZodString;
    }, z.core.$strip>;
    assignees: z.ZodDefault<z.ZodArray<z.ZodObject<{
        login: z.ZodString;
    }, z.core.$strip>>>;
}, z.core.$strip>;
type Pull = z.infer<typeof PullSchema>;
/** Same bound as the portfolio's lifecycle writer for repeats of one transition. */
export declare const MAX_TRANSITION_REPEATS = 8;
/**
 * No new write while an earlier one of this initiative is unresolved: its identity may be
 * derived differently (an imported write), so only `recover` may settle it, never a resend.
 */
export declare function requireResolved(gh: GitHubAccess, record: InitiativeRecord | null, now: number): Promise<void>;
export declare function publish(ctx: CommandContext, options: {
    id: string;
    title: string;
    draft?: boolean;
    /** Adds `Closes #N` to the body (GitHub closes it when a person merges). */
    closes?: number;
    execute: boolean;
    grantFile?: string;
    /** Set by deliver, which authorized the whole delivery once. */
    authorized?: Authorized;
}): Promise<CommandResult & {
    pullRequest?: Pull;
}>;
/**
 * Refuses a body whose completion-link block is ambiguous: a marker twice, an end before its
 * begin, a lone marker, or blocks in two namespaces (an earlier namespace still in the body).
 * Rewriting such a body could drop or duplicate a link, so a person fixes it first.
 */
export declare function assertCompletionLinkUnambiguous(body: string, namespace?: string): void;
/** The completion-link block of a body, or null. */
export declare function completionLinkBlock(body: string, namespace?: string): string | null;
/** The body with its completion-link block replaced (or appended); every other byte is kept. */
export declare function withCompletionLink(body: string, link: {
    issueNumber: number;
    url: string;
    headSha: string;
}, namespace?: string): string;
export declare function parseResult(config: ComforgeConfig, raw: unknown): CompletionInput;
export declare const readResultFile: (file: string) => unknown;
export declare function complete(ctx: CommandContext, options: {
    raw: unknown;
    execute: boolean;
    grantFile?: string;
    authorized?: Authorized;
}): Promise<CommandResult>;
export declare function deliver(ctx: CommandContext, options: {
    id: string;
    title: string;
    raw: unknown;
    withoutPullRequest?: boolean;
    draft?: boolean;
    closes?: number;
    execute: boolean;
    grantFile?: string;
}): Promise<CommandResult>;
export declare function recover(ctx: CommandContext, options: {
    id: string;
    execute: boolean;
    abandon?: boolean;
    grantFile?: string;
}): Promise<CommandResult>;
export {};
