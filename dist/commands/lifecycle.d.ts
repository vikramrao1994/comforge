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
    provision?: boolean;
}): Promise<CommandResult>;
export declare function stageOf(record: InitiativeRecord): string;
export declare function status(ctx: CommandContext, options: {
    id?: string;
}): Promise<CommandResult>;
export declare function verify(ctx: CommandContext, options: {
    id: string;
    commit?: string;
    with?: string[];
    keep?: boolean;
}): Promise<CommandResult>;
/**
 * R8: after a merge, the initiative's local and (optionally) remote leftovers, resumable.
 *
 * Proof first: the pull request is merged, its head is the published commit, and the merge
 * reached the base branch (its merge commit, or for a fast-forward the head, is an ancestor of
 * the fetched base). The checkout must be this initiative's isolated clone (under the
 * checkout parent, a repository root), clean, without stashes or extra worktrees, and every
 * local branch in it must be published or on the base. No write of the initiative may be
 * unresolved: its identities are kept in the write ledger either way.
 *
 * Steps run in order and each is journalled when done, so an interrupted cleanup resumes
 * where it stopped. Remote branch deletion needs `branches:delete` and an authorization, and
 * uses a lease on the published commit (a moved branch is never deleted). Nothing restores a
 * removed checkout; a deleted branch can be pushed again from the published commit the
 * journal records.
 */
export declare function cleanup(ctx: CommandContext, options: {
    target: string;
    execute: boolean;
    allowMissingCompletion?: boolean;
    grantFile?: string;
}): Promise<CommandResult>;
