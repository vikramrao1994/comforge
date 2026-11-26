import { createPrivateKey, createPublicKey, randomBytes, randomUUID, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { createGrantProtocol, envelopeDigest, FactoryCoreError, keyIdFor, } from "@comforge/core";
import { readSpecificationIssue } from "@comforge/github";
import { CliError, fail } from "./errors.js";
import { githubError } from "./github.js";
import { specificationProtocol } from "./protocols.js";
import { nowIso } from "./state.js";
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
    try {
        grant = grantProtocol(trusted, record).authorizeAction(raw, a.trustedKeys, {
            action: "publish",
            ticket: record.ticket,
            specification: issue.verification,
            issue: record.specification.issueNumber,
            revoked: false,
            attemptsUsed: 0,
            baseSha: record.base.sha,
            candidateSha: options.head,
            branch: record.branch,
        }, new Date(ctx.rt.now()));
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
export async function reserveGrantAttempt(ctx, initiative, use) {
    let attempt = 0;
    await ctx.state.update(initiative, (r) => {
        r.grantUses ??= [];
        const used = r.grantUses.filter((u) => u.grantId === use.grantId).length;
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
export function grantTemplate(trusted, record, head, now, hours) {
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
        publication: { candidateSha: head, branch: record.branch },
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
