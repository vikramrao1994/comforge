/**
 * `@comforge/cli/protocols`: the specification, advisory-review and completion protocols as
 * typed services bound to an explicit, versioned compatibility profile.
 *
 * The configuration-bound factories of the package root (`specificationProtocol(config)` and
 * friends) stay the default for a repository that adopts Comforge today. A profile is for a host
 * whose published records predate its configuration: it names every value that reaches a marker
 * or a digest, so those records keep verifying byte for byte.
 *
 * Serialization and policy are separate. A profile chooses only identity (schemes, marker
 * namespaces, publisher names, limits, links). What may be published is not a profile choice:
 * the record's own marker prefix is always reserved, and the built-in credential detector always
 * runs. A host can add a detector, never remove the floor.
 */
import { type CompletionGate, type CompletionInput, type CompletionIntegrity, type CompletionMarker, type CompletionPayload, type CompletionProtocol, type CreatePrReviewInput, canonicalBody, canonicalTitle, deriveDisposition, type IssueType, idempotencyKeyDigest, isReviewStale, type PublishedMarker, type Redaction, type ReviewIntegrity, type ReviewLimits, type ReviewMarker, type ReviewPayload, type ReviewProtocol, type ReviewProvenance, reviewProvenance, type SpecificationProtocol, type SpecificationVerification } from "@comforge/core";
import type { ComforgeConfig } from "./config.ts";
export declare const PROTOCOL_PROFILE_SCHEMA: "comforge-protocol-profile/v1";
export interface ProtocolProfile {
    /** The profile format. An unknown or older value is refused, never guessed. */
    schema: typeof PROTOCOL_PROFILE_SCHEMA;
    /** `owner/name`; part of every review and completion digest. */
    repository: string;
    ticketPattern: RegExp;
    specification?: {
        digestScheme: string;
        markerNamespace: string;
        publisherName: string;
        publishToolName: string;
    };
    review?: {
        reviewScheme: string;
        markerNamespace: string;
        publisherName: string;
        publishToolName: string;
        limits: ReviewLimits;
    };
    completion?: {
        scheme: string;
        markerNamespace: string;
        /**
         * Marker prefixes a result's text may not contain, in addition to the ones every profile
         * reserves (the completion's own and the specification's). Additions only.
         */
        alsoReserved?: readonly string[];
        runner: {
            id: string;
            label: string;
        };
        publishCommand: string;
        links: {
            comment(issueNumber: number, commentId: number): string;
            blob(commit: string, path: string): string;
        };
        /**
         * A further credential detector. The built-in one always runs: a text either detector flags
         * is refused. When both flag it, this detector's kinds are the ones reported.
         */
        detectSecrets?: (text: string) => Redaction;
    };
}
type Section<P extends ProtocolProfile, K extends "specification" | "review" | "completion", T> = undefined extends P[K] ? T | null : T;
/**
 * A protocol is `null` exactly when the profile has no section for it. A profile written as a
 * literal gets exact types; one typed as `ProtocolProfile` gets `T | null`.
 */
export interface ProtocolServices<P extends ProtocolProfile = ProtocolProfile> {
    readonly schema: typeof PROTOCOL_PROFILE_SCHEMA;
    readonly repository: string;
    readonly specification: Section<P, "specification", SpecificationProtocol>;
    readonly review: Section<P, "review", ReviewProtocol>;
    readonly completion: Section<P, "completion", CompletionProtocol>;
}
/** The protocols of one profile. Throws on a profile this version does not define. */
export declare function createProtocolServices<P extends ProtocolProfile>(profile: P): ProtocolServices<P>;
/**
 * The profile a trusted configuration describes: what the configuration-bound factories of the
 * package root use. Its completion links follow the configured web origin, and the security
 * marker namespace is reserved too.
 */
