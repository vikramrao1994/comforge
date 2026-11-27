/**
 * `@comforge/cli/authority`: signed execution grants and validation receipts for a host that runs
 * work itself (an execution runtime, a validation controller).
 *
 * This is a separate authority from the lifecycle's own grants (`comforge grant`, command
 * scopes). The two never translate into each other:
 * - a runtime authority is constructed under its own schemes and refuses to be constructed
 *   under a scheme named in `separateFrom`;
 * - it refuses every command grant and every grant without a specification issue, whatever
 *   signed it, so a lifecycle authorization can never start an execution;
 * - trusted keys are passed per call by the host. Nothing here reads a key from a
 *   configuration, a file or the environment, and no key is shared with the lifecycle.
 *
 * Verification needs public keys only. Signing goes through a `Signer` the host supplies, so
 * the process that verifies (an agent, a supervisor) never needs the private key.
 */
import { createPrivateKey, createPublicKey, sign as nodeSign } from "node:crypto";
import { ACTION_MODES, ACTIONS, CAPABILITIES, CLOCK_SKEW_MS, canonicalJson, createGrantProtocol, createReceiptProtocol, EnvelopeSchema, envelopeDigest, FactoryCoreError, GRANT_MODES, keyIdFor, MAX_GRANT_LIFETIME_MS, PROHIBITED_MODES, RECEIPT_MAX_AGE_MS, requireCapability, } from "@comforge/core";
export const RUNTIME_AUTHORITY_SCHEMA = "comforge-runtime-authority/v1";
/** The one refusal an authority throws; the message names the first binding that failed. */
export class AuthorityError extends Error {
    code;
    detail;
    constructor(code, message, detail) {
        super(message);
        this.name = "AuthorityError";
        this.code = code;
        this.detail = detail;
    }
}
/** A signer over a PEM private key held in this process: for the owner's or controller's side. */
export function ed25519Signer(privateKeyPem) {
    const key = createPrivateKey(privateKeyPem);
    if (key.asymmetricKeyType !== "ed25519")
        throw new TypeError("@comforge/cli/authority: the signing key must be Ed25519");
    const publicKeyPem = createPublicKey(key).export({ type: "spki", format: "pem" }).toString();
    return { publicKeyPem, sign: (bytes) => nodeSign(null, bytes, key) };
}
function refuse(message) {
    throw new TypeError(`@comforge/cli/authority: ${message}`);
}
function guarded(run) {
    try {
        return run();
    }
    catch (error) {
        if (error instanceof FactoryCoreError)
            throw new AuthorityError(error.code, error.message, error.detail);
        throw error;
    }
}
export function createRuntimeAuthority(options) {
    if (options?.schema !== RUNTIME_AUTHORITY_SCHEMA)
        refuse(`unsupported authority ${JSON.stringify(options?.schema)}`);
    if (!Array.isArray(options.separateFrom))
        refuse("separateFrom must list the schemes of every other authority (may be empty)");
    if (options.grantScheme === options.receiptScheme)
        refuse("grants and receipts need different schemes");
    for (const scheme of [options.grantScheme, options.receiptScheme])
        if (options.separateFrom.includes(scheme))
            refuse(`scheme ${scheme} belongs to another authority`);
    const grantProtocol = createGrantProtocol({
        grantScheme: options.grantScheme,
        repository: options.repository,
        ticketPattern: options.ticketPattern,
        branchForTicket: options.branchForTicket,
    });
    const receiptProtocol = createReceiptProtocol({
        receiptScheme: options.receiptScheme,
        repository: options.repository,
    });
    const executionOnly = (grant) => {
        if (grant.mode === "command" || typeof grant.issue !== "number")
            throw new AuthorityError("unauthorized", "a command grant (or any grant without a specification issue) never authorizes a runtime execution", { mode: grant.mode });
        return grant;
    };
    return Object.freeze({
        schema: RUNTIME_AUTHORITY_SCHEMA,
        repository: options.repository,
        grants: Object.freeze({
            scheme: grantProtocol.scheme,
            schema: grantProtocol.grantSchema,
            issue(fields, signer) {
                const grant = executionOnly(grantProtocol.grantSchema.parse(fields));
                return {
                    grant,
                    keyId: keyIdFor(signer.publicKeyPem),
                    signature: Buffer.from(signer.sign(grantProtocol.signingBytes(grant))).toString("base64url"),
                };
            },
            verify(raw, trusted, now) {
                const envelope = guarded(() => grantProtocol.verifyEnvelope(raw, trusted, now));
                executionOnly(envelope.grant);
                return envelope;
            },
            authorize(raw, trusted, context, now) {
                return executionOnly(guarded(() => grantProtocol.authorizeAction(raw, trusted, context, now)));
            },
            requireCapability(grant, capability, why) {
                guarded(() => requireCapability(grant, capability, why));
            },
            digest: (envelope) => envelopeDigest(envelope),
        }),
        receipts: Object.freeze({
            scheme: receiptProtocol.scheme,
            schema: receiptProtocol.receiptSchema,
            seal(receipt, signer) {
                const parsed = receiptProtocol.receiptSchema.parse(receipt);
                return {
                    receipt: parsed,
                    keyId: keyIdFor(signer.publicKeyPem),
                    signature: Buffer.from(signer.sign(receiptProtocol.signingBytes(parsed))).toString("base64url"),
                };
            },
            verify(raw, publicKeyPem, expect) {
                return guarded(() => receiptProtocol.verifyReceipt(raw, publicKeyPem, expect));
            },
        }),
    });
}
/** Bounds every authority applies; fixed, not configurable. */
export const AUTHORITY_LIMITS = Object.freeze({
    clockSkewMs: CLOCK_SKEW_MS,
    maxGrantLifetimeMs: MAX_GRANT_LIFETIME_MS,
    receiptMaxAgeMs: RECEIPT_MAX_AGE_MS,
});
/**
 * What an execution grant can say: its modes, the modes that can never be granted, the actions
 * a host asks about, which modes authorize which action, and the capabilities.
 */
export const AUTHORITY_VOCABULARY = Object.freeze({
    grantModes: GRANT_MODES,
    prohibitedModes: PROHIBITED_MODES,
    actions: ACTIONS,
    actionModes: ACTION_MODES,
    capabilities: CAPABILITIES,
});
/** The shape of any signed grant envelope, before a scheme is applied. */
export const GrantEnvelopeSchema = EnvelopeSchema;
export { canonicalJson, keyIdFor };
