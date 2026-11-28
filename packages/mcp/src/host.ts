/**
 * What the host gives the server, and the repository allowlist.
 *
 * Trust boundary: the host owns credentials, the runtime that runs repository commands, the
 * state store and the principal. A caller supplies none of them: it names an allowlisted
 * repository id, and the server resolves everything else from the host and from the
 * repository's trusted configuration (its base branch, never the working tree).
 */
import { createHash } from "node:crypto";
import {
  type ComforgeConfig,
  type CredentialProvider,
  type HostPolicy,
  parseConfig,
  type RemoteAuthorizationDecision,
  type RemoteAuthorizationRequest,
  type Runtime,
  type StateStore,
} from "@comforge/cli";
import type { OperationLedger } from "@comforge/github";
import type { Principal } from "./contracts.ts";
import { ToolRefusal } from "./results.ts";

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

const ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** Refuses an allowlist with duplicate or malformed ids, or relative paths. */
export function assertBindings(bindings: readonly RepositoryBinding[]): void {
  const seen = new Set<string>();
  for (const b of bindings) {
    if (!ID.test(b.id)) throw new Error(`repository id ${JSON.stringify(b.id)} is malformed`);
    if (seen.has(b.id)) throw new Error(`repository id ${b.id} is listed twice`);
    seen.add(b.id);
    if (!b.root.startsWith("/")) throw new Error(`repository ${b.id}: root must be absolute`);
    if (b.commonDir && !b.commonDir.startsWith("/"))
      throw new Error(`repository ${b.id}: commonDir must be absolute`);
  }
}

export function resolveBinding(
  bindings: readonly RepositoryBinding[],
  principal: Principal,
  id: string,
): RepositoryBinding {
  const binding = bindings.find((b) => b.id === id);
  const allowed = principal.repositories === "*" || principal.repositories.includes(id);
  // The same refusal whether the id is unknown or not the principal's: no allowlist probing.
  if (!binding || !allowed)
    throw new ToolRefusal("unknown-repository", `no repository ${id} for this principal`, 1, {
      repository: id,
    });
  return binding;
}

export const repositoryOf = (b: RepositoryBinding) => ({
  root: b.root,
  commonDir: b.commonDir ?? `${b.root}/.git`,
});

/**
 * The configuration at the base branch's remote-tracking ref: what @comforge/cli trusts.
 * The working tree's copy is ignored. It must name the binding's repository.
 */
export function trustedConfig(rt: Runtime, binding: RepositoryBinding): ComforgeConfig {
  const read = (ref: string) =>
    rt.run("git", ["show", `${ref}:comforge.config.json`], {
      cwd: binding.root,
      timeoutMs: 15_000,
    });
  // The base branch comes from the committed configuration itself, read at origin's HEAD
  // first; a repository without one is refused like the CLI refuses it.
  let r = read("refs/remotes/origin/HEAD");
  if (r.status !== 0) r = read("refs/remotes/origin/main");
  if (r.status !== 0)
    throw new ToolRefusal(
      "config-missing",
      "the repository has no trusted comforge.config.json",
      2,
      {
        repository: binding.id,
      },
    );
  let config: ComforgeConfig;
  try {
    config = parseConfig(r.stdout, "comforge.config.json");
  } catch (error) {
    throw new ToolRefusal("config-invalid", "the trusted comforge.config.json is invalid", 2, {
      repository: binding.id,
      reason: error instanceof Error ? error.message.slice(0, 500) : "invalid",
    });
  }
  const base = `refs/remotes/${config.repository.remote}/${config.repository.baseBranch}`;
  const atBase = read(base);
  if (atBase.status === 0 && atBase.stdout !== r.stdout)
    config = parseConfig(atBase.stdout, "comforge.config.json");
  if (config.repository.owner !== binding.owner || config.repository.name !== binding.name)
    throw new ToolRefusal(
      "repository-mismatch",
      "the trusted configuration names another repository",
      1,
      {
        repository: binding.id,
      },
    );
  return config;
}

// --- repositories without a checkout (0.2.0) ---------------------------------------------------

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
export type RemoteGovernanceCommand =
  | "publish-specification"
  | "publish-review"
  | "publish-comment";

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
  authorize(
    request: RemoteAuthorizationRequest,
  ): RemoteAuthorizationDecision | Promise<RemoteAuthorizationDecision>;
  /** The writer's correlation-marker namespace; default the configuration's `security.markerNamespace`. */
  markerNamespace?: string;
}

