/**
 * What the host gives the server, and the repository allowlist.
 *
 * Trust boundary: the host owns credentials, the runtime that runs repository commands, the
 * state store and the principal. A caller supplies none of them: it names an allowlisted
 * repository id, and the server resolves everything else from the host and from the
 * repository's trusted configuration (its base branch, never the working tree).
 */
import { type ComforgeConfig, type CredentialProvider, type HostPolicy, type Runtime, type StateStore } from "@comforge/cli";
import type { Principal } from "./contracts.ts";
export interface RepositoryBinding {
    /** Allowlisted id callers use. */
    id: string;
    /** Absolute path of the primary checkout. Never shown to, or taken from, a caller. */
    root: string;
    /** Git common directory; defaults to `<root>/.git`. */
    commonDir?: string;
    /** GitHub identity the trusted configuration must name. */
    owner: string;
    name: string;
}
/**
 * Host-provided isolation for repository commands over a remote transport. The host
 * attests that `runtime` runs every command inside an isolation boundary it operates
 * (container, VM, dedicated worker). A flag cannot stand in for it: without a provider,
 * executing tools are neither listed nor callable over HTTP.
 */
export interface IsolationProvider {
    /** Non-secret identifier of the isolation, recorded in audit events and capabilities. */
    readonly id: string;
    runtime(binding: RepositoryBinding, principal: Principal): Runtime;
}
export interface AuditEvent {
    tool: string;
    principal: string;
    repository: string | null;
    outcome: "ok" | "refused" | "error";
    code: string | null;
    durationMs: number;
    transport: "stdio" | "http";
}
export interface HostServices {
    /** The runtime for read-only work and, on stdio, for repository commands. */
    runtime(binding: RepositoryBinding): Runtime;
    /** Server-owned credentials; never returned to a caller. Omit to use the configuration's source. */
    credentials?(binding: RepositoryBinding, principal: Principal): CredentialProvider | undefined;
    /** Shared initiative store; omit for the CLI's default, so the CLI and the server agree. */
    state?(binding: RepositoryBinding): StateStore | undefined;
    /** Called once per tool call, with no arguments, bodies or credentials. */
    audit?(event: AuditEvent): void;
    /**
     * Trusted host policy for the lifecycle (checkout parent, worker preparation and removal,
     * validation), per repository. Host code only: no tool input reaches it.
     */
    hostPolicy?(binding: RepositoryBinding): HostPolicy | undefined;
}
/** Refuses an allowlist with duplicate or malformed ids, or relative paths. */
export declare function assertBindings(bindings: readonly RepositoryBinding[]): void;
export declare function resolveBinding(bindings: readonly RepositoryBinding[], principal: Principal, id: string): RepositoryBinding;
export declare const repositoryOf: (b: RepositoryBinding) => {
    root: string;
    commonDir: string;
};
/**
 * The configuration at the base branch's remote-tracking ref: what @comforge/cli trusts.
 * The working tree's copy is ignored. It must name the binding's repository.
 */
export declare function trustedConfig(rt: Runtime, binding: RepositoryBinding): ComforgeConfig;
