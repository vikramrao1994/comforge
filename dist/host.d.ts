import { type ComforgeConfig, type CredentialProvider, type HostPolicy, type RemoteAuthorizationDecision, type RemoteAuthorizationRequest, type Runtime, type StateStore } from "@comforge/cli";
import type { OperationLedger } from "@comforge/github";
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
/**
 * An allowlisted repository the host serves without a local checkout: GitHub evidence reads
 * only (issue, pull request, pull requests, comments, advisory reviews, artifacts). Lifecycle,
 * state and executing tools are refused for it (`checkout-required`): they need a checkout and,
 * remotely, isolation, which loading a configuration never provides.
 */
export interface RemoteRepositoryBinding {
    id: string;
    owner: string;
    name: string;
    /**
     * sha256 (hex) of the trusted `comforge.config.json` bytes the host pins. When set, any other
     * configuration is refused (`config-mismatch`), even one committed at the base.
     */
    configSha256?: string;
}
/** The trusted configuration as the host observed it: bytes at one immutable base revision. */
export interface TrustedConfigSnapshot {
    /** Full 40-hex commit of the base branch the host trusts. */
    revision: string;
    /** The exact `comforge.config.json` text at `revision`. */
    text: string;
    /** When the host observed `revision` as the base head (ms since epoch). */
    observedAt: number;
}
/**
 * Host code for checkout-free repositories. The server never takes a configuration, revision,
 * URL or credential from a caller: the host supplies them, and the server checks the snapshot
 * against GitHub (the same bytes at that revision), its pin, its age and its repository.
 */
/** A governance write a checkout-free host is asked to approve (0.4.0). */
export type RemoteGovernanceCommand = "publish-specification" | "publish-review" | "publish-comment";
/**
 * Checkout-free governed publication for one repository (0.4.0): the host's write credential,
 * durable write ledger and authorization policy. Present only where the host opts in; without it
 * the repository serves evidence reads only, as in 0.2.0.
 */
export interface RemoteGovernanceHost {
    /**
     * The write credential for one command, or undefined to refuse it. Kept apart from the read
     * credential, and per command, so a host can hold a review credential that cannot open issues.
     */
    credentials(command: RemoteGovernanceCommand): string | undefined;
    /** Durable, shared across processes and restarts (for example `sqliteOperationStore`). */
    operations: OperationLedger;
    /**
     * The host's decision for one exact write, after every protocol check passed and before
     * anything is sent: scopes, feature switches, rate limits. Never bypasses the repository's
     * own authorization: owner-grant repositories are refused without a checkout.
     */
    authorize(request: RemoteAuthorizationRequest): RemoteAuthorizationDecision | Promise<RemoteAuthorizationDecision>;
    /** The writer's correlation-marker namespace; default the configuration's `security.markerNamespace`. */
    markerNamespace?: string;
}
export interface RemoteHost {
    trustedConfig(binding: RemoteRepositoryBinding): TrustedConfigSnapshot | Promise<TrustedConfigSnapshot>;
    /** Server-owned GitHub token for the binding; never returned to a caller. */
    credentials(binding: RemoteRepositoryBinding, principal: Principal): string | undefined;
    /**
     * 0.4.0: governed publication for this binding and principal, or undefined (reads only). Asked
     * per call, so the answer may depend on the principal's grants.
     */
    governance?(binding: RemoteRepositoryBinding, principal: Principal): RemoteGovernanceHost | undefined;
    /** Oldest snapshot accepted; default 10 minutes. */
    configMaxAgeMs?: number;
    fetchImpl?: typeof fetch;
    now?(): number;
}
/** Refuses malformed remote bindings, and an id used by a local and a remote binding alike. */
export declare function assertRemoteBindings(remote: readonly RemoteRepositoryBinding[], local: readonly RepositoryBinding[]): void;
export declare function resolveRemoteBinding(remote: readonly RemoteRepositoryBinding[], principal: Principal, id: string): RemoteRepositoryBinding | null;
/** The snapshot's own checks: revision shape, age, pin, parse and repository identity. */
export declare function checkSnapshot(binding: RemoteRepositoryBinding, snapshot: TrustedConfigSnapshot, now: number, maxAgeMs: number): ComforgeConfig;
