import type { ComforgeConfig } from "../config.ts";
import { type CommandContext } from "../context.ts";
import { type InitiativeRecord } from "../state.ts";
/** A command's result; `exit` overrides the default 0 for a result that is not an error (e.g. verify FAIL). */
export interface CommandResult {
    result: Record<string, unknown>;
    exit?: number;
}
export declare function start(ctx: CommandContext, options: {
    id: string;
    issue?: number;
    expectDigest?: string;
    provision?: boolean;
}): Promise<CommandResult>;
export declare const credentialVariables: (config: ComforgeConfig) => string[];
export declare function revise(ctx: CommandContext, options: {
    pr: number;
    reviewedHead?: string;
}): Promise<CommandResult>;
export declare function stageOf(record: InitiativeRecord): string;
export declare function status(ctx: CommandContext, options: {
    id?: string;
}): Promise<CommandResult>;
export declare function verify(ctx: CommandContext, options: {
    id: string;
    commit?: string;
}): Promise<CommandResult>;
export declare function cleanup(ctx: CommandContext, options: {
    target: string;
    execute: boolean;
    allowMissingCompletion?: boolean;
}): Promise<CommandResult>;
