/**
 * The tool contracts of comforge-mcp: names, the profiles that may discover and call each
 * tool, whether it executes repository commands, and strict versioned input schemas.
 *
 * Every input object is `.strict()`: an unknown field (a forged internal option such as
 * `authorized`, a path, a URL, a credential, a runtime adapter) is refused before a handler
 * runs. A repository is named by its allowlisted id, never by a path.
 */
import { z } from "zod";
export declare const RESULT_SCHEMA = "comforge-mcp/v1";
export declare const ERROR_SCHEMA = "comforge-mcp-error/v1";
export declare const CAPABILITIES_SCHEMA = "comforge-mcp-capabilities/v1";
export declare const PROFILES: readonly ["read-only", "reviewer", "executor", "publisher"];
export type Profile = (typeof PROFILES)[number];
/** Bounds every response is held to. Larger detail is paginated, never silently dropped. */
export declare const LIMITS: {
    /** Serialized size of one tool result's structured content. */
    readonly maxResultChars: 48000;
    /** One untrusted text field (issue body, review body, patch) unless detail is requested. */
    readonly excerptChars: 2000;
    /** One untrusted text field when detail is requested. */
    readonly detailChars: 20000;
    readonly pageSize: 10;
    readonly maxPageSize: 50;
    /** Serialized size of a deliver result document. */
    readonly maxResultDocumentChars: 200000;
};
/** An owner-signed grant envelope, verified by @comforge/cli against the trusted keys. */
export declare const GrantEnvelope: z.ZodObject<{
    grant: z.ZodRecord<z.ZodString, z.ZodUnknown>;
    keyId: z.ZodString;
    signature: z.ZodString;
}, z.core.$strict>;
export declare const INPUTS: {
    readonly comforge_capabilities: z.ZodObject<{}, z.core.$strict>;
    readonly comforge_context: z.ZodObject<{
        repository: z.ZodString;
        task: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>;
    readonly comforge_status: z.ZodObject<{
        repository: z.ZodString;
        initiative: z.ZodOptional<z.ZodString>;
        cursor: z.ZodOptional<z.ZodString>;
        pageSize: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>;
    readonly comforge_evidence: z.ZodObject<{
        repository: z.ZodString;
        initiative: z.ZodString;
        section: z.ZodEnum<{
            completions: "completions";
            operations: "operations";
            publications: "publications";
            revisions: "revisions";
            validations: "validations";
        }>;
        cursor: z.ZodOptional<z.ZodString>;
        pageSize: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>;
    readonly comforge_issue: z.ZodObject<{
        repository: z.ZodString;
        number: z.ZodOptional<z.ZodNumber>;
        state: z.ZodOptional<z.ZodEnum<{
            all: "all";
            closed: "closed";
            open: "open";
        }>>;
        detail: z.ZodOptional<z.ZodBoolean>;
        cursor: z.ZodOptional<z.ZodString>;
        pageSize: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>;
    readonly comforge_pr: z.ZodObject<{
        repository: z.ZodString;
        number: z.ZodNumber;
        include: z.ZodOptional<z.ZodArray<z.ZodEnum<{
            checks: "checks";
            files: "files";
            reviews: "reviews";
        }>>>;
        expectedHeadSha: z.ZodOptional<z.ZodString>;
        cursor: z.ZodOptional<z.ZodString>;
        pageSize: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>;
    readonly comforge_start: z.ZodObject<{
        repository: z.ZodString;
        initiative: z.ZodString;
        issue: z.ZodOptional<z.ZodNumber>;
        expectDigest: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>;
    readonly comforge_revise: z.ZodObject<{
        repository: z.ZodString;
        pr: z.ZodNumber;
        reviewedHead: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>;
    readonly comforge_verify: z.ZodObject<{
        repository: z.ZodString;
        initiative: z.ZodString;
        commit: z.ZodOptional<z.ZodString>;
        with: z.ZodOptional<z.ZodArray<z.ZodString>>;
    }, z.core.$strict>;
    readonly comforge_deliver: z.ZodObject<{
        repository: z.ZodString;
        initiative: z.ZodString;
        title: z.ZodString;
        result: z.ZodRecord<z.ZodString, z.ZodUnknown>;
        closes: z.ZodOptional<z.ZodNumber>;
        draft: z.ZodOptional<z.ZodBoolean>;
        withoutPullRequest: z.ZodOptional<z.ZodBoolean>;
        execute: z.ZodBoolean;
        grant: z.ZodOptional<z.ZodObject<{
            grant: z.ZodRecord<z.ZodString, z.ZodUnknown>;
            keyId: z.ZodString;
            signature: z.ZodString;
        }, z.core.$strict>>;
    }, z.core.$strict>;
    readonly comforge_recover: z.ZodObject<{
        repository: z.ZodString;
        initiative: z.ZodString;
        execute: z.ZodBoolean;
        abandon: z.ZodOptional<z.ZodBoolean>;
        grant: z.ZodOptional<z.ZodObject<{
            grant: z.ZodRecord<z.ZodString, z.ZodUnknown>;
            keyId: z.ZodString;
            signature: z.ZodString;
        }, z.core.$strict>>;
    }, z.core.$strict>;
    readonly comforge_cleanup: z.ZodObject<{
        repository: z.ZodString;
        target: z.ZodString;
        execute: z.ZodBoolean;
        allowMissingCompletion: z.ZodOptional<z.ZodBoolean>;
        grant: z.ZodOptional<z.ZodObject<{
            grant: z.ZodRecord<z.ZodString, z.ZodUnknown>;
            keyId: z.ZodString;
            signature: z.ZodString;
        }, z.core.$strict>>;
    }, z.core.$strict>;
    readonly comforge_prs: z.ZodObject<{
        repository: z.ZodString;
        state: z.ZodOptional<z.ZodEnum<{
            all: "all";
            closed: "closed";
            open: "open";
        }>>;
        cursor: z.ZodOptional<z.ZodString>;
        pageSize: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>;
    readonly comforge_comments: z.ZodObject<{
        repository: z.ZodString;
        number: z.ZodNumber;
        detail: z.ZodOptional<z.ZodBoolean>;
        cursor: z.ZodOptional<z.ZodString>;
        pageSize: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>;
    readonly comforge_reviews: z.ZodObject<{
        repository: z.ZodString;
        pr: z.ZodNumber;
        cursor: z.ZodOptional<z.ZodString>;
        pageSize: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>;
    readonly comforge_artifact: z.ZodObject<{
        repository: z.ZodString;
        commit: z.ZodString;
        path: z.ZodString;
    }, z.core.$strict>;
    readonly comforge_publish_review: z.ZodObject<{
        repository: z.ZodString;
        review: z.ZodRecord<z.ZodString, z.ZodUnknown>;
        execute: z.ZodBoolean;
        grant: z.ZodOptional<z.ZodObject<{
            grant: z.ZodRecord<z.ZodString, z.ZodUnknown>;
            keyId: z.ZodString;
            signature: z.ZodString;
        }, z.core.$strict>>;
    }, z.core.$strict>;
    readonly comforge_publish_specification: z.ZodObject<{
        repository: z.ZodString;
        ticket: z.ZodString;
        title: z.ZodString;
        body: z.ZodString;
        issue: z.ZodOptional<z.ZodNumber>;
        idempotencyKey: z.ZodOptional<z.ZodString>;
        execute: z.ZodBoolean;
        grant: z.ZodOptional<z.ZodObject<{
            grant: z.ZodRecord<z.ZodString, z.ZodUnknown>;
            keyId: z.ZodString;
            signature: z.ZodString;
        }, z.core.$strict>>;
    }, z.core.$strict>;
};
export type ToolName = keyof typeof INPUTS;
export declare const TOOL_NAMES: ToolName[];
export interface ToolContract {
    name: ToolName;
    title: string;
    description: string;
    /** The least profile that may discover and call the tool. */
    profiles: readonly Profile[];
    /** Runs repository commands (clone, validation, push): needs local trust or host isolation. */
    executes: boolean;
    /** May write to GitHub when `execute: true`. */
    writes: boolean;
    destructive: boolean;
}
/** Descriptions are deliberately short: they are paid for on every discovery. */
export declare const TOOLS: Readonly<Record<ToolName, ToolContract>>;
/** Reviewer reads patches and review bodies in detail; read-only gets summaries. */
export declare const DETAIL_PROFILES: readonly Profile[];
export interface Principal {
    /** Stable, non-secret identifier for audit and session binding. */
    id: string;
    profiles: readonly Profile[];
    /** Allowlisted repository ids this principal may use; "*" means every configured one. */
    repositories: readonly string[] | "*";
}
export declare const PrincipalSchema: z.ZodObject<{
    id: z.ZodString;
    profiles: z.ZodArray<z.ZodEnum<{
        executor: "executor";
        publisher: "publisher";
        "read-only": "read-only";
        reviewer: "reviewer";
    }>>;
    repositories: z.ZodUnion<readonly [z.ZodLiteral<"*">, z.ZodArray<z.ZodString>]>;
}, z.core.$strict>;
