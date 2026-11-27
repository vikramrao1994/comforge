import { type CommandContext } from "../context.ts";
import type { CommandResult } from "./lifecycle.ts";
/**
 * Owner grants for `security.authorization.mode: owner-grant`.
 * `template` prints an unsigned grant for the initiative's current head, to review.
 * `sign` signs one with an Ed25519 private key: run it on the owner's machine; an agent that can
 * read the key can authorize itself, which no command here can prevent.
 */
export declare const grantCommand: {
    template(ctx: CommandContext, options: {
        id: string;
        hours: number;
        command?: string;
    }): Promise<CommandResult>;
    sign(ctx: CommandContext, options: {
        id: string;
        grantFile: string;
        keyFile: string;
    }): Promise<CommandResult>;
};
