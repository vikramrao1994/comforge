import { Buffer } from "node:buffer";
import { z } from "zod";
import { type Capability, type RuntimeAction } from "./authorization.ts";
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
export declare const MAX_GRANT_LIFETIME_MS: number;
/** Tolerated clock skew between the owner's signing machine and the verifier. */
export declare const CLOCK_SKEW_MS: number;
declare function buildGrantSchema(grantScheme: string, ticketPattern: RegExp): z.ZodObject<{
    schema: z.ZodLiteral<string>;
    grantId: z.ZodString;
    nonce: z.ZodString;
    repository: z.ZodString;
    ticket: z.ZodString;
    issue: z.ZodNumber;
    specDigest: z.ZodString;
    mode: z.ZodEnum<{
        audit: "audit";
        implementation: "implementation";
        publication: "publication";
        revision: "revision";
        validation: "validation";
    }>;
    capabilities: z.ZodArray<z.ZodEnum<{
        "accept-validation-changes": "accept-validation-changes";
        "edit-repository": "edit-repository";
        "modify-workflows": "modify-workflows";
        "run-e2e": "run-e2e";
    }>>;
    base: z.ZodDiscriminatedUnion<[z.ZodObject<{
        kind: z.ZodLiteral<"exact">;
        sha: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        kind: z.ZodLiteral<"origin-main">;
    }, z.core.$strict>], "kind">;
    maxAttempts: z.ZodNumber;
    issuedAt: z.ZodString;
    expiresAt: z.ZodString;
    revision: z.ZodOptional<z.ZodObject<{
        pr: z.ZodNumber;
        reviewedHead: z.ZodString;
        reviewDigest: z.ZodString;
    }, z.core.$strict>>;
    publication: z.ZodOptional<z.ZodObject<{
        candidateSha: z.ZodString;
        branch: z.ZodString;
    }, z.core.$strict>>;
    validation: z.ZodOptional<z.ZodObject<{
        candidateSha: z.ZodString;
    }, z.core.$strict>>;
}, z.core.$strict>;
export type GrantSchemaType = ReturnType<typeof buildGrantSchema>;
export type Grant = z.infer<GrantSchemaType>;
export declare const EnvelopeSchema: z.ZodObject<{
    grant: z.ZodUnknown;
    keyId: z.ZodString;
    signature: z.ZodString;
}, z.core.$strict>;
export type GrantEnvelope = {
    grant: Grant;
    keyId: string;
    signature: string;
};
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
    specification: {
        ticketId: string;
        digest: string;
        digestMatches: boolean;
    } | null;
    issue: number;
    revoked: boolean;
    /** Attempts already started under this grant (claim/launch only). */
    attemptsUsed: number;
    baseSha?: string;
    candidateSha?: string;
    branch?: string;
    /** Revision: the PR's current head and the digest of the review being acted on. */
    pullRequest?: {
        number: number;
        headSha: string;
        open: boolean;
    };
    reviewDigest?: string;
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
    /** The authorization decision for one action; throws `unauthorized` naming the first failed binding. */
    authorizeAction(raw: unknown, trusted: TrustedKey[], context: ActionContext, now: Date): Grant;
}
export declare function createGrantProtocol(config: GrantProtocolConfig): GrantProtocol;
export declare function requireCapability(grant: Grant, capability: Capability, why: string): void;
/** Stable identifier for evidence: the hash of the canonical envelope. */
export declare function envelopeDigest(envelope: GrantEnvelope): string;
export {};
