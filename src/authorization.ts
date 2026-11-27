import { createPrivateKey, createPublicKey, randomBytes, randomUUID, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  DESTRUCTIVE_COMMANDS as CORE_DESTRUCTIVE_COMMANDS,
  type Command,
  type CommandScopeEntry,
  type CommandContext as CoreCommandContext,
  createGrantProtocol,
  envelopeDigest,
  FactoryCoreError,
  type Grant,
  type GrantEnvelope,
  type GrantProtocol,
  keyIdFor,
} from "@comforge/core";
import { readSpecificationIssue } from "@comforge/github";
import { LedgerError } from "@comforge/ledger";
import { createFileLedger } from "@comforge/ledger/file";
import type { ComforgeConfig } from "./config.ts";
import type { CommandContext } from "./context.ts";
import { CliError, fail } from "./errors.ts";
import { githubError } from "./github.ts";
import { specificationProtocol } from "./protocols.ts";
import { type InitiativeRecord, nowIso, stateDir } from "./state.ts";

/**
 * Who may cause a GitHub write. Holding the CLI and a credential is not authority by itself.
 *
 * - No `security.authorization` in the trusted configuration: every write is refused
 *   (`authorization-required`). That is the default.
 * - `operator`: an explicit owner choice, merged to the base, that whoever runs the CLI with the
 *   credential decides. It is policy, not enforcement, and is reported as such.
 * - `owner-grant`: each write needs an owner-signed grant verified by the @comforge/core grant
 *   protocol against keys in the trusted configuration. The grant is bound to this repository,
 *   the ticket, its issue and unedited specification digest, the base commit, the exact commit
 *   and branch being published, and expires (at most 7 days). Each command run spends one of its
 *   `maxAttempts`; reuse past that is refused as a replay.
 *
 * The trusted configuration comes from the base revision, so candidate text cannot add a key
 * or switch the mode. Whoever holds a trusted private key can sign: keeping that key out of an
 * agent's environment is external enforcement this CLI cannot provide.
 */

export type Authorized =
  | { mode: "operator" }
  | {
      mode: "owner-grant";
      grantId: string;
      keyId: string;
      expiresAt: string;
      envelopeDigest: string;
      /** The scoped command that authorized the write; null for a scope-less publication grant. */
      scope: string | null;
    };

export function grantProtocol(config: ComforgeConfig, record: InitiativeRecord): GrantProtocol {
  const a = config.security.authorization;
  if (a?.mode !== "owner-grant")
    return fail("config-invalid", "owner-grant authorization is not configured");
  return createGrantProtocol({
    grantScheme: a.grantScheme,
    repository: `${config.repository.owner}/${config.repository.name}`,
    ticketPattern: new RegExp(config.tickets.pattern),
    // A grant names the initiative's own branch (a phase has its own).
    branchForTicket: (ticket) =>
      ticket === record.ticket
        ? record.branch
        : `${config.tickets.branchPrefix}${ticket.toLowerCase()}`,
  });
}

