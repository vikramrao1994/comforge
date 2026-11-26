import { existsSync } from "node:fs";
import type { OperationRecord } from "@comforge/github";
import type { Ledger } from "@comforge/ledger";
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
  /** Throws `cancelled` once the caller's signal is aborted; commands call it between stages. */
  checkpoint(): void;
}

/** Supplies the GitHub token for one trusted configuration; never written or logged. */
export type CredentialProvider = (config: ComforgeConfig) => string;

export interface ContextOptions {
  /** The repository to act on; by default the one containing `rt.cwd`. */
  repository?: Repository;
  /** Replaces the configured credential source (an embedding service's own credential). */
  credentials?: CredentialProvider;
  /** Cancels the command between stages (never in the middle of a write). */
  signal?: AbortSignal;
  /** Initiative state in the embedder's own store instead of `.git/comforge/`. */
  state?: StateStore;
  /** The GitHub write ledger in the embedder's own store (for example @comforge/ledger SQLite). */
  writeLedger?: (config: ComforgeConfig) => Ledger<OperationRecord>;
}

export function openContext(rt: Runtime, options: ContextOptions = {}): CommandContext {
  const repo = options.repository ?? locateRepository(rt);
  let working: ComforgeConfig | null = null;
  const access = new Map<string, GitHubAccess>();
  return {
    rt,
    repo,
    state: options.state ?? openState(repo.commonDir),
    working: () => {
      working ??= readWorkingConfig(repo.root);
      return working;
    },
    github: (trusted) => {
      const key =
        JSON.stringify(trusted.repository) +
        JSON.stringify(trusted.security) +
        JSON.stringify(trusted.state);
      let a = access.get(key);
      if (!a) {
        a = openGitHub(rt, trusted, repo.commonDir, options.credentials, options.writeLedger);
        access.set(key, a);
      }
      return a;
    },
    checkpoint: () => {
      if (options.signal?.aborted)
        fail("cancelled", "the caller cancelled the command", {
          reason: String(options.signal.reason ?? "aborted"),
        });
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
  const { config, digest } = trustedConfigAt(
    ctx.rt,
    ctx.repo.root,
    record.trustedConfigRevision ?? record.base.sha,
  );
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
