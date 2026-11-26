import { type CompletionInput } from "@comforge/core";
import { z } from "zod";
import { type Authorized } from "../authorization.ts";
import type { ComforgeConfig } from "../config.ts";
import { type CommandContext } from "../context.ts";
import type { CommandResult } from "./lifecycle.ts";
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
export declare function publish(ctx: CommandContext, options: {
    id: string;
    title: string;
    draft?: boolean;
    execute: boolean;
    grantFile?: string;
    /** Set by deliver, which authorized the whole delivery once. */
    authorized?: Authorized;
}): Promise<CommandResult & {
    pullRequest?: Pull;
}>;
/** The completion-link block of a body, or null. */
export declare function completionLinkBlock(body: string): string | null;
export declare function withCompletionLink(body: string, link: {
    issueNumber: number;
    url: string;
    headSha: string;
}): string;
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
