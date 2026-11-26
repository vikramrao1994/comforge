import { readFileSync } from "node:fs";
import { grantProtocol, grantTemplate, signGrant } from "../authorization.ts";
import { type CommandContext, loadInitiative, requireCheckout } from "../context.ts";
import { fail } from "../errors.ts";
import { git } from "../runtime.ts";
import type { CommandResult } from "./lifecycle.ts";

/**
 * Owner grants for `security.authorization.mode: owner-grant`.
 * `template` prints an unsigned grant for the initiative's current head, to review.
 * `sign` signs one with an Ed25519 private key: run it on the owner's machine; an agent that can
 * read the key can authorize itself, which no command here can prevent.
 */
export const grantCommand = {
  async template(
    ctx: CommandContext,
    options: { id: string; hours: number },
  ): Promise<CommandResult> {
    const { record, trusted } = await loadInitiative(ctx, options.id);
    const head = git(ctx.rt, requireCheckout(record), ["rev-parse", "HEAD"]);
    return {
      result: grantTemplate(
        trusted,
        record,
        head,
        ctx.rt.now(),
        options.hours,
      ) as unknown as Record<string, unknown>,
    };
  },
  async sign(
    ctx: CommandContext,
    options: { id: string; grantFile: string; keyFile: string },
  ): Promise<CommandResult> {
    const { record, trusted } = await loadInitiative(ctx, options.id);
    let grant: unknown;
    let key: string;
    try {
      grant = JSON.parse(readFileSync(options.grantFile, "utf8"));
      key = readFileSync(options.keyFile, "utf8");
    } catch {
      return fail("usage", "--grant must be a JSON file and --key a PEM private key file");
    }
    return {
      result: signGrant(grantProtocol(trusted, record), grant, key) as unknown as Record<
        string,
        unknown
      >,
    };
  },
};
