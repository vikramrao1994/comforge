import { createPrivateKey, createPublicKey, randomBytes, randomUUID, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { DESTRUCTIVE_COMMANDS as CORE_DESTRUCTIVE_COMMANDS, createGrantProtocol, envelopeDigest, FactoryCoreError, keyIdFor, } from "@comforge/core";
import { readSpecificationIssue } from "@comforge/github";
import { LedgerError } from "@comforge/ledger";
import { createFileLedger } from "@comforge/ledger/file";
import { CliError, fail } from "./errors.js";
import { githubError } from "./github.js";
import { specificationProtocol } from "./protocols.js";
import { nowIso, stateDir } from "./state.js";
export function grantProtocol(config, record) {
    const a = config.security.authorization;
    if (a?.mode !== "owner-grant")
        return fail("config-invalid", "owner-grant authorization is not configured");
    return createGrantProtocol({
        grantScheme: a.grantScheme,
        repository: `${config.repository.owner}/${config.repository.name}`,
        ticketPattern: new RegExp(config.tickets.pattern),
        // A grant names the initiative's own branch (a phase has its own).
        branchForTicket: (ticket) => ticket === record.ticket
            ? record.branch
            : `${config.tickets.branchPrefix}${ticket.toLowerCase()}`,
    });
}
export async function authorizeWrites(ctx, trusted, record, options) {
    const a = trusted.security.authorization;
    if (!a)
        return fail("authorization-required", "GitHub writes are not authorized in this repository: the trusted configuration sets no security.authorization");
    if (a.mode === "operator")
        return { mode: "operator" };
    if (!record?.specification)
        return fail("authorization-required", "owner-grant writes need an initiative started from a published specification");
    if (!options.grantFile)
        return fail("authorization-required", "this write needs --grant FILE, an owner-signed grant");
    let raw;
    try {
        raw = JSON.parse(readFileSync(options.grantFile, "utf8"));
    }
    catch {
        return fail("usage", `${options.grantFile} is not a readable JSON grant`);
    }
    const spec = specificationProtocol(trusted);
    if (!spec)
        return fail("config-invalid", "owner-grant needs a specification section");
    const issue = await readSpecificationIssue(ctx.github(trusted).evidence, spec, record.specification.issueNumber).catch(githubError);
    let grant;
    let scope;
    try {
        // Signed command scopes (@comforge/core): a scope-less publication grant authorizes the
        // publication commands as before; cleanup needs a command grant naming the merged PR.
        const grantId = raw?.grant?.grantId;
        ({ grant, scope } = grantProtocol(trusted, record).authorizeCommand(raw, a.trustedKeys, {
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
        }, new Date(ctx.rt.now())));
    }
    catch (error) {
        if (error instanceof FactoryCoreError)
            throw new CliError("unauthorized", `grant refused: ${error.message}`, {
                ...(error.detail ?? {}),
            });
        throw error;
    }
    const envelope = raw;
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
export const DESTRUCTIVE_COMMANDS = new Set(CORE_DESTRUCTIVE_COMMANDS);
export async function reserveGrantAttempt(ctx, initiative, use) {
    let attempt = 0;
    await ctx.state.update(initiative, (r) => {
        r.grantUses ??= [];
        const used = r.grantUses.filter((u) => u.grantId === use.grantId).length;
        // Destructive cleanup is separately authorized: a grant spent on cleanup is not spent on a
        // publication, and a publication's grant does not authorize deleting the branch.
        const destructive = (command) => DESTRUCTIVE_COMMANDS.has(command);
        const mixed = r.grantUses.find((u) => u.grantId === use.grantId && destructive(u.command) !== destructive(use.command));
        if (mixed)
            throw new CliError("unauthorized", `grant refused: it was used for ${mixed.command}; ${use.command} needs its own grant`, { grantId: use.grantId, usedFor: mixed.command });
        if (used >= use.maxAttempts)
            throw new CliError("unauthorized", "grant refused: its attempts are exhausted (replay refused)", {
                grantId: use.grantId,
                maxAttempts: use.maxAttempts,
            });
        const { maxAttempts: _max, ...entry } = use;
        r.grantUses.push(entry);
        attempt = used + 1;
    });
    return attempt;
}
/** An unsigned publication grant for the initiative's current head, for the owner to review and sign. */
export function grantTemplate(trusted, record, head, now, hours, 
/** A command grant instead of a publication grant: cleanup of the merged pull request. */
command) {
    const a = trusted.security.authorization;
    if (a?.mode !== "owner-grant")
        return fail("config-invalid", "owner-grant authorization is not configured");
    if (!record.specification)
        return fail("authorization-required", "the initiative has no specification to bind");
    if (!(hours > 0 && hours <= 168))
        return fail("usage", "--hours must be between 1 and 168");
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
                mode: "command",
                maxAttempts: 1,
                scope: {
                    version: 1,
                    commands: [
                        { command: "cleanup", pullRequest: command.pullRequest, mergedHead: head },
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
export function signGrant(protocol, grant, privateKeyPem) {
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
export async function authorizeGovernanceWrite(ctx, trusted, options) {
    const a = trusted.security.authorization;
    if (!a)
        return fail("authorization-required", "GitHub writes are not authorized in this repository: the trusted configuration sets no security.authorization");
    if (a.mode === "operator")
        return { mode: "operator" };
    if (!options.grantFile)
        return fail("authorization-required", "this write needs --grant FILE, an owner-signed command grant");
    let raw;
    try {
        raw = JSON.parse(readFileSync(options.grantFile, "utf8"));
    }
    catch {
        return fail("usage", `${options.grantFile} is not a readable JSON grant`);
    }
    const protocol = governanceGrantProtocol(trusted);
    const grantId = raw?.grant?.grantId;
    let grant;
    let scope;
    try {
        ({ grant, scope } = protocol.authorizeCommand(raw, a.trustedKeys, {
            ...options.context,
            revoked: typeof grantId === "string" && (a.revokedGrants ?? []).includes(grantId),
            attemptsUsed: 0,
        }, new Date(ctx.rt.now())));
    }
    catch (error) {
        if (error instanceof FactoryCoreError)
            throw new CliError("unauthorized", `grant refused: ${error.message}`, {
                ...(error.detail ?? {}),
            });
        throw error;
    }
    const digest = envelopeDigest(raw);
    await spendCommandGrant(ctx, grant, {
        command: options.context.command,
        envelopeDigest: digest,
        at: nowIso(ctx.rt.now()),
    });
    return {
        mode: "owner-grant",
        grantId: grant.grantId,
        keyId: raw.keyId,
        expiresAt: grant.expiresAt,
        envelopeDigest: digest,
        scope: scope ? scope.command : null,
    };
}
async function spendCommandGrant(ctx, grant, use) {
    const ledger = createFileLedger({
        directory: stateDir(ctx.repo.commonDir),
        namespace: "command-grants",
        validate: (r) => {
            if (!Array.isArray(r.uses))
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
        const next = {
            operationId: grant.grantId,
            version: (current?.version ?? 0) + 1,
            uses: [...uses, use],
        };
        if (current
            ? await ledger.replace(grant.grantId, current.version, next)
            : await ledger.create(next))
            return;
    }
    fail("ledger", "the grant's use record is changing too fast; rerun");
}
/**
 * An unsigned command grant for one governance write, for the owner to review and sign
 * (`comforge grant sign`): the exact scope entry, digest and destination the dry run computed.
 */
export function commandGrantTemplate(trusted, options) {
    const a = trusted.security.authorization;
    if (a?.mode !== "owner-grant")
        return null;
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
export function governanceGrantProtocol(trusted) {
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