export async function authorizeWrites(
  ctx: CommandContext,
  trusted: ComforgeConfig,
  record: InitiativeRecord | null,
  options: {
    head: string;
    grantFile?: string;
    command: Command;
    /** False for a command with no remote write (recover): the grant is verified, no attempt is spent. */
    consume?: boolean;
    /** Cleanup: the merged pull request, as cleanup proved it. */
    pullRequest?: { number: number; headSha: string; open: boolean; merged: boolean };
  },
): Promise<Authorized> {
  const a = trusted.security.authorization;
  if (!a)
    return fail(
      "authorization-required",
      "GitHub writes are not authorized in this repository: the trusted configuration sets no security.authorization",
    );
  if (a.mode === "operator") return { mode: "operator" };
  if (!record?.specification)
    return fail(
      "authorization-required",
      "owner-grant writes need an initiative started from a published specification",
    );
  if (!options.grantFile)
    return fail("authorization-required", "this write needs --grant FILE, an owner-signed grant");
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(options.grantFile, "utf8"));
  } catch {
    return fail("usage", `${options.grantFile} is not a readable JSON grant`);
  }
  const spec = specificationProtocol(trusted);
  if (!spec) return fail("config-invalid", "owner-grant needs a specification section");
  const issue = await readSpecificationIssue(
    ctx.github(trusted).evidence,
    spec,
    record.specification.issueNumber,
  ).catch(githubError);
  let grant: Grant;
  let scope: CommandScopeEntry | null;
  try {
    // Signed command scopes (@comforge/core): a scope-less publication grant authorizes the
    // publication commands as before; cleanup needs a command grant naming the merged PR.
    const grantId = (raw as { grant?: { grantId?: unknown } } | null)?.grant?.grantId;
    ({ grant, scope } = grantProtocol(trusted, record).authorizeCommand(
      raw,
      a.trustedKeys,
      {
        command: options.command,
        ticket: record.ticket,
        specification: issue.verification,
        issue: record.specification.issueNumber,
        // Revocation is the owner's, merged to the base: candidate text cannot un-revoke.
        revoked: typeof grantId === "string" && (a.revokedGrants ?? []).includes(grantId),
        // Spent attempts are counted atomically below (reserveGrantAttempt).
        attemptsUsed: 0,
        baseSha: record.base.sha,
        candidateSha: options.head,
        branch: record.branch,
        ...(options.pullRequest ? { pullRequest: options.pullRequest } : {}),
      },
      new Date(ctx.rt.now()),
    ));
  } catch (error) {
    if (error instanceof FactoryCoreError)
      throw new CliError("unauthorized", `grant refused: ${error.message}`, {
        ...(error.detail ?? {}),
      });
    throw error;
  }
  const envelope = raw as GrantEnvelope;
  const digest = envelopeDigest(envelope);
  if (options.consume !== false)
    await reserveGrantAttempt(ctx, record.operationId, {
      grantId: grant.grantId,
      maxAttempts: grant.maxAttempts,
      envelopeDigest: digest,
      head: options.head,
      command: options.command,
      at: nowIso(ctx.rt.now()),
    });
  return {
    mode: "owner-grant",
    grantId: grant.grantId,
    keyId: envelope.keyId,
    expiresAt: grant.expiresAt,
    envelopeDigest: digest,
    scope: scope ? scope.command : null,
  };
}

/**
 * Spends one attempt of a grant, atomically. The count is checked inside the compare-and-swap of
 * the initiative's state record (a @comforge/ledger version), so independent processes racing on
 * one grant can never spend more than `maxAttempts` between them: a loser re-reads the new
 * version and is refused once the attempts are gone.
 *
 * Accounting: an attempt is spent before any remote side effect of a command run (publish,
 * complete, deliver) and is not given back. A run that dies after spending it, before or after a
 * remote write, needs another attempt to run again; its write is then answered from the write
 * ledger (idempotent), never repeated. When the attempts are gone the owner issues a new grant.
 */
/** Commands whose remote effect is destructive; they never share a grant with any other. */
export const DESTRUCTIVE_COMMANDS = new Set<string>(CORE_DESTRUCTIVE_COMMANDS);

export async function reserveGrantAttempt(
  ctx: Pick<CommandContext, "state">,
  initiative: string,
  use: {
    grantId: string;
    maxAttempts: number;
    envelopeDigest: string;
    head: string;
    command: string;
    at: string;
  },
): Promise<number> {
  let attempt = 0;
  await ctx.state.update(initiative, (r) => {
    r.grantUses ??= [];
    const used = r.grantUses.filter((u) => u.grantId === use.grantId).length;
    // Destructive cleanup is separately authorized: a grant spent on cleanup is not spent on a
    // publication, and a publication's grant does not authorize deleting the branch.
    const destructive = (command: string) => DESTRUCTIVE_COMMANDS.has(command);
    const mixed = r.grantUses.find(
      (u) => u.grantId === use.grantId && destructive(u.command) !== destructive(use.command),
    );
    if (mixed)
      throw new CliError(
        "unauthorized",
        `grant refused: it was used for ${mixed.command}; ${use.command} needs its own grant`,
        { grantId: use.grantId, usedFor: mixed.command },
      );
    if (used >= use.maxAttempts)
      throw new CliError(
        "unauthorized",
        "grant refused: its attempts are exhausted (replay refused)",
        {
          grantId: use.grantId,
          maxAttempts: use.maxAttempts,
        },
      );
    const { maxAttempts: _max, ...entry } = use;
    r.grantUses.push(entry);
    attempt = used + 1;
  });
  return attempt;
}