export declare function profileFromConfig(config: ComforgeConfig): ProtocolProfile;
/** Text canonicalization shared by every specification profile (scheme-independent). */
export declare const canonicalText: Readonly<{
    body: typeof canonicalBody;
    title: typeof canonicalTitle;
    idempotencyKeyDigest: typeof idempotencyKeyDigest;
}>;
/** Whether a review's author and reviewed head can be relied on; from the forge's own data. */
export declare const reviewTrust: Readonly<{
    isStale: typeof isReviewStale;
    provenance: typeof reviewProvenance;
}>;
/** The fixed vocabulary of an advisory review, the same under every profile. */
export declare const REVIEW_VOCABULARY: Readonly<{
    notice: string;
    findingIdPattern: RegExp;
    severities: readonly ["critical", "high", "medium", "low", "info"];
    verdicts: readonly ["no_blocking_findings", "revision_recommended", "insufficient_evidence"];
}>;
/** The fixed vocabulary of a completion result, the same under every profile. */
export declare const COMPLETION_VOCABULARY: Readonly<{
    limits: {
        readonly summaryMaxChars: 3000;
        readonly sectionMaxChars: 3000;
        readonly findingsMax: 30;
        readonly findingTitleMaxChars: 200;
        readonly findingTextMaxChars: 2000;
        readonly gatesMax: 20;
        readonly gateTextMaxChars: 300;
        readonly pathsMax: 50;
        readonly pathMaxChars: 200;
        readonly notesMax: 15;
        readonly noteMaxChars: 800;
        readonly commentMaxChars: 65000;
    };
    notice: string;
    confidences: readonly ["high", "medium", "low"];
    dispositions: readonly ["open_until_merge", "owner_may_close", "leave_open"];
    gateStatuses: readonly ["PASS", "FAIL", "UNAVAILABLE", "SKIPPED"];
    issueTypes: ["architecture" | "architecture_audit" | "audit" | "bug_fix" | "experiment" | "implementation" | "investigation" | "refactor" | "security_audit", ...("architecture" | "architecture_audit" | "audit" | "bug_fix" | "experiment" | "implementation" | "investigation" | "refactor" | "security_audit")[]];
    issueTypeMatrix: {
        readonly audit: {
            readonly family: "audit";
            readonly sections: readonly ["verdict", "recommendations"];
            readonly pr: "on_request";
        };
        readonly security_audit: {
            readonly family: "audit";
            readonly sections: readonly ["verdict", "recommendations"];
            readonly pr: "on_request";
        };
        readonly architecture_audit: {
            readonly family: "audit";
            readonly sections: readonly ["verdict", "recommendations"];
            readonly pr: "on_request";
        };
        readonly investigation: {
            readonly family: "investigation";
            readonly sections: readonly ["reproduction", "observations", "root_cause", "recommendation"];
            readonly pr: "on_request";
        };
        readonly architecture: {
            readonly family: "architecture";
            readonly sections: readonly ["options", "tradeoffs", "decision", "rationale"];
            readonly pr: "on_request";
        };
        readonly implementation: {
            readonly family: "implementation";
            readonly sections: readonly ["changed_behavior"];
            readonly pr: "required";
        };
        readonly bug_fix: {
            readonly family: "implementation";
            readonly sections: readonly ["changed_behavior"];
            readonly pr: "required";
        };
        readonly refactor: {
            readonly family: "implementation";
            readonly sections: readonly ["changed_behavior"];
            readonly pr: "required";
        };
        readonly experiment: {
            readonly family: "experiment";
            readonly sections: readonly ["hypothesis", "method", "results"];
            readonly pr: "on_request";
        };
    };
    outcomes: readonly ["completed", "partial", "blocked", "failed"];
    sectionKeys: readonly ["verdict", "recommendations", "reproduction", "observations", "root_cause", "recommendation", "options", "tradeoffs", "decision", "rationale", "changed_behavior", "hypothesis", "method", "results"];
    deriveDisposition: typeof deriveDisposition;
}>;
export type { CompletionGate, CompletionInput, CompletionIntegrity, CompletionMarker, CompletionPayload, CompletionProtocol, CreatePrReviewInput, IssueType, PublishedMarker, Redaction, ReviewIntegrity, ReviewLimits, ReviewMarker, ReviewPayload, ReviewProtocol, ReviewProvenance, SpecificationProtocol, SpecificationVerification, };
