import { Buffer } from "node:buffer";
import { createPublicKey, verify } from "node:crypto";
import { z } from "zod";
import { canonicalJson, keyIdFor } from "./canonical.js";
import { FactoryCoreError } from "./errors.js";
/**
 * Verification of signed validation receipts. Pure: no I/O, no environment, no clock
 * (the caller passes `now`), no private key. Running the validator, building the
 * receipt from Git, and signing it stay with the trusted controller that owns the
 * receipt key; the public key to verify against is the caller's, never the receipt's.
 *
 * A receipt is canonical JSON signed with the controller's Ed25519 key over
 * `<receiptScheme>\n<canonical JSON>`. A valid signature proves who recorded which
 * validation of which commit; `verifyReceipt` also requires the expected repository,
 * ticket, specification, commit, tree and controller revision, freshness, a PASS
 * outcome and recorded object integrity.
 */
/** A PASS older than this no longer counts. */
export const RECEIPT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const Sha40 = z.string().regex(/^[0-9a-f]{40}$/);
const Sha64 = z.string().regex(/^[0-9a-f]{64}$/);
function buildReceiptSchema(receiptScheme) {
    return z
        .object({
        schema: z.literal(receiptScheme),
        receiptId: z.string().uuid(),
        repository: z.string(),
        ticket: z.string(),
        specDigest: Sha64,
        executionId: z.string().uuid(),
        candidateSha: Sha40,
        tree: Sha40,
        baseSha: Sha40,
        controllerRevision: Sha40,
        profile: z.enum(["test-verify", "command"]),
        command: z.string(),
        provisioning: z.array(z.string()),
        provisioningDigest: Sha64,
        startedAt: z.string(),
        completedAt: z.string(),
        durationMs: z.number().int().nonnegative(),
        outcome: z.enum(["PASS", "FAIL", "UNAVAILABLE"]),
        summarySha256: Sha64.nullable(),
        summaryCounts: z.record(z.string(), z.number()).nullable(),
        /**
         * What the validator's summary reported, so a FAIL or UNAVAILABLE receipt says why.
         * Bounded and data only (file and test names come from the candidate). Optional:
         * receipts signed before these fields existed still verify.
         */
        checks: z.array(z.object({ id: z.string(), status: z.string() }).strict()).optional(),
        failures: z
            .array(z
            .object({
            check: z.string(),
            file: z.string(),
            test: z.string().nullable(),
            class: z.string(),
        })
            .strict())
            .optional(),
        unverified: z.array(z.string()).optional(),
        trustSensitiveChanges: z.array(z.string()),
        workflowChanges: z.array(z.string()),
        /** Trusted checks of what the candidate did to its own validation. */
        validationIntegrity: z
            .object({ focused: z.array(z.string()), findings: z.array(z.string()) })
            .strict(),
        integrity: z
            .object({ objects: z.enum(["ok", "failed"]), baseIsAncestor: z.boolean() })
            .strict(),
    })
        .strict();
}
const SCHEME = /^[a-z0-9][a-z0-9.-]{0,79}\/v[0-9]{1,4}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const reject = (message, detail) => {
    throw new FactoryCoreError("validation_failed", message, detail);
};
export function createReceiptProtocol(config) {
    if (!SCHEME.test(config.receiptScheme))
        throw new TypeError("factory-core: invalid receipt protocol receiptScheme");
    if (!REPOSITORY.test(config.repository))
        throw new TypeError("factory-core: invalid receipt protocol repository");
    const { receiptScheme, repository } = config;
    const receiptSchema = buildReceiptSchema(receiptScheme);
    const signingBytes = (receipt) => Buffer.from(`${receiptScheme}\n${canonicalJson(receipt)}`, "utf8");
    const verifyReceipt = (raw, publicKeyPem, expect) => {
        const shape = z
            .object({ receipt: z.unknown(), keyId: z.string(), signature: z.string() })
            .strict()
            .safeParse(raw);
        if (!shape.success)
            return reject("The validation receipt is malformed");
        const parsed = receiptSchema.safeParse(shape.data.receipt);
        if (!parsed.success)
            return reject("The validation receipt does not match its schema");
        const receipt = parsed.data;
        if (shape.data.keyId !== keyIdFor(publicKeyPem))
            return reject("The receipt is signed by an unknown key");
        let valid = false;
        try {
            valid = verify(null, signingBytes(receipt), createPublicKey(publicKeyPem), Buffer.from(shape.data.signature, "base64url"));
        }
        catch {
            valid = false;
        }
        if (!valid)
            return reject("The receipt signature is invalid (forged or altered)");
        if (receipt.repository !== repository)
            return reject("The receipt names another repository");
        if (receipt.ticket !== expect.ticket || receipt.specDigest !== expect.specDigest)
            return reject("The receipt is for another ticket or specification");
        if (receipt.candidateSha !== expect.candidateSha || receipt.tree !== expect.tree)
            return reject("The receipt is for another commit", {
                receipt: receipt.candidateSha,
                candidate: expect.candidateSha,
            });
        if (receipt.controllerRevision !== expect.controllerRevision)
            return reject("The receipt was produced by another controller revision (stale)");
        if (expect.now.getTime() - Date.parse(receipt.completedAt) >
            (expect.maxAgeMs ?? RECEIPT_MAX_AGE_MS))
            return reject("The receipt is stale");
        if (receipt.outcome !== "PASS")
            return reject(`Validation outcome is ${receipt.outcome}`, { outcome: receipt.outcome });
        if (receipt.integrity.objects !== "ok" || !receipt.integrity.baseIsAncestor)
            return reject("The receipt records an integrity failure");
        return receipt;
    };
    return Object.freeze({
        scheme: receiptScheme,
        repository,
        receiptSchema,
        signingBytes,
        verifyReceipt,
    });
}
