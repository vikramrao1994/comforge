import { Buffer } from "node:buffer";
import { z } from "zod";
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
export declare const RECEIPT_MAX_AGE_MS: number;
declare function buildReceiptSchema(receiptScheme: string): z.ZodObject<{
    schema: z.ZodLiteral<string>;
    receiptId: z.ZodString;
    repository: z.ZodString;
    ticket: z.ZodString;
    specDigest: z.ZodString;
    executionId: z.ZodString;
    candidateSha: z.ZodString;
    tree: z.ZodString;
    baseSha: z.ZodString;
    controllerRevision: z.ZodString;
    profile: z.ZodEnum<{
        command: "command";
        "test-verify": "test-verify";
    }>;
    command: z.ZodString;
    provisioning: z.ZodArray<z.ZodString>;
    provisioningDigest: z.ZodString;
    startedAt: z.ZodString;
    completedAt: z.ZodString;
    durationMs: z.ZodNumber;
    outcome: z.ZodEnum<{
        FAIL: "FAIL";
        PASS: "PASS";
        UNAVAILABLE: "UNAVAILABLE";
    }>;
    summarySha256: z.ZodNullable<z.ZodString>;
    summaryCounts: z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodNumber>>;
    checks: z.ZodOptional<z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        status: z.ZodString;
    }, z.core.$strict>>>;
    failures: z.ZodOptional<z.ZodArray<z.ZodObject<{
        check: z.ZodString;
        file: z.ZodString;
        test: z.ZodNullable<z.ZodString>;
        class: z.ZodString;
    }, z.core.$strict>>>;
    unverified: z.ZodOptional<z.ZodArray<z.ZodString>>;
    trustSensitiveChanges: z.ZodArray<z.ZodString>;
    workflowChanges: z.ZodArray<z.ZodString>;
    validationIntegrity: z.ZodObject<{
        focused: z.ZodArray<z.ZodString>;
        findings: z.ZodArray<z.ZodString>;
    }, z.core.$strict>;
    integrity: z.ZodObject<{
        objects: z.ZodEnum<{
            failed: "failed";
            ok: "ok";
        }>;
        baseIsAncestor: z.ZodBoolean;
    }, z.core.$strict>;
}, z.core.$strict>;
export type ReceiptSchemaType = ReturnType<typeof buildReceiptSchema>;
export type Receipt = z.infer<ReceiptSchemaType>;
export interface SignedReceipt {
    receipt: Receipt;
    keyId: string;
    signature: string;
}
export interface ReceiptExpectation {
    ticket: string;
    specDigest: string;
    candidateSha: string;
    tree: string;
    controllerRevision: string;
    now: Date;
    maxAgeMs?: number;
}
/** Trusted, construction-time configuration, supplied from committed code. */
export interface ReceiptProtocolConfig {
    receiptScheme: string;
    repository: string;
}
export interface ReceiptProtocol {
    readonly scheme: string;
    readonly repository: string;
    readonly receiptSchema: ReceiptSchemaType;
    /** The exact bytes the controller signs; only for the trusted signer. */
    signingBytes(receipt: Receipt): Buffer;
    /**
     * Refuses (each with its own message) a malformed, forged or altered receipt, one
     * signed by another key, one for another repository, ticket, specification, commit,
     * tree or controller revision, a stale one, any outcome other than PASS, and one
     * that records an integrity failure.
     */
    verifyReceipt(raw: unknown, publicKeyPem: string, expect: ReceiptExpectation): Receipt;
}
export declare function createReceiptProtocol(config: ReceiptProtocolConfig): ReceiptProtocol;
export {};
