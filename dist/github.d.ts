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
/** The audited host adapter: assignment through `gh`, which the SDK does not offer. */
export declare function assignWithGh(rt: Runtime, config: ComforgeConfig, prNumber: number, login: string): {
    assigned: boolean;
    detail: string;
};
/** The write ledger's directory: `comforge/`, or an earlier lifecycle's shared one (`state`). */
export declare const writeLedgerDir: (commonDir: string, config: ComforgeConfig) => string;
export declare const ledgerLocation: (commonDir: string, config: ComforgeConfig) => string;
