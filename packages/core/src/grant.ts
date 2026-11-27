import { Buffer } from "node:buffer";
import { createHash, createPublicKey, verify } from "node:crypto";
import { z } from "zod";
import {
  ACTION_MODES,
  CAPABILITIES,
  type Capability,
  COMMAND_SCOPE_VERSION,
  COMMANDS,
  type Command,
  GRANT_MODES,
  type GrantMode,
  PROHIBITED_MODES,
  PUBLICATION_COMMANDS,
  type RuntimeAction,
  SCOPED_ONLY_COMMANDS,
} from "./authorization.ts";
import { canonicalJson, keyIdFor } from "./canonical.ts";
import { FactoryCoreError } from "./errors.ts";

/**
 * Verification of owner-signed authorization grants. Pure: no I/O, no environment,
 * no clock (the caller passes `now`), no private key and no randomness. Issuing and
 * signing a grant, holding the trusted public keys, counting attempts and recording
 * revocations stay with the trusted caller.
 *
 * A grant is canonical JSON signed with an owner Ed25519 key over
 * `<grantScheme>\n<canonical JSON>`. A label, comment, review marker, model statement
 * or MCP call is never a grant, and a valid signature alone authorizes nothing:
 * `authorizeAction` also binds the repository, ticket, issue, specification digest,
 * mode, base, attempts, candidate commit, branch and review to live state the
 * caller has verified.
 */

/** A grant longer than this is refused: authorization is for one bounded piece of work. */
export const MAX_GRANT_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
/** Tolerated clock skew between the owner's signing machine and the verifier. */
export const CLOCK_SKEW_MS = 5 * 60 * 1000;

const Sha40 = z.string().regex(/^[0-9a-f]{40}$/);
const Sha64 = z.string().regex(/^[0-9a-f]{64}$/);
const IsoTime = z.string().datetime({ offset: true });
const Positive = z.number().int().positive();

/**
 * One scoped command. Each scoped-only command carries the bindings it is checked against:
 * cleanup names the merged pull request and the head that merged; a specification publication
 * names whether it creates a new issue or replaces one; a review publication names the pull
 * request and the exact head that was reviewed (and optionally the review's digest).
 */
const CommandScopeEntrySchema = z.discriminatedUnion("command", [
  z.object({ command: z.literal("publish") }).strict(),
  z.object({ command: z.literal("complete") }).strict(),
  z.object({ command: z.literal("deliver") }).strict(),
  z.object({ command: z.literal("recover") }).strict(),
  z.object({ command: z.literal("cleanup"), pullRequest: Positive, mergedHead: Sha40 }).strict(),
  z
    .object({
      command: z.literal("publish-specification"),
      target: z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("new") }).strict(),
        z.object({ kind: z.literal("issue"), number: Positive }).strict(),
      ]),
    })
    .strict(),
  z
    .object({
      command: z.literal("publish-review"),
      pullRequest: Positive,
      reviewedHead: Sha40,
      reviewDigest: Sha64.optional(),
    })
    .strict(),
]);
export type CommandScopeEntry = z.infer<typeof CommandScopeEntrySchema>;

const CommandScopeSchema = z
  .object({
    version: z.literal(COMMAND_SCOPE_VERSION),
    commands: z.array(CommandScopeEntrySchema).min(1).max(COMMANDS.length),
  })
  .strict();

