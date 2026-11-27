import { type ActionContext, type Capability, canonicalJson, type Grant, type GrantMode, type GrantSchemaType, keyIdFor, type Receipt, type ReceiptExpectation, type ReceiptSchemaType, type RuntimeAction, type SignedReceipt, type TrustedKey } from "@comforge/core";
export declare const RUNTIME_AUTHORITY_SCHEMA: "comforge-runtime-authority/v1";
export type AuthorityErrorCode = "unauthorized" | "validation_failed";
/** The one refusal an authority throws; the message names the first binding that failed. */
export declare class AuthorityError extends Error {
    readonly code: AuthorityErrorCode;
    readonly detail: Record<string, unknown> | undefined;
    constructor(code: AuthorityErrorCode, message: string, detail?: Record<string, unknown>);
}
/** Signs exact bytes with one Ed25519 key. Lives only where that key lives. */
export interface Signer {
    readonly publicKeyPem: string;
    sign(bytes: Uint8Array): Uint8Array;
}
/** A signer over a PEM private key held in this process: for the owner's or controller's side. */
export declare function ed25519Signer(privateKeyPem: string): Signer;
/** An execution grant: always bound to its published specification issue. */
export type RuntimeGrant = Grant & {
    issue: number;
};
export interface RuntimeGrantEnvelope {
    grant: RuntimeGrant;
    keyId: string;
    signature: string;
}
export interface RuntimeAuthorityOptions {
    /** The authority format. An unknown value is refused. */
    schema: typeof RUNTIME_AUTHORITY_SCHEMA;
    /** `owner/name`; a grant or receipt naming another repository never verifies. */
    repository: string;
    ticketPattern: RegExp;
    branchForTicket: (ticket: string) => string;
    grantScheme: string;
    receiptScheme: string;
    /**
     * Schemes of every other authority in this repository (the lifecycle's grant scheme). The
     * authority refuses to exist under one of them. Required, so the separation is stated.
     */
    separateFrom: readonly string[];
}
export interface RuntimeAuthority {
    readonly schema: typeof RUNTIME_AUTHORITY_SCHEMA;
    readonly repository: string;
    readonly grants: {
        readonly scheme: string;
        readonly schema: GrantSchemaType;
        /** Owner side: validates the fields as an execution grant and signs them. */
        issue(fields: unknown, signer: Signer): RuntimeGrantEnvelope;
        /** Signature, schema, trust and validity window. Says nothing about any action. */
        verify(raw: unknown, trusted: TrustedKey[], now: Date): RuntimeGrantEnvelope;
        /** The decision for one action; throws naming the first failed binding. */
        authorize(raw: unknown, trusted: TrustedKey[], context: ActionContext, now: Date): RuntimeGrant;
        requireCapability(grant: RuntimeGrant, capability: Capability, why: string): void;
        /** Stable identity of one signed envelope. */
        digest(envelope: RuntimeGrantEnvelope): string;
    };
    readonly receipts: {
        readonly scheme: string;
        readonly schema: ReceiptSchemaType;
        /** Controller side: validates the receipt and signs it. */
        seal(receipt: unknown, signer: Signer): SignedReceipt;
        /** Refuses anything but a current PASS receipt for exactly the expected commit and tree. */
        verify(raw: unknown, publicKeyPem: string, expect: ReceiptExpectation): Receipt;
    };
}
export declare function createRuntimeAuthority(options: RuntimeAuthorityOptions): RuntimeAuthority;
/** Bounds every authority applies; fixed, not configurable. */
export declare const AUTHORITY_LIMITS: Readonly<{
    clockSkewMs: number;
    maxGrantLifetimeMs: number;
    receiptMaxAgeMs: number;
}>;
/**
 * What an execution grant can say: its modes, the modes that can never be granted, the actions
 * a host asks about, which modes authorize which action, and the capabilities.
 */
export declare const AUTHORITY_VOCABULARY: Readonly<{
    grantModes: readonly ["audit", "implementation", "validation", "publication", "revision", "command"];
    prohibitedModes: readonly ["merge", "release", "deploy"];
    actions: readonly ["claim", "launch-session", "resume-session", "commit", "validate", "publish"];
    actionModes: Readonly<Record<"claim" | "commit" | "launch-session" | "publish" | "resume-session" | "validate", readonly ("audit" | "command" | "implementation" | "publication" | "revision" | "validation")[]>>;
    capabilities: readonly ["edit-repository", "run-e2e", "modify-workflows", "accept-validation-changes"];
}>;
/** The shape of any signed grant envelope, before a scheme is applied. */
export declare const GrantEnvelopeSchema: import("zod").ZodObject<{
    grant: import("zod").ZodUnknown;
    keyId: import("zod").ZodString;
    signature: import("zod").ZodString;
}, import("zod/v4/core").$strict>;
export { canonicalJson, keyIdFor };
export type { ActionContext, Capability, GrantMode, Receipt, ReceiptExpectation, RuntimeAction, SignedReceipt, TrustedKey, };