/** An unsigned publication grant for the initiative's current head, for the owner to review and sign. */
export function grantTemplate(
  trusted: ComforgeConfig,
  record: InitiativeRecord,
  head: string,
  now: number,
  hours: number,
  /** A command grant instead of a publication grant: cleanup of the merged pull request. */
  command?: { command: "cleanup"; pullRequest: number },
): Grant {
  const a = trusted.security.authorization;
  if (a?.mode !== "owner-grant")
    return fail("config-invalid", "owner-grant authorization is not configured");
  if (!record.specification)
    return fail("authorization-required", "the initiative has no specification to bind");
  if (!(hours > 0 && hours <= 168)) return fail("usage", "--hours must be between 1 and 168");
  return {
    schema: a.grantScheme,
    grantId: randomUUID(),
    nonce: randomBytes(16).toString("hex"),
    repository: `${trusted.repository.owner}/${trusted.repository.name}`,
    ticket: record.ticket,
    issue: record.specification.issueNumber,
    specDigest: record.specification.digest,
    mode: "publication",
    capabilities: [],
    base: { kind: "exact", sha: record.base.sha },
    maxAttempts: 3,
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + hours * 3_600_000).toISOString(),
    ...(command
      ? {
          mode: "command" as const,
          maxAttempts: 1,
          scope: {
            version: 1 as const,
            commands: [
              { command: "cleanup" as const, pullRequest: command.pullRequest, mergedHead: head },
            ],
          },
        }
      : { publication: { candidateSha: head, branch: record.branch } }),
  };
}

/**
 * Signs a grant with an Ed25519 private key. Meant for the owner's machine: the key must not be
 * readable by the agent the grant authorizes.
 */
export function signGrant(
  protocol: GrantProtocol,
  grant: unknown,
  privateKeyPem: string,
): GrantEnvelope {
  const parsed = protocol.grantSchema.safeParse(grant);
  if (!parsed.success)
    return fail("usage", "the grant does not match the grant schema", {
      issues: parsed.error.issues.slice(0, 5).map((i) => i.message),
    });
  const key = createPrivateKey(privateKeyPem);
  const publicKeyPem = createPublicKey(key).export({ type: "spki", format: "pem" }).toString();
  return {
    grant: parsed.data,
    keyId: keyIdFor(publicKeyPem),
    signature: sign(null, protocol.signingBytes(parsed.data), key).toString("base64url"),
  };
}

/**
 * Authorization of a governance write that belongs to no initiative (publishing a specification
 * or an advisory review). Operator mode decides as for any write; owner-grant mode needs a
 * command grant scoping exactly this command, verified by @comforge/core against live state the
 * caller read, and spends one of its attempts atomically in a grant-use ledger (the same
 * compare-and-swap discipline as an initiative's grant uses).
 */
export async function authorizeGovernanceWrite(
  ctx: CommandContext,
  trusted: ComforgeConfig,
  options: {
    grantFile?: string;
    context: Omit<CoreCommandContext, "revoked" | "attemptsUsed">;
  },
): Promise<Authorized> {
  const a = trusted.security.authorization;
  if (!a)
    return fail(
      "authorization-required",
      "GitHub writes are not authorized in this repository: the trusted configuration sets no security.authorization",
    );
  if (a.mode === "operator") return { mode: "operator" };
  if (!options.grantFile)
    return fail(
      "authorization-required",
      "this write needs --grant FILE, an owner-signed command grant",
    );
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(options.grantFile, "utf8"));
  } catch {
    return fail("usage", `${options.grantFile} is not a readable JSON grant`);
  }
  const protocol = governanceGrantProtocol(trusted);
  const grantId = (raw as { grant?: { grantId?: unknown } } | null)?.grant?.grantId;
  let grant: Grant;
  let scope: CommandScopeEntry | null;
  try {
    ({ grant, scope } = protocol.authorizeCommand(
      raw,
      a.trustedKeys,
      {
        ...options.context,
        revoked: typeof grantId === "string" && (a.revokedGrants ?? []).includes(grantId),
        attemptsUsed: 0,
      },
      new Date(ctx.rt.now()),
    ));
  } catch (error) {
    if (error instanceof FactoryCoreError)
      throw new CliError("unauthorized", `grant refused: ${error.message}`, {
        ...(error.detail ?? {}),
      });
    throw error;
  }
  const digest = envelopeDigest(raw as GrantEnvelope);
  await spendCommandGrant(ctx, grant, {
    command: options.context.command,
    envelopeDigest: digest,
    at: nowIso(ctx.rt.now()),
  });
  return {
    mode: "owner-grant",
    grantId: grant.grantId,
    keyId: (raw as GrantEnvelope).keyId,
    expiresAt: grant.expiresAt,
    envelopeDigest: digest,
    scope: scope ? scope.command : null,
  };
}

