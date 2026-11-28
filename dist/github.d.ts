import { type GitHubEvidence, type GitHubTransport, type OperationRecord, type WriteOperation, type WriteOutcome } from "@comforge/github";
import type { Ledger } from "@comforge/ledger";
import { type ComforgeConfig } from "./config.ts";
import { type Runtime } from "./runtime.ts";
/**
 * GitHub access for one command.
 *
 * - Credential: from where the trusted configuration says (an environment variable or the
 *   `gh` login), read on first use, held in memory only, never written, logged or passed to a
 *   child process.
 * - Reads: the @comforge/github evidence client and its transport.
 * - Writes: a @comforge/github writer with the configured capabilities, the
 *   @comforge/ledger file ledger and an authorization bound to the one descriptor the
 *   command prepared. Each write is idempotent per operation id across runs and processes.
 * - Host adapter (audited, the only non-SDK GitHub call): assigning a pull request, which the
 *   SDK does not offer, through `gh pr edit --add-assignee`. It uses gh's own login.
 */
export interface GitHubAccess {
    readonly repository: string;
    evidence: GitHubEvidence;
    transport: GitHubTransport;
    /** The login the credential acts as. */
    login(): Promise<string>;
    /** Sends exactly `operation`; nothing else can be authorized with this call. */
    write(operation: WriteOperation): Promise<WriteOutcome>;
    reconcile(operationId: string): Promise<WriteOutcome>;
    abandon(operationId: string, reason: string): Promise<void>;
    /** The write ledger (read-only use by `recover`, `status` and the write guards). */
    ledger: Ledger<OperationRecord>;
}
export declare function githubError(error: unknown): never;
export declare function openGitHub(rt: Runtime, config: ComforgeConfig, commonDir: string, provider?: (config: ComforgeConfig) => string, ledgerFactory?: (config: ComforgeConfig) => Ledger<OperationRecord>): GitHubAccess;
export interface GitHubAccessOptions {
    /** The trusted configuration: repository, API origin, capabilities, marker namespace. */
    config: ComforgeConfig;
    /** Server-owned; held in memory only. */
    token: () => string;
    ledger: Ledger<OperationRecord>;
    now: () => number;
    fetchImpl?: typeof fetch;
    /** The writer's correlation-marker namespace; default `security.markerNamespace`. */
    markerNamespace?: string;
    /**
     * The login the token acts as, when the host knows it (0.6.1). A GitHub App installation token
     * cannot read `GET /user`, so a host writing as an App names its `<slug>[bot]` login here;
     * without it the login is read from GitHub.
     */
    login?: string;
}
/**
 * GitHub access from a credential and a write ledger alone (0.6.0): what `openGitHub` builds for a
 * checkout, for a host that has no checkout and supplies both itself.
 */
export declare function createGitHubAccess(options: GitHubAccessOptions): GitHubAccess;
/** The audited host adapter: assignment through `gh`, which the SDK does not offer. */
export declare function assignWithGh(rt: Runtime, config: ComforgeConfig, prNumber: number, login: string): {
    assigned: boolean;
    detail: string;
};
/** The write ledger's directory: `comforge/`, or an earlier lifecycle's shared one (`state`). */
export declare const writeLedgerDir: (commonDir: string, config: ComforgeConfig) => string;
export declare const ledgerLocation: (commonDir: string, config: ComforgeConfig) => string;
