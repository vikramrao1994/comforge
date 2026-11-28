import type { OperationRecord } from "@comforge/github";
import type { Ledger } from "@comforge/ledger";
import type { Authorized } from "./authorization.ts";
import {
  type AuthorizationRequest,
  discussionAuthorization,
  type GovernanceContext,
  governanceCommands,
} from "./commands/governance.ts";
import type { CommandResult } from "./commands/lifecycle.ts";
import type { ComforgeConfig } from "./config.ts";
import { fail } from "./errors.ts";
import { createGitHubAccess, type GitHubAccess } from "./github.ts";
import { type ServiceResult, toServiceError } from "./services.ts";

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

export type RemoteAuthorizationDecision =
  | { allow: true; authority: string }
  | { allow: false; reason: string };

export interface RemoteGovernanceOptions {
  /** The trusted configuration the host verified against GitHub. */
  config: ComforgeConfig;
  /** The authenticated principal the host acts for; recorded, never trusted for policy here. */
  principal: string;
  /** The write credential for this repository. Never stored, logged or returned. */
  token: () => string;
  /** The durable write ledger (for example `sqliteOperationStore`); one namespace per repository. */
  ledger: Ledger<OperationRecord>;
  authorize(
    request: RemoteAuthorizationRequest,
  ): RemoteAuthorizationDecision | Promise<RemoteAuthorizationDecision>;
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

type Options<K extends keyof typeof governanceCommands> = Parameters<
  (typeof governanceCommands)[K]
>[1];

export interface RemoteGovernance {
  publishSpecification(
    options: Omit<Options<"publishSpecification">, "grantFile">,
  ): Promise<ServiceResult<Record<string, unknown>>>;
  publishReview(
    options: Omit<Options<"publishReview">, "grantFile">,
  ): Promise<ServiceResult<Record<string, unknown>>>;
  publishComment(
    options: Omit<Options<"publishComment">, "grantFile">,
  ): Promise<ServiceResult<Record<string, unknown>>>;
}

export function createRemoteGovernance(options: RemoteGovernanceOptions): RemoteGovernance {
  const now = options.now ?? Date.now;
  const repository = `${options.config.repository.owner}/${options.config.repository.name}`;
  let access: GitHubAccess | null = null;
  const context: GovernanceContext = {
    trusted: () => options.config,
    github: (trusted) => {
      if (trusted !== options.config) fail("config-invalid", "one trusted configuration per host");
      access ??= createGitHubAccess({
        config: trusted,
        token: options.token,
        ledger: options.ledger,
        now,
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        ...(options.markerNamespace ? { markerNamespace: options.markerNamespace } : {}),
        ...(options.identity !== undefined ? { login: options.identity } : {}),
      });
      return access;
    },
    authorize: (trusted, request) => hostAuthorization(trusted, request),
    now,
    checkpoint: () => {
      if (options.signal?.aborted)
        fail("cancelled", "the caller cancelled the command", {
          reason: String(options.signal.reason ?? "aborted"),
        });
    },
  };

  async function hostAuthorization(
    trusted: ComforgeConfig,
    request: AuthorizationRequest,
  ): Promise<Authorized> {
    // Same refusals as a checkout for an absent authorization; owner-grant needs a checkout.
    if (request.context.command === "publish-comment") discussionAuthorization(trusted);
    const a = trusted.security.authorization;
    if (!a)
      return fail(
        "authorization-required",
        "GitHub writes are not authorized in this repository: the trusted configuration sets no security.authorization",
      );
    if (a.mode !== "operator")
      return fail(
        "authorization-required",
        "this repository authorizes writes with owner grants, which only a checkout-backed host can spend",
      );
    if (request.grantFile !== undefined)
      return fail("usage", "a checkout-free host takes no grant file");
    let decision: RemoteAuthorizationDecision;
    try {
      decision = await options.authorize({
        command: request.context.command as RemoteAuthorizationRequest["command"],
        repository,
        principal: options.principal,
        context: { ...request.context },
      });
    } catch {
      return fail("unauthorized", "the host's authorization failed");
    }
    if (!decision || decision.allow !== true || typeof decision.authority !== "string")
      return fail(
        "unauthorized",
        decision && decision.allow === false && typeof decision.reason === "string"
          ? `the host refused this write: ${decision.reason.slice(0, 200)}`
          : "the host refused this write",
      );
    return { mode: "host", authority: decision.authority, principal: options.principal };
  }

  const call =
    <K extends "publishSpecification" | "publishReview" | "publishComment">(name: K) =>
    async (o: Omit<Options<K>, "grantFile">): Promise<ServiceResult<Record<string, unknown>>> => {
      try {
        // Stripped at run time too: a JavaScript caller is not held by the types.
        const { grantFile: _g, authorized: _a, ...safe } = o as Record<string, unknown>;
        const command = governanceCommands[name] as (
          ctx: GovernanceContext,
          options: unknown,
        ) => Promise<CommandResult>;
        const { result, exit = 0 } = await command(context, safe);
        return { ok: true, value: result as Record<string, unknown>, exit } as ServiceResult<
          Record<string, unknown>
        >;
      } catch (error) {
        return { ok: false, error: toServiceError(error) };
      }
    };
  return {
    publishSpecification: call("publishSpecification"),
    publishReview: call("publishReview"),
    publishComment: call("publishComment"),
  };
}
