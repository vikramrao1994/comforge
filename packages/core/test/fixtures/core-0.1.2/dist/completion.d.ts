import { z } from "zod";
/**
 * Issue completion records: input contract, consistency and content rules, canonical
 * payload, digest, rendering and marker decoding. Pure: no I/O, no environment, no
 * clock. Secret detection and link formats are supplied by the caller.
 *
 * A ticket reports its outcome as one comment on its issue: a human-readable rendering
 * plus one hidden marker carrying the structured result:
 *
 *   <!-- <namespace>:completion v1 issue=<n> ticket=<id> digest=<64 hex> payload=<base64url JSON> -->
 *
 * digest = SHA-256 of `<completionScheme>\n` + the payload JSON (schema field order,
 * so the JSON is its own canonical form). A reader recomputes it, so an edited payload
 * reads as `integrity: "mismatch"`. An earlier result is never edited: a new record
 * lists what it supersedes.
 *
 * The marker is unkeyed: anyone who can comment can forge one. Integrity says nothing
 * about the author; which author's record counts, and which record is current, is the
 * caller's trusted decision. A completion record reports work; it never approves,
 * merges, deploys, closes an issue or authorizes execution.
 */
export declare const COMPLETION_NOTICE: string;
/**
 * Issue type → what a `completed` result must contain and whether a pull request
 * is the deliverable. `pr: "required"` applies to completed and partial results;
 * `pr: "on_request"` means a PR may be linked only with the explicit request
 * that asked for it (`pullRequest.reason`).
 */