function buildGrantSchema(grantScheme: string, ticketPattern: RegExp) {
  return z
    .object({
      schema: z.literal(grantScheme),
      grantId: z.string().uuid(),
      nonce: z.string().regex(/^[0-9a-f]{32}$/),
      repository: z.string().min(3),
      ticket: z.string().regex(ticketPattern),
      // Absent only for a command grant that publishes a new specification issue.
      issue: Positive.optional(),
      specDigest: Sha64,
      mode: z.enum(GRANT_MODES),
      capabilities: z.array(z.enum(CAPABILITIES)).max(CAPABILITIES.length),
      base: z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("exact"), sha: Sha40 }).strict(),
        z.object({ kind: z.literal("origin-main") }).strict(),
      ]),
      maxAttempts: z.number().int().min(1).max(5),
      issuedAt: IsoTime,
      expiresAt: IsoTime,
      revision: z
        .object({ pr: z.number().int().positive(), reviewedHead: Sha40, reviewDigest: Sha64 })
        .strict()
        .optional(),
      publication: z
        .object({ candidateSha: Sha40, branch: z.string().min(1) })
        .strict()
        .optional(),
      validation: z.object({ candidateSha: Sha40 }).strict().optional(),
      scope: CommandScopeSchema.optional(),
    })
    .strict()
    .superRefine((g, ctx) => {
      const issue = (message: string) => ctx.addIssue({ code: "custom", message });
      const scope = g.scope;
      const names = scope?.commands.map((c) => c.command) ?? [];
      if (new Set(names).size !== names.length) issue("duplicate scoped command");
      if (g.mode === "command") {
        if (
          names.length !== 1 ||
          !(SCOPED_ONLY_COMMANDS as readonly string[]).includes(names[0] ?? "")
        )
          issue(
            "a command grant scopes exactly one of cleanup, publish-specification, publish-review",
          );
      } else if (g.mode === "publication") {
        if (names.some((n) => !(PUBLICATION_COMMANDS as readonly string[]).includes(n)))
          issue("a publication grant can scope only publication commands");
      } else if (scope) issue(`a ${g.mode} grant carries no command scope`);
      const entry = scope?.commands[0];
      const newSpecification =
        g.mode === "command" &&
        entry?.command === "publish-specification" &&
        entry.target.kind === "new";
      if (newSpecification !== (g.issue === undefined))
        issue("issue is absent exactly for a grant that publishes a new specification");
      if (
        entry?.command === "publish-specification" &&
        entry.target.kind === "issue" &&
        entry.target.number !== g.issue
      )
        issue("a specification publication's target issue is the grant's issue");
      const need = (field: "revision" | "publication" | "validation", mode: GrantMode) => {
        if ((g.mode === mode) !== (g[field] !== undefined))
          ctx.addIssue({
            code: "custom",
            message: `${field} is required exactly for mode ${mode}`,
          });
      };
      need("revision", "revision");
      need("publication", "publication");
      need("validation", "validation");
      if (new Set(g.capabilities).size !== g.capabilities.length)
        ctx.addIssue({ code: "custom", message: "duplicate capability" });
      const lifetime = Date.parse(g.expiresAt) - Date.parse(g.issuedAt);
      if (!(lifetime > 0 && lifetime <= MAX_GRANT_LIFETIME_MS))
        ctx.addIssue({ code: "custom", message: "grant lifetime must be positive and ≤ 7 days" });
    });
}

export type GrantSchemaType = ReturnType<typeof buildGrantSchema>;
export type Grant = z.infer<GrantSchemaType>;

export const EnvelopeSchema = z
  .object({
    grant: z.unknown(),
    keyId: z.string().regex(/^[0-9a-f]{16}$/),
    signature: z.string().regex(/^[A-Za-z0-9_-]+$/),
  })
  .strict();
export type GrantEnvelope = { grant: Grant; keyId: string; signature: string };

/**
 * A public key the caller trusts to sign grants. Which keys are trusted is the
 * caller's decision, made from its own configuration, never from the envelope.
 */
export interface TrustedKey {
  keyId: string;
  publicKeyPem: string;
  /** Who the key belongs to; only for evidence. */
  label: string;
}

/** The live, verified state a grant is checked against at an action boundary. */
export interface ActionContext {
  action: RuntimeAction;
  ticket: string;
  /** From verifying the published specification fetched for this check. */
  specification: { ticketId: string; digest: string; digestMatches: boolean } | null;
  issue: number;
  revoked: boolean;
  /** Attempts already started under this grant (claim/launch only). */
  attemptsUsed: number;
  baseSha?: string;
  candidateSha?: string;
  branch?: string;
  /** Revision: the PR's current head and the digest of the review being acted on. */
  pullRequest?: { number: number; headSha: string; open: boolean };
  reviewDigest?: string;
}

/**
 * The live, verified state a command is checked against. Which fields matter depends on the
 * command: publication commands need the publication bindings of `ActionContext`; cleanup
 * needs the merged pull request; a specification publication needs what is being published;
 * a review publication needs the reviewed pull request and the review.
 */
export interface CommandContext {
  command: Command;
  ticket: string;
  revoked: boolean;
  /** Attempts already spent under this grant, by any command. */
  attemptsUsed: number;
  issue?: number;
  /** The initiative's published specification, verified for this check. */
  specification?: { ticketId: string; digest: string; digestMatches: boolean } | null;
  baseSha?: string;
  candidateSha?: string;
  branch?: string;
  pullRequest?: { number: number; headSha: string; open: boolean; merged: boolean };
  /** publish-specification: the specification about to be published and its destination. */
  publishing?: { ticketId: string; digest: string; issue: number | null };
  /** publish-review: the review about to be published. */
  review?: { pullRequest: number; reviewedHead: string; digest: string };
}

