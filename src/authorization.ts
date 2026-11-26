import { createPrivateKey, createPublicKey, randomBytes, randomUUID, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  createGrantProtocol,
  envelopeDigest,
  FactoryCoreError,
  type Grant,
  type GrantEnvelope,
  type GrantProtocol,
  keyIdFor,
} from "@comforge/core";
import { readSpecificationIssue } from "@comforge/github";
import type { ComforgeConfig } from "./config.ts";
import type { CommandContext } from "./context.ts";
import { CliError, fail } from "./errors.ts";
import { githubError } from "./github.ts";
import { specificationProtocol } from "./protocols.ts";
import { type InitiativeRecord, nowIso } from "./state.ts";

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
    command: string;
    /** False for a command with no remote write (recover): the grant is verified, no attempt is spent. */
    consume?: boolean;
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
  try {
    grant = grantProtocol(trusted, record).authorizeAction(
      raw,
      a.trustedKeys,
      {
        action: "publish",
        ticket: record.ticket,
        specification: issue.verification,
        issue: record.specification.issueNumber,
        revoked: false,
        attemptsUsed: 0,
        baseSha: record.base.sha,
        candidateSha: options.head,
        branch: record.branch,
      },
      new Date(ctx.rt.now()),
    );
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
export const DESTRUCTIVE_COMMANDS = new Set(["cleanup"]);

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
    publication: { candidateSha: head, branch: record.branch },
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