export interface RemoteHost {
  trustedConfig(
    binding: RemoteRepositoryBinding,
  ): TrustedConfigSnapshot | Promise<TrustedConfigSnapshot>;
  /** Server-owned GitHub token for the binding; never returned to a caller. */
  credentials(binding: RemoteRepositoryBinding, principal: Principal): string | undefined;
  /**
   * 0.4.0: governed publication for this binding and principal, or undefined (reads only). Asked
   * per call, so the answer may depend on the principal's grants.
   */
  governance?(
    binding: RemoteRepositoryBinding,
    principal: Principal,
  ): RemoteGovernanceHost | undefined;
  /** Oldest snapshot accepted; default 10 minutes. */
  configMaxAgeMs?: number;
  fetchImpl?: typeof fetch;
  now?(): number;
}

const SHA40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;

/** Refuses malformed remote bindings, and an id used by a local and a remote binding alike. */
export function assertRemoteBindings(
  remote: readonly RemoteRepositoryBinding[],
  local: readonly RepositoryBinding[],
): void {
  const seen = new Set(local.map((b) => b.id));
  for (const b of remote) {
    if (!ID.test(b.id)) throw new Error(`repository id ${JSON.stringify(b.id)} is malformed`);
    if (seen.has(b.id)) throw new Error(`repository id ${b.id} is listed twice`);
    seen.add(b.id);
    if (!/^[A-Za-z0-9_.-]{1,100}$/.test(b.owner) || !/^[A-Za-z0-9_.-]{1,100}$/.test(b.name))
      throw new Error(`repository ${b.id}: owner and name must be GitHub names`);
    if (b.configSha256 !== undefined && !HEX64.test(b.configSha256))
      throw new Error(`repository ${b.id}: configSha256 must be 64 lowercase hex characters`);
  }
}

export function resolveRemoteBinding(
  remote: readonly RemoteRepositoryBinding[],
  principal: Principal,
  id: string,
): RemoteRepositoryBinding | null {
  const binding = remote.find((b) => b.id === id);
  const allowed = principal.repositories === "*" || principal.repositories.includes(id);
  return binding && allowed ? binding : null;
}

/** The snapshot's own checks: revision shape, age, pin, parse and repository identity. */
export function checkSnapshot(
  binding: RemoteRepositoryBinding,
  snapshot: TrustedConfigSnapshot,
  now: number,
  maxAgeMs: number,
): ComforgeConfig {
  const detail = { repository: binding.id };
  if (!snapshot || typeof snapshot.text !== "string" || typeof snapshot.revision !== "string")
    throw new ToolRefusal(
      "config-missing",
      "the host supplied no trusted configuration",
      2,
      detail,
    );
  if (!SHA40.test(snapshot.revision))
    throw new ToolRefusal(
      "config-invalid",
      "the trusted revision is not a full commit SHA",
      2,
      detail,
    );
  if (
    !Number.isFinite(snapshot.observedAt) ||
    snapshot.observedAt > now + 60_000 ||
    now - snapshot.observedAt > maxAgeMs
  )
    throw new ToolRefusal("config-stale", "the trusted configuration snapshot is too old", 3, {
      ...detail,
      maxAgeMs,
    });
  if (binding.configSha256 !== undefined && sha256(snapshot.text) !== binding.configSha256)
    throw new ToolRefusal(
      "config-mismatch",
      "the trusted configuration is not the pinned one",
      2,
      detail,
    );
  let config: ComforgeConfig;
  try {
    config = parseConfig(snapshot.text, "comforge.config.json");
  } catch (error) {
    throw new ToolRefusal("config-invalid", "the trusted comforge.config.json is invalid", 2, {
      ...detail,
      reason: error instanceof Error ? error.message.slice(0, 500) : "invalid",
    });
  }
  if (config.repository.owner !== binding.owner || config.repository.name !== binding.name)
    throw new ToolRefusal(
      "repository-mismatch",
      "the trusted configuration names another repository",
      1,
      detail,
    );
  return config;
}

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
