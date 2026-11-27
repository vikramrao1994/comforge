import { Buffer } from "node:buffer";
import { z } from "zod";
import { type Capability, type Command, type RuntimeAction } from "./authorization.ts";
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
/**
 * One scoped command. Each scoped-only command carries the bindings it is checked against:
 * cleanup names the merged pull request and the head that merged; a specification publication
 * names whether it creates a new issue or replaces one; a review publication names the pull
 * request and the exact head that was reviewed (and optionally the review's digest).
 */
declare const CommandScopeEntrySchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    command: z.ZodLiteral<"publish">;
}, z.core.$strict>, z.ZodObject<{
    command: z.ZodLiteral<"complete">;
}, z.core.$strict>, z.ZodObject<{
    command: z.ZodLiteral<"deliver">;
}, z.core.$strict>, z.ZodObject<{
    command: z.ZodLiteral<"recover">;
}, z.core.$strict>, z.ZodObject<{
    command: z.ZodLiteral<"cleanup">;
    pullRequest: z.ZodNumber;
    mergedHead: z.ZodString;
}, z.core.$strict>, z.ZodObject<{
    command: z.ZodLiteral<"publish-specification">;
    target: z.ZodDiscriminatedUnion<[z.ZodObject<{
        kind: z.ZodLiteral<"new">;
    }, z.core.$strict>, z.ZodObject<{
        kind: z.ZodLiteral<"issue">;
        number: z.ZodNumber;
    }, z.core.$strict>], "kind">;
}, z.core.$strict>, z.ZodObject<{
    command: z.ZodLiteral<"publish-review">;
    pullRequest: z.ZodNumber;
    reviewedHead: z.ZodString;
    reviewDigest: z.ZodOptional<z.ZodString>;
}, z.core.$strict>], "command">;
export type CommandScopeEntry = z.infer<typeof CommandScopeEntrySchema>;
declare function buildGrantSchema(grantScheme: string, ticketPattern: RegExp): z.ZodObject<{
    schema: z.ZodLiteral<string>;
    grantId: z.ZodString;
    nonce: z.ZodString;
    repository: z.ZodString;
    ticket: z.ZodString;
    issue: z.ZodOptional<z.ZodNumber>;
    specDigest: z.ZodString;
    mode: z.ZodEnum<{
        audit: "audit";
        command: "command";
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
    scope: z.ZodOptional<z.ZodObject<{
        version: z.ZodLiteral<1>;
        commands: z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
            command: z.ZodLiteral<"publish">;
        }, z.core.$strict>, z.ZodObject<{
            command: z.ZodLiteral<"complete">;
        }, z.core.$strict>, z.ZodObject<{
            command: z.ZodLiteral<"deliver">;
        }, z.core.$strict>, z.ZodObject<{
            command: z.ZodLiteral<"recover">;
        }, z.core.$strict>, z.ZodObject<{
            command: z.ZodLiteral<"cleanup">;
            pullRequest: z.ZodNumber;
            mergedHead: z.ZodString;
        }, z.core.$strict>, z.ZodObject<{
            command: z.ZodLiteral<"publish-specification">;
            target: z.ZodDiscriminatedUnion<[z.ZodObject<{
                kind: z.ZodLiteral<"new">;
            }, z.core.$strict>, z.ZodObject<{
                kind: z.ZodLiteral<"issue">;
                number: z.ZodNumber;
            }, z.core.$strict>], "kind">;
        }, z.core.$strict>, z.ZodObject<{
            command: z.ZodLiteral<"publish-review">;
            pullRequest: z.ZodNumber;
            reviewedHead: z.ZodString;
            reviewDigest: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>], "command">>;
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
    specification?: {
        ticketId: string;
        digest: string;
        digestMatches: boolean;
    } | null;
    baseSha?: string;
    candidateSha?: string;
    branch?: string;
    pullRequest?: {
        number: number;
        headSha: string;
        open: boolean;
        merged: boolean;
    };
    /** publish-specification: the specification about to be published and its destination. */
    publishing?: {
        ticketId: string;
        digest: string;
        issue: number | null;
    };
    /** publish-review: the review about to be published. */
    review?: {
        pullRequest: number;
        reviewedHead: string;
        digest: string;
    };
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
    authorizeCommand(raw: unknown, trusted: TrustedKey[], context: CommandContext, now: Date): CommandAuthorization;
}
export declare function createGrantProtocol(config: GrantProtocolConfig): GrantProtocol;
export declare function requireCapability(grant: Grant, capability: Capability, why: string): void;
/** Stable identifier for evidence: the hash of the canonical envelope. */
export declare function envelopeDigest(envelope: GrantEnvelope): string;
export {};
