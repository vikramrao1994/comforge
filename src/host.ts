/**
 * What the host gives the server, and the repository allowlist.
 *
 * Trust boundary: the host owns credentials, the runtime that runs repository commands, the
 * state store and the principal. A caller supplies none of them: it names an allowlisted
 * repository id, and the server resolves everything else from the host and from the
 * repository's trusted configuration (its base branch, never the working tree).
 */
import {
  type ComforgeConfig,
  type CredentialProvider,
  type HostPolicy,
  parseConfig,
  type Runtime,
  type StateStore,
} from "@comforge/cli";
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