export declare const ISSUE_TYPE_MATRIX: {
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
export type IssueType = keyof typeof ISSUE_TYPE_MATRIX;
export declare const ISSUE_TYPES: [IssueType, ...IssueType[]];
export declare const SECTION_KEYS: readonly ["verdict", "recommendations", "reproduction", "observations", "root_cause", "recommendation", "options", "tradeoffs", "decision", "rationale", "changed_behavior", "hypothesis", "method", "results"];
export declare const OUTCOMES: readonly ["completed", "partial", "blocked", "failed"];
export declare const GATE_STATUSES: readonly ["PASS", "FAIL", "UNAVAILABLE", "SKIPPED"];
export declare const CONFIDENCES: readonly ["high", "medium", "low"];
export declare const DISPOSITIONS: readonly ["open_until_merge", "owner_may_close", "leave_open"];
export declare const COMPLETION_LIMITS: {
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
/** Strict: an approval, merge, close, label or execution flag is rejected, never ignored. */
declare function buildInputSchema(completionScheme: string, ticketPattern: RegExp, runnerId: string): z.ZodObject<{
    contract: z.ZodLiteral<string>;
    issueNumber: z.ZodNumber;
    ticketId: z.ZodString;
    specificationDigest: z.ZodString;
    issueType: z.ZodEnum<{
        architecture: "architecture";
        architecture_audit: "architecture_audit";
        audit: "audit";
        bug_fix: "bug_fix";
        experiment: "experiment";
        implementation: "implementation";
        investigation: "investigation";
        refactor: "refactor";
        security_audit: "security_audit";
    }>;
    outcome: z.ZodEnum<{
        blocked: "blocked";
        completed: "completed";
        failed: "failed";
        partial: "partial";
    }>;
    sourceRevision: z.ZodString;
    pullRequest: z.ZodOptional<z.ZodObject<{
        number: z.ZodNumber;
        headSha: z.ZodString;
        reason: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>>;
    execution: z.ZodObject<{
        runner: z.ZodLiteral<string>;
        model: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>;
    summary: z.ZodString;
    sections: z.ZodDefault<z.ZodRecord<z.ZodEnum<{
        changed_behavior: "changed_behavior";
        decision: "decision";
        hypothesis: "hypothesis";
        method: "method";
        observations: "observations";
        options: "options";
        rationale: "rationale";
        recommendation: "recommendation";
        recommendations: "recommendations";
        reproduction: "reproduction";
        results: "results";
        root_cause: "root_cause";
        tradeoffs: "tradeoffs";
        verdict: "verdict";
    }> & z.core.$partial, z.ZodString>>;
    blocker: z.ZodOptional<z.ZodString>;
    findings: z.ZodDefault<z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        severity: z.ZodEnum<{
            critical: "critical";
            high: "high";
            info: "info";
            low: "low";
            medium: "medium";
        }>;
        confidence: z.ZodEnum<{
            high: "high";
            low: "low";
            medium: "medium";
        }>;
        title: z.ZodString;
        evidence: z.ZodString;
        recommendation: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>>>;
    changedArtifacts: z.ZodDefault<z.ZodArray<z.ZodString>>;
    evidence: z.ZodDefault<z.ZodArray<z.ZodObject<{
        path: z.ZodString;
        commit: z.ZodString;
    }, z.core.$strict>>>;
    validation: z.ZodDefault<z.ZodArray<z.ZodObject<{
        gate: z.ZodString;
        command: z.ZodOptional<z.ZodString>;
        status: z.ZodEnum<{
            FAIL: "FAIL";
            PASS: "PASS";
            SKIPPED: "SKIPPED";
            UNAVAILABLE: "UNAVAILABLE";
        }>;
        reason: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>>>;
    limitations: z.ZodDefault<z.ZodArray<z.ZodString>>;
    nextSteps: z.ZodDefault<z.ZodArray<z.ZodString>>;
}, z.core.$strict>;
declare const GateSchema: z.ZodObject<{
    gate: z.ZodString;
    command: z.ZodNullable<z.ZodString>;
    status: z.ZodEnum<{
        FAIL: "FAIL";
        PASS: "PASS";
        SKIPPED: "SKIPPED";
        UNAVAILABLE: "UNAVAILABLE";
    }>;
    reason: z.ZodNullable<z.ZodString>;
    source: z.ZodEnum<{
        "lifecycle-ledger": "lifecycle-ledger";
        reported: "reported";
    }>;
}, z.core.$strict>;
export type CompletionGate = z.infer<typeof GateSchema>;
declare function buildPayloadSchema(completionScheme: string, ticketPattern: RegExp): z.ZodObject<{
    scheme: z.ZodLiteral<string>;
    repository: z.ZodString;
    issueNumber: z.ZodNumber;
    ticketId: z.ZodString;
    specification: z.ZodObject<{
        digest: z.ZodString;
        digestVerified: z.ZodBoolean;
    }, z.core.$strict>;
    issueType: z.ZodEnum<{
        architecture: "architecture";
        architecture_audit: "architecture_audit";
        audit: "audit";
        bug_fix: "bug_fix";
        experiment: "experiment";
        implementation: "implementation";
        investigation: "investigation";
        refactor: "refactor";
        security_audit: "security_audit";
    }>;
    outcome: z.ZodEnum<{
        blocked: "blocked";
        completed: "completed";
        failed: "failed";
        partial: "partial";
    }>;
    disposition: z.ZodEnum<{
        leave_open: "leave_open";
        open_until_merge: "open_until_merge";
        owner_may_close: "owner_may_close";
    }>;
    sourceRevision: z.ZodString;
    pullRequest: z.ZodNullable<z.ZodObject<{
        number: z.ZodNumber;
        headSha: z.ZodString;
        reason: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>>;
    execution: z.ZodObject<{
        runner: z.ZodString;
        model: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>;
    summary: z.ZodString;
    sections: z.ZodArray<z.ZodObject<{
        key: z.ZodEnum<{
            changed_behavior: "changed_behavior";
            decision: "decision";
            hypothesis: "hypothesis";
            method: "method";
            observations: "observations";
            options: "options";
            rationale: "rationale";
            recommendation: "recommendation";
            recommendations: "recommendations";
            reproduction: "reproduction";
            results: "results";
            root_cause: "root_cause";
            tradeoffs: "tradeoffs";
            verdict: "verdict";
        }>;
        text: z.ZodString;
    }, z.core.$strict>>;
    blocker: z.ZodNullable<z.ZodString>;
    findings: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        severity: z.ZodEnum<{
            critical: "critical";
            high: "high";
            info: "info";
            low: "low";
            medium: "medium";
        }>;
        confidence: z.ZodEnum<{
            high: "high";
            low: "low";
            medium: "medium";
        }>;
        title: z.ZodString;
        evidence: z.ZodString;
        recommendation: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>>;
    changedArtifacts: z.ZodArray<z.ZodString>;
    evidence: z.ZodArray<z.ZodObject<{
        path: z.ZodString;
        commit: z.ZodString;
    }, z.core.$strict>>;
    validation: z.ZodArray<z.ZodObject<{
        gate: z.ZodString;
        command: z.ZodNullable<z.ZodString>;
        status: z.ZodEnum<{
            FAIL: "FAIL";
            PASS: "PASS";
            SKIPPED: "SKIPPED";
            UNAVAILABLE: "UNAVAILABLE";
        }>;
        reason: z.ZodNullable<z.ZodString>;
        source: z.ZodEnum<{
            "lifecycle-ledger": "lifecycle-ledger";
            reported: "reported";
        }>;
    }, z.core.$strict>>;
    limitations: z.ZodArray<z.ZodString>;
    nextSteps: z.ZodArray<z.ZodString>;
    supersedes: z.ZodArray<z.ZodNumber>;
}, z.core.$strict>;
export type CompletionInputSchemaType = ReturnType<typeof buildInputSchema>;
export type CompletionPayloadSchemaType = ReturnType<typeof buildPayloadSchema>;
export type CompletionInput = z.infer<CompletionInputSchemaType>;
export type CompletionPayload = z.infer<CompletionPayloadSchemaType>;
export interface CompletionMarker {
    issueNumber: number;
    ticketId: string;
    digest: string;
    payload: string;
}
export type CompletionIntegrity = "verified" | "mismatch" | "unreadable";
/** What a secret detector reports for one value; the caller supplies the detector. */
export interface Redaction {
    count: number;
    kinds: readonly string[];
}
/** Trusted, construction-time identity and policy, supplied from committed code. */
export interface CompletionProtocolConfig {
    completionScheme: string;
    repository: string;
    markerNamespace: string;
    ticketPattern: RegExp;
    /** Every server marker prefix client text may not contain; must include `<markerNamespace>:`. */
    reservedMarkerPrefixes: readonly string[];
    /** The one runner a result may name, and how the rendering describes it. */
    runner: {
        id: string;
        label: string;
    };
    /** The command shown as the publisher in the footer. */
    publishCommand: string;
    /** Forge link formats for rendering; display only. */
    links: {
        comment(issueNumber: number, commentId: number): string;
        blob(commit: string, path: string): string;
    };
    /** Pure secret detector. Any value it flags makes the text unpublishable. */
    redact(value: string): Redaction;
}
export interface CompletionProtocol {
    readonly scheme: string;
    readonly repository: string;
    readonly markerPrefix: string;
    readonly inputSchema: CompletionInputSchemaType;
    readonly payloadSchema: CompletionPayloadSchemaType;
    completionTexts(input: CompletionInput): string[];
    /** Model-produced text is untrusted: no hidden content, forged markers, local paths, secrets or mentions. */
    contentProblems(input: CompletionInput): string[];
    /** The same rules over any text the caller will publish. */
    textProblems(values: readonly string[]): string[];
    /** Outcome/type consistency: a result may never claim more than its own fields support. */
    consistencyProblems(input: CompletionInput): string[];
    buildCompletionPayload(input: CompletionInput, context: {
        digestVerified: boolean;
        ledgerGates: CompletionGate[];
        supersedes: number[];
    }): CompletionPayload;
    serializeCompletionPayload(payload: CompletionPayload): string;
    completionDigest(serializedPayload: string): string;
    /** Equality of two results ignoring which earlier record each supersedes: the replay test. */
    sameResult(a: CompletionPayload, b: CompletionPayload): boolean;
    /** Display only: readers use the marker payload, never this rendering. */
    composeCompletionComment(payload: CompletionPayload): string;
    parseCompletionMarker(body: string | null | undefined): CompletionMarker | null;
    /** `verified`: the payload hashes to the marker digest and agrees with it. Says nothing about the author. */
    decodeCompletion(marker: CompletionMarker): {
        integrity: CompletionIntegrity;
        payload: CompletionPayload | null;
    };
}
export declare function deriveDisposition(issueType: IssueType, outcome: (typeof OUTCOMES)[number]): (typeof DISPOSITIONS)[number];
export declare function createCompletionProtocol(config: CompletionProtocolConfig): CompletionProtocol;
export {};
