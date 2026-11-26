import { existsSync } from "node:fs";
import { type ComforgeConfig, readWorkingConfig } from "./config.ts";
import { fail } from "./errors.ts";
import { type GitHubAccess, openGitHub } from "./github.ts";
import { locateRepository, type Repository, trustedConfigAt } from "./repository.ts";
import type { Runtime } from "./runtime.ts";
import { type InitiativeRecord, openState, type StateStore } from "./state.ts";

/** What every command after `init` works with. */
export interface CommandContext {
  rt: Runtime;
  repo: Repository;
  state: StateStore;
  /** The primary checkout's working configuration: only for locating things before a base is known. */
  working(): ComforgeConfig;
  /** GitHub access under a trusted configuration. */
  github(trusted: ComforgeConfig): GitHubAccess;
}

export function openContext(rt: Runtime): CommandContext {
  const repo = locateRepository(rt);
  let working: ComforgeConfig | null = null;
  const access = new Map<string, GitHubAccess>();
  return {
    rt,
    repo,
    state: openState(repo.commonDir),
    working: () => {
      working ??= readWorkingConfig(repo.root);
      return working;
    },
    github: (trusted) => {
      const key = JSON.stringify(trusted.repository) + JSON.stringify(trusted.security);
      let a = access.get(key);
      if (!a) {
        a = openGitHub(rt, trusted, repo.commonDir);
        access.set(key, a);
      }
      return a;
    },
  };
}

/** An initiative's record and the trusted configuration it started from. */
export async function loadInitiative(
  ctx: CommandContext,
  id: string,
): Promise<{ record: InitiativeRecord; trusted: ComforgeConfig }> {
  const record = await ctx.state.get(id);
  if (!record)
    return fail("not-found", `${id} has no local state; run comforge start ${id}`, {
      initiative: id,
    });
  if (record.cleanedAt)
    fail("stale", `${id} was cleaned up at ${record.cleanedAt}`, { initiative: id });
  const { config, digest } = trustedConfigAt(ctx.rt, ctx.repo.root, record.base.sha);
  if (digest !== record.trustedConfig)
    fail(
      "conflict",
      "the trusted configuration at the recorded base no longer matches the record",
      {
        initiative: id,
      },
    );
  return { record, trusted: config };
}

export function requireCheckout(record: InitiativeRecord): string {
  if (!existsSync(record.checkout))
    fail("not-found", `the checkout ${record.checkout} is missing`, { checkout: record.checkout });
  return record.checkout;
}
