import { createHash } from "node:crypto";
import path from "node:path";
import {
  CONFIG_FILE,
  type ComforgeConfig,
  parseConfig,
  readWorkingConfig,
  trustedChanges,
  trustedPart,
} from "./config.ts";
import { CliError, fail } from "./errors.ts";
import { canonical } from "./json.ts";
import { git, gitRun, type Runtime } from "./runtime.ts";

export interface Repository {
  /** The primary checkout's top-level directory. */
  root: string;
  /** The Git common directory (shared by every clone's state lookups from this checkout). */
  commonDir: string;
}

export function locateRepository(rt: Runtime, cwd = rt.cwd): Repository {
  const r = gitRun(rt, cwd, ["rev-parse", "--show-toplevel", "--git-common-dir"]);
  if (r.status !== 0) fail("usage", `${cwd} is not inside a Git repository`, { cwd });
  const [root, common] = r.stdout.trim().split("\n") as [string, string];
  return { root, commonDir: path.resolve(cwd, common) };
}

export const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** The trusted configuration: the committed file at `revision`, never the working tree. */
export function trustedConfigAt(
  rt: Runtime,
  root: string,
  revision: string,
): { config: ComforgeConfig; digest: string } {
  const r = gitRun(rt, root, ["show", `${revision}:${CONFIG_FILE}`]);
  if (r.status !== 0)
    throw new CliError(
      "config-missing",
      `${CONFIG_FILE} is not committed at ${revision}; the owner merges it first (comforge init writes it)`,
      { revision },
    );
  const config = parseConfig(r.stdout, `${CONFIG_FILE} at ${revision.slice(0, 12)}`);
  return { config, digest: sha256(canonical(trustedPart(config))) };
}

/**
 * Refuses publication of a candidate whose working configuration changes a trusted section:
 * repository text cannot grant itself a target, capability, credential, validation or
 * namespace. Returns the candidate's own configuration for its untrusted settings.
 */
export function requireTrustedUnchanged(trusted: ComforgeConfig, checkout: string): ComforgeConfig {
  let candidate: ComforgeConfig;
  try {
    candidate = readWorkingConfig(checkout);
  } catch (error) {
    if (error instanceof CliError && error.code === "config-missing")
      fail("untrusted-config-change", `the candidate removed ${CONFIG_FILE}`);
    if (error instanceof CliError && error.code === "config-invalid")
      fail("untrusted-config-change", `the candidate's ${CONFIG_FILE} is invalid`, error.detail);
    throw error;
  }
  const changed = trustedChanges(trusted, candidate);
  if (changed.length > 0)
    fail(
      "untrusted-config-change",
      "the candidate changes trusted configuration; the owner merges such a change outside this initiative",
      { sections: changed },
    );
  return candidate;
}

// --- initiatives ------------------------------------------------------------------------

export interface Initiative {
  /** `TICKET` or `TICKET.phase`. */
  id: string;
  ticket: string;
  phase: string | null;
  branch: string;
}

const PHASE = /^[a-z0-9][a-z0-9-]{0,31}$/;

export function parseInitiative(id: string, config: ComforgeConfig): Initiative {
  const dot = id.indexOf(".");
  const ticket = dot < 0 ? id : id.slice(0, dot);
  const phase = dot < 0 ? null : id.slice(dot + 1);
  if (!new RegExp(config.tickets.pattern).test(ticket) || ticket.length > 80)
    fail("usage", `${ticket} is not a ticket id (${config.tickets.pattern})`, { ticket });
  if (phase !== null && !PHASE.test(phase))
    fail("usage", `${phase} is not a phase name ([a-z0-9-], at most 32)`, { phase });
  const branch = `${config.tickets.branchPrefix}${ticket.toLowerCase()}${phase ? `.${phase}` : ""}`;
  return { id, ticket, phase, branch };
}

/** The initiative a branch belongs to, or null for any other branch. */
export function initiativeFromBranch(branch: string, config: ComforgeConfig): Initiative | null {
  if (!branch.startsWith(config.tickets.branchPrefix)) return null;
  const rest = branch.slice(config.tickets.branchPrefix.length);
  const dot = rest.indexOf(".");
  const ticket = (dot < 0 ? rest : rest.slice(0, dot)).toUpperCase();
  const phase = dot < 0 ? null : rest.slice(dot + 1);
  try {
    const parsed = parseInitiative(phase ? `${ticket}.${phase}` : ticket, config);
    return parsed.branch === branch ? parsed : null;
  } catch {
    return null;
  }
}

export function checkoutParent(config: ComforgeConfig, root: string): string {
  return path.resolve(root, config.checkout.parent ?? `../${path.basename(root)}-agents`);
}

export const checkoutDir = (config: ComforgeConfig, root: string, initiative: Initiative) =>
  path.join(checkoutParent(config, root), initiative.id.toLowerCase());

/** Fetches `<remote>/<baseBranch>` into the primary and returns its commit. */
export function fetchBase(rt: Runtime, root: string, config: ComforgeConfig): string {
  const { remote, baseBranch } = config.repository;
  git(rt, root, [
    "fetch",
    "--quiet",
    remote,
    `+refs/heads/${baseBranch}:refs/remotes/${remote}/${baseBranch}`,
  ]);
  return git(rt, root, ["rev-parse", "--verify", `refs/remotes/${remote}/${baseBranch}^{commit}`]);
}

export const repositorySlug = (config: ComforgeConfig) =>
  `${config.repository.owner}/${config.repository.name}`;