interface CommandGrantUses {
  operationId: string;
  version: number;
  uses: { command: string; envelopeDigest: string; at: string }[];
}

async function spendCommandGrant(
  ctx: CommandContext,
  grant: Grant,
  use: CommandGrantUses["uses"][number],
): Promise<void> {
  const ledger = createFileLedger<CommandGrantUses>({
    directory: stateDir(ctx.repo.commonDir),
    namespace: "command-grants",
    validate: (r) => {
      if (!Array.isArray((r as CommandGrantUses).uses))
        throw new LedgerError("foreign", "not a command grant use record");
    },
  });
  for (let n = 0; n < 16; n++) {
    const current = await ledger.get(grant.grantId);
    const uses = current?.uses ?? [];
    if (uses.length >= grant.maxAttempts)
      fail("unauthorized", "grant refused: its attempts are exhausted (replay refused)", {
        grantId: grant.grantId,
        maxAttempts: grant.maxAttempts,
      });
    const next: CommandGrantUses = {
      operationId: grant.grantId,
      version: (current?.version ?? 0) + 1,
      uses: [...uses, use],
    };
    if (
      current
        ? await ledger.replace(grant.grantId, current.version, next)
        : await ledger.create(next)
    )
      return;
  }
  fail("ledger", "the grant's use record is changing too fast; rerun");
}

/**
 * An unsigned command grant for one governance write, for the owner to review and sign
 * (`comforge grant sign`): the exact scope entry, digest and destination the dry run computed.
 */
export function commandGrantTemplate(
  trusted: ComforgeConfig,
  options: {
    ticket: string;
    issue: number | null;
    specDigest: string;
    scope: CommandScopeEntry;
    now: number;
    hours?: number;
  },
): Record<string, unknown> | null {
  const a = trusted.security.authorization;
  if (a?.mode !== "owner-grant") return null;
  const hours = options.hours ?? 24;
  return {
    schema: a.grantScheme,
    grantId: randomUUID(),
    nonce: randomBytes(16).toString("hex"),
    repository: `${trusted.repository.owner}/${trusted.repository.name}`,
    ticket: options.ticket,
    ...(options.issue !== null ? { issue: options.issue } : {}),
    specDigest: options.specDigest,
    mode: "command",
    capabilities: [],
    base: { kind: "origin-main" },
    maxAttempts: 1,
    issuedAt: new Date(options.now).toISOString(),
    expiresAt: new Date(options.now + hours * 3_600_000).toISOString(),
    scope: { version: 1, commands: [options.scope] },
  };
}

/** The grant protocol for writes that belong to no initiative (each ticket's default branch). */
export function governanceGrantProtocol(trusted: ComforgeConfig): GrantProtocol {
  const a = trusted.security.authorization;
  if (a?.mode !== "owner-grant")
    return fail("config-invalid", "owner-grant authorization is not configured");
  return createGrantProtocol({
    grantScheme: a.grantScheme,
    repository: `${trusted.repository.owner}/${trusted.repository.name}`,
    ticketPattern: new RegExp(trusted.tickets.pattern),
    branchForTicket: (ticket) => `${trusted.tickets.branchPrefix}${ticket.toLowerCase()}`,
  });
}
