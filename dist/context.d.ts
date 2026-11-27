import type { OperationRecord } from "@comforge/github";
import type { Ledger } from "@comforge/ledger";
import { type ComforgeConfig } from "./config.ts";
import { type GitHubAccess } from "./github.ts";
import { type HostPolicy, type ResolvedHost } from "./host.ts";
import { type Repository } from "./repository.ts";
import type { Runtime } from "./runtime.ts";
import { type InitiativeRecord, type StateStore } from "./state.ts";
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
    /** The embedder's trusted host policy (defaults when none: the trusted configuration decides). */
    host: ResolvedHost;
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
    /** Trusted host policy of an embedding supervisor (see host.ts); never from a tool input. */
    host?: HostPolicy;
}
export declare function openContext(rt: Runtime, options?: ContextOptions): CommandContext;
/** An initiative's record and the trusted configuration it started from. */
export declare function loadInitiative(ctx: CommandContext, id: string): Promise<{
    record: InitiativeRecord;
    trusted: ComforgeConfig;
}>;
export declare function requireCheckout(record: InitiativeRecord): string;
