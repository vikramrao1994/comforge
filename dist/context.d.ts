import { type ComforgeConfig } from "./config.ts";
import { type GitHubAccess } from "./github.ts";
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
}
export declare function openContext(rt: Runtime): CommandContext;
/** An initiative's record and the trusted configuration it started from. */
export declare function loadInitiative(ctx: CommandContext, id: string): Promise<{
    record: InitiativeRecord;
    trusted: ComforgeConfig;
}>;
export declare function requireCheckout(record: InitiativeRecord): string;
