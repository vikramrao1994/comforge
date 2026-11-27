import { type ComforgeConfig } from "./config.ts";
import { type Runtime } from "./runtime.ts";
export interface Repository {
    /** The primary checkout's top-level directory. */
    root: string;
    /** The Git common directory (shared by every clone's state lookups from this checkout). */
    commonDir: string;
}
export declare function locateRepository(rt: Runtime, cwd?: string): Repository;
export declare const sha256: (text: string) => string;
/** The trusted configuration: the committed file at `revision`, never the working tree. */
export declare function trustedConfigAt(rt: Runtime, root: string, revision: string): {
    config: ComforgeConfig;
    digest: string;
};
/**
 * Refuses publication of a candidate whose working configuration changes a trusted section:
 * repository text cannot grant itself a target, capability, credential, validation or
 * namespace. Returns the candidate's own configuration for its untrusted settings.
 */
export declare function requireTrustedUnchanged(trusted: ComforgeConfig, checkout: string): ComforgeConfig;
export interface Initiative {
    /** `TICKET` or `TICKET.phase`. */
    id: string;
    ticket: string;
    phase: string | null;
    branch: string;
}
export declare function parseInitiative(id: string, config: ComforgeConfig): Initiative;
/** The initiative a branch belongs to, or null for any other branch. */
export declare function initiativeFromBranch(branch: string, config: ComforgeConfig): Initiative | null;
export declare function checkoutParent(config: ComforgeConfig, root: string): string;
export declare const checkoutDir: (config: ComforgeConfig, root: string, initiative: Initiative) => string;
/** Fetches `<remote>/<baseBranch>` into the primary and returns its commit. */
export declare function fetchBase(rt: Runtime, root: string, config: ComforgeConfig): string;
/**
 * The trusted base and its configuration. The working configuration only names where the base
 * is (remote and branch); the configuration committed there must name the same place, so an edit
 * of the working file cannot point the CLI at another branch's policy (review authors, readable
 * artifacts, capabilities). Every command that reads trusted policy goes through here.
 */
export declare function trustedBase(rt: Runtime, root: string, working: ComforgeConfig): {
    base: string;
    config: ComforgeConfig;
    digest: string;
};
export declare const repositorySlug: (config: ComforgeConfig) => string;