export interface CommandAuthorization {
  grant: Grant;
  /** The scope entry that authorized the command; null for an unscoped publication grant. */
  scope: CommandScopeEntry | null;
}

/**
 * Trusted, construction-time configuration: which repository grants must name, the
 * scheme they are signed under, the ticket grammar, and the one branch a ticket's
 * work may be published to. Supplied from committed code, never from a grant.
 */
export interface GrantProtocolConfig {
  grantScheme: string;
  repository: string;
  ticketPattern: RegExp;
  branchForTicket: (ticket: string) => string;
}

export interface GrantProtocol {
  readonly scheme: string;
  readonly repository: string;
  readonly grantSchema: GrantSchemaType;
  /** The exact bytes an owner signs; only for the trusted signer. */
  signingBytes(grant: Grant): Buffer;
  /** Signature, schema, trust, repository and validity window. Says nothing about any action. */
  verifyEnvelope(raw: unknown, trusted: TrustedKey[], now: Date): GrantEnvelope;
  /**
   * The authorization decision for one action; throws `unauthorized` naming the first failed
   * binding. A command-scoped grant is refused here: only `authorizeCommand` reads a scope.
   */
  authorizeAction(raw: unknown, trusted: TrustedKey[], context: ActionContext, now: Date): Grant;
  /** The authorization decision for one command (scope version 1). */
  authorizeCommand(
    raw: unknown,
    trusted: TrustedKey[],
    context: CommandContext,
    now: Date,
  ): CommandAuthorization;
}

const SCHEME = /^[a-z0-9][a-z0-9.-]{0,79}\/v[0-9]{1,4}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;

const deny = (message: string, detail?: Record<string, unknown>): never => {
  throw new FactoryCoreError("unauthorized", message, detail);
};

