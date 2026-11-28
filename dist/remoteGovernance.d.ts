import type { OperationRecord } from "@comforge/github";
import type { Ledger } from "@comforge/ledger";
import { governanceCommands } from "./commands/governance.ts";
import type { ComforgeConfig } from "./config.ts";
import { type ServiceResult } from "./services.ts";
/**
 * Governance without a checkout (0.6.0): specification, advisory-review and discussion-comment
 * publication for a host that serves a repository it has no clone of (a web application).
 *
 * The host supplies everything a caller must never supply: the trusted configuration (already
 * verified byte-for-byte against GitHub at a revision), the write credential, the durable write
 * ledger and its own authorization policy. The commands are the CLI's own, so the records, the
 * reconciliation before every write and the read-back are identical.
 *
 * Authorization is never weaker than the repository's:
 * - no `security.authorization`: every write is refused;
 * - `owner-grant`: refused here — a command grant is spent in checkout state this host does not
 *   have, so an owner-grant repository publishes only through a checkout-backed host;
 * - `operator`: the host's `authorize` decides for the authenticated principal, once per write,
 *   and the result records `{ mode: "host", authority, principal }`.
 */
export interface RemoteAuthorizationRequest {
    command: "publish-specification" | "publish-review" | "publish-comment";
    repository: string;
    principal: string;
    /** The bindings the write is checked against (ticket, issue, digests, pull request, head). */
    context: Record<string, unknown>;
}
export type RemoteAuthorizationDecision = {
    allow: true;
    authority: string;
} | {
    allow: false;
    reason: string;
};
export interface RemoteGovernanceOptions {
    /** The trusted configuration the host verified against GitHub. */
    config: ComforgeConfig;
    /** The authenticated principal the host acts for; recorded, never trusted for policy here. */
    principal: string;
    /** The write credential for this repository. Never stored, logged or returned. */
    token: () => string;
    /** The durable write ledger (for example `sqliteOperationStore`); one namespace per repository. */
    ledger: Ledger<OperationRecord>;
    authorize(request: RemoteAuthorizationRequest): RemoteAuthorizationDecision | Promise<RemoteAuthorizationDecision>;
    now?: () => number;
    fetchImpl?: typeof fetch;
    signal?: AbortSignal;
    /** The writer's correlation-marker namespace; default `security.markerNamespace`. */
    markerNamespace?: string;
    /**
     * The login `token` acts as (0.6.1): required for a GitHub App installation token, which cannot
     * read `GET /user`. Reconciliation trusts only markers by this login, and an advisory review of
     * a pull request this login opened is refused.
     */
    identity?: string;
}
type Options<K extends keyof typeof governanceCommands> = Parameters<(typeof governanceCommands)[K]>[1];
export interface RemoteGovernance {
    publishSpecification(options: Omit<Options<"publishSpecification">, "grantFile">): Promise<ServiceResult<Record<string, unknown>>>;
    publishReview(options: Omit<Options<"publishReview">, "grantFile">): Promise<ServiceResult<Record<string, unknown>>>;
    publishComment(options: Omit<Options<"publishComment">, "grantFile">): Promise<ServiceResult<Record<string, unknown>>>;
}
export declare function createRemoteGovernance(options: RemoteGovernanceOptions): RemoteGovernance;
export {};
