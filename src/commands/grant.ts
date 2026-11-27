import { readFileSync } from "node:fs";
import {
  governanceGrantProtocol,
  grantProtocol,
  grantTemplate,
  signGrant,
} from "../authorization.ts";
import { type CommandContext, loadInitiative, requireCheckout } from "../context.ts";
import { fail } from "../errors.ts";
import { trustedBase } from "../repository.ts";
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
    options: { id: string; hours: number; command?: string },
  ): Promise<CommandResult> {
    const { record, trusted } = await loadInitiative(ctx, options.id);
    if (options.command !== undefined && options.command !== "cleanup")
      fail("usage", "--command takes cleanup (other scoped commands have their own services)");
    if (options.command === "cleanup") {
      // Cleanup is bound to the pull request and the head that was published (and merged).
      const published = record.publications.at(-1);
      if (!published)
        return fail("usage", `${options.id} has no published pull request to clean up`);
      return {
        result: grantTemplate(trusted, record, published.commit, ctx.rt.now(), options.hours, {
          command: "cleanup",
          pullRequest: published.prNumber,
        }) as unknown as Record<string, unknown>,
      };
    }
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
    // "-": a governance command grant (specification or review publication), which belongs to
    // no initiative; it is signed under the base revision's trusted configuration.
    const { protocol } =
      options.id === "-"
        ? { protocol: governanceGrantProtocol(trustedAtBase(ctx)) }
        : await (async () => {
            const { record, trusted } = await loadInitiative(ctx, options.id);
            return { protocol: grantProtocol(trusted, record) };
          })();
    let grant: unknown;
    let key: string;
    try {
      grant = JSON.parse(readFileSync(options.grantFile, "utf8"));
      key = readFileSync(options.keyFile, "utf8");
    } catch {
      return fail("usage", "--grant must be a JSON file and --key a PEM private key file");
    }
    return {
      result: signGrant(protocol, grant, key) as unknown as Record<string, unknown>,
    };
  },
};

function trustedAtBase(ctx: CommandContext) {
  return trustedBase(ctx.rt, ctx.repo.root, ctx.working()).config;
}