export function createGrantProtocol(config: GrantProtocolConfig): GrantProtocol {
  if (!SCHEME.test(config.grantScheme))
    throw new TypeError("factory-core: invalid grant protocol grantScheme");
  if (!REPOSITORY.test(config.repository))
    throw new TypeError("factory-core: invalid grant protocol repository");
  if (!(config.ticketPattern instanceof RegExp))
    throw new TypeError("factory-core: invalid grant protocol ticketPattern");
  if (typeof config.branchForTicket !== "function")
    throw new TypeError("factory-core: invalid grant protocol branchForTicket");
  const { grantScheme, repository, ticketPattern, branchForTicket } = config;
  const grantSchema = buildGrantSchema(grantScheme, ticketPattern);

  const signingBytes = (grant: Grant): Buffer =>
    Buffer.from(`${grantScheme}\n${canonicalJson(grant)}`, "utf8");

  const verifyEnvelope: GrantProtocol["verifyEnvelope"] = (raw, trusted, now) => {
    const envelope = EnvelopeSchema.safeParse(raw);
    if (!envelope.success) return deny("The grant envelope is malformed");
    const rawMode = (envelope.data.grant as { mode?: unknown } | null)?.mode;
    if (typeof rawMode === "string" && (PROHIBITED_MODES as readonly string[]).includes(rawMode))
      return deny(`Mode ${rawMode} can never be granted`);
    const grant = grantSchema.safeParse(envelope.data.grant);
    if (!grant.success)
      return deny("The grant does not match the grant schema", {
        issues: grant.error.issues.map((i) => i.message).slice(0, 5),
      });
    const key = trusted.find((k) => k.keyId === envelope.data.keyId);
    if (!key) return deny("The grant is signed by a key that is not trusted");
    if (keyIdFor(key.publicKeyPem) !== key.keyId)
      return deny("A trusted key's identifier does not match its public key");
    let valid = false;
    try {
      valid = verify(
        null,
        signingBytes(grant.data),
        createPublicKey(key.publicKeyPem),
        Buffer.from(envelope.data.signature, "base64url"),
      );
    } catch {
      valid = false;
    }
    if (!valid) return deny("The grant signature is invalid");
    if (grant.data.repository !== repository)
      return deny("The grant names another repository", { repository: grant.data.repository });
    if (Date.parse(grant.data.issuedAt) > now.getTime() + CLOCK_SKEW_MS)
      return deny("The grant is issued in the future");
    if (Date.parse(grant.data.expiresAt) <= now.getTime())
      return deny("The grant has expired", { expiresAt: grant.data.expiresAt });
    return { grant: grant.data, keyId: envelope.data.keyId, signature: envelope.data.signature };
  };

  const authorizeAction: GrantProtocol["authorizeAction"] = (raw, trusted, context, now) =>
    checkAction(verifyEnvelope(raw, trusted, now).grant, context, true);

  const checkAction = (grant: Grant, context: ActionContext, unscopedOnly: boolean): Grant => {
    // A caller that does not read scopes must not be able to widen a scoped grant.
    if (unscopedOnly && grant.scope)
      return deny("A command-scoped grant is authorized per command, not per action", {
        grantId: grant.grantId,
      });
    if (!ACTION_MODES[context.action].includes(grant.mode))
      return deny(`A ${grant.mode} grant does not authorize ${context.action}`, {
        mode: grant.mode,
        action: context.action,
      });
    if (context.revoked) return deny("The grant has been revoked", { grantId: grant.grantId });
    if (grant.ticket !== context.ticket || grant.issue !== context.issue)
      return deny("The grant names another ticket or issue");
    const spec = context.specification;
    if (!spec || !spec.digestMatches)
      return deny("The issue is no longer an unmodified published specification");
    if (spec.ticketId !== grant.ticket) return deny("The issue specifies another ticket");
    if (spec.digest !== grant.specDigest)
      return deny("The specification changed after the grant was issued", {
        granted: grant.specDigest,
        current: spec.digest,
      });
    if (
      (context.action === "claim" || context.action === "launch-session") &&
      context.attemptsUsed >= grant.maxAttempts
    )
      return deny("The grant's attempts are exhausted (replay refused)", {
        maxAttempts: grant.maxAttempts,
        used: context.attemptsUsed,
      });
    if (grant.base.kind === "exact" && context.baseSha && context.baseSha !== grant.base.sha)
      return deny("The base revision is not the authorized one", {
        authorized: grant.base.sha,
        actual: context.baseSha,
      });
    if (grant.mode === "publication") {
      const p = grant.publication as NonNullable<Grant["publication"]>;
      if (p.candidateSha !== context.candidateSha)
        return deny("The publication grant is for another commit", {
          authorized: p.candidateSha,
          candidate: context.candidateSha ?? null,
        });
      if (p.branch !== branchForTicket(grant.ticket) || p.branch !== context.branch)
        return deny("The publication grant names another destination branch", {
          authorized: p.branch,
        });
    }
    if (grant.mode === "validation" && grant.validation?.candidateSha !== context.candidateSha)
      return deny("The validation grant is for another commit");
    if (grant.mode === "revision") {
      const r = grant.revision as NonNullable<Grant["revision"]>;
      const pr = context.pullRequest;
      if (!pr || pr.number !== r.pr) return deny("The revision grant names another pull request");
      if (!pr.open) return deny("The pull request is not open");
      if (pr.headSha !== r.reviewedHead)
        return deny("The review is stale: the pull request head moved after the reviewed head", {
          reviewedHead: r.reviewedHead,
          currentHead: pr.headSha,
        });
      if (context.reviewDigest !== r.reviewDigest)
        return deny("The revision grant is bound to another review");
    }
    return grant;
  };

  const verifiedSpecification = (grant: Grant, context: CommandContext) => {
    if (grant.issue === undefined || grant.issue !== context.issue)
      return deny("The grant names another ticket or issue");
    const spec = context.specification;
    if (!spec || !spec.digestMatches)
      return deny("The issue is no longer an unmodified published specification");
    if (spec.ticketId !== grant.ticket) return deny("The issue specifies another ticket");
    if (spec.digest !== grant.specDigest)
      return deny("The specification changed after the grant was issued", {
        granted: grant.specDigest,
        current: spec.digest,
      });
  };

  const authorizeCommand: GrantProtocol["authorizeCommand"] = (raw, trusted, context, now) => {
    const { grant } = verifyEnvelope(raw, trusted, now);
    const command = context.command;
    if (!(COMMANDS as readonly string[]).includes(command))
      return deny("The command is not in the scope vocabulary", { command });
    if (context.revoked) return deny("The grant has been revoked", { grantId: grant.grantId });
    if (grant.ticket !== context.ticket) return deny("The grant names another ticket or issue");
    if (context.attemptsUsed >= grant.maxAttempts)
      return deny("The grant's attempts are exhausted (replay refused)", {
        maxAttempts: grant.maxAttempts,
        used: context.attemptsUsed,
      });
    const entries = grant.scope?.commands ?? [];
    if ((PUBLICATION_COMMANDS as readonly string[]).includes(command)) {
      if (grant.mode !== "publication")
        return deny(`A ${grant.mode} grant does not authorize ${command}`, {
          mode: grant.mode,
          command,
        });
      const entry = grant.scope ? entries.find((e) => e.command === command) : null;
      if (entry === undefined)
        return deny(`The grant's scope does not include ${command}`, {
          scoped: entries.map((e) => e.command),
        });
      checkAction(
        grant,
        {
          action: "publish",
          ticket: context.ticket,
          specification: context.specification ?? null,
          issue: context.issue ?? -1,
          revoked: false,
          attemptsUsed: 0,
          ...(context.baseSha ? { baseSha: context.baseSha } : {}),
          ...(context.candidateSha ? { candidateSha: context.candidateSha } : {}),
          ...(context.branch ? { branch: context.branch } : {}),
        },
        false,
      );
      return { grant, scope: entry };
    }
    // Scoped-only: never authorized by omission, never by another command's scope.
    const entry = entries[0];
    if (grant.mode !== "command" || !entry)
      return deny(`${command} needs a command grant that scopes it; this grant has no such scope`, {
        mode: grant.mode,
        command,
      });
    if (entry.command !== command)
      return deny(`The grant is scoped to ${entry.command}, not ${command}`, {
        scoped: entry.command,
        command,
      });
    if (entry.command === "cleanup") {
      verifiedSpecification(grant, context);
      if (grant.base.kind === "exact" && context.baseSha && context.baseSha !== grant.base.sha)
        return deny("The base revision is not the authorized one");
      const pr = context.pullRequest;
      if (!pr || pr.number !== entry.pullRequest)
        return deny("The cleanup grant names another pull request");
      if (!pr.merged) return deny("The pull request is not merged");
      if (pr.headSha !== entry.mergedHead)
        return deny("The merged head is not the one the cleanup grant names", {
          authorized: entry.mergedHead,
          actual: pr.headSha,
        });
      if (context.branch !== branchForTicket(grant.ticket))
        return deny("The cleanup grant names another branch");
    } else if (entry.command === "publish-specification") {
      const p = context.publishing;
      if (!p) return deny("No specification to publish was verified");
      if (p.ticketId !== grant.ticket) return deny("The specification is for another ticket");
      if (p.digest !== grant.specDigest)
        return deny("The specification is not the one the grant names", {
          granted: grant.specDigest,
          publishing: p.digest,
        });
      const target = entry.target.kind === "new" ? null : entry.target.number;
      if (p.issue !== target)
        return deny("The specification's destination is not the one the grant names", {
          authorized: target,
          destination: p.issue,
        });
    } else if (entry.command === "publish-review") {
      verifiedSpecification(grant, context);
      const pr = context.pullRequest;
      if (!pr || pr.number !== entry.pullRequest)
        return deny("The review grant names another pull request");
      if (!pr.open) return deny("The pull request is not open");
      if (pr.headSha !== entry.reviewedHead)
        return deny("The review is stale: the pull request head moved after the reviewed head", {
          reviewedHead: entry.reviewedHead,
          currentHead: pr.headSha,
        });
      const r = context.review;
      if (!r || r.pullRequest !== entry.pullRequest || r.reviewedHead !== entry.reviewedHead)
        return deny("The review is not for the pull request and head the grant names");
      if (entry.reviewDigest && entry.reviewDigest !== r.digest)
        return deny("The review is not the one the grant names");
    } else return deny("The grant's scope is not a scoped-only command");
    return { grant, scope: entry };
  };

  return Object.freeze({
    scheme: grantScheme,
    repository,
    grantSchema,
    signingBytes,
    verifyEnvelope,
    authorizeAction,
    authorizeCommand,
  });
}

export function requireCapability(grant: Grant, capability: Capability, why: string): void {
  if (!grant.capabilities.includes(capability))
    deny(`${why} requires the ${capability} capability, which this grant does not include`, {
      capability,
    });
}

/** Stable identifier for evidence: the hash of the canonical envelope. */
export function envelopeDigest(envelope: GrantEnvelope): string {
  return createHash("sha256").update(canonicalJson(envelope)).digest("hex");
}
