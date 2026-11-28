import { z } from "zod";
/**
 * `comforge.config.json`: one versioned, strictly validated file at the repository root.
 *
 * Trust: configuration is repository text and grants nothing by being present. The sections
 * that decide where and how the CLI writes, what it validates and which identities it trusts
 * (`TRUSTED_SECTIONS`) are read from the base revision an initiative started from, i.e. what
 * the owner already merged, never from the candidate's working tree. A candidate that changes
 * any of them is refused for publication (`untrusted-config-change`) until the owner merges
 * the change by other means. Unknown keys and unknown versions fail closed everywhere.
 *
 * The file never holds a credential: `security.credentials` names where a token comes from
 * (an environment variable or the `gh` login), and the token itself is read per process,
 * held in memory and never written, logged or passed to a child process.
 */
export declare const CONFIG_FILE = "comforge.config.json";
export declare const CONFIG_SCHEMA = "comforge-config/v1";
/** Capabilities the CLI can use; each maps to exactly one @comforge/github write kind. */
export declare const CLI_CAPABILITIES: readonly ["pulls:create", "pulls:update", "issues:comment"];
/**
 * Writes outside the SDK, each through one audited host adapter; never granted by default.
 * `pulls:assign` assigns the configured login; `pulls:ready` marks the pull request this
 * command published ready for review (GitHub's REST API cannot); `branches:delete` deletes an
 * initiative's own merged branch under a lease during cleanup.
 */
export declare const HOST_CAPABILITIES: readonly ["pulls:assign", "pulls:ready", "branches:delete"];
/**
 * SDK writes of the governance services (specification publication), never granted by default:
 * a repository opts in by listing them, and owner-grant mode still needs a scoped grant.
 */
export declare const GOVERNANCE_CAPABILITIES: readonly ["issues:create", "issues:update"];
/**
 * A canonical repository path: `/`-separated, no empty, `.` or `..` segment, no backslash, no
 * control character, no leading or trailing slash. Prefix matching is only sound on paths in
 * this one spelling; anything else is refused rather than normalized.
 */
export declare function isCanonicalRepoPath(p: unknown): p is string;
export declare const SECTION_DEFAULTS: {
    readonly review: null;
    readonly discussion: null;
    readonly artifacts: {
        readable: string[];
    };
    readonly state: {
        writeLedgerDirectory: string;
        legacy: {
            directory: string;
            format: "agent-lifecycle/v1";
        } | null;
    };
    readonly lifecycle: {
        remotePreflight: boolean;
        phaseRequiresCleanParent: boolean;
    };
    readonly verification: {
        snapshot: boolean;
        unavailableExitStatuses: number[];
        summary: {
            path: string;
            maxBytes: number;
        } | null;
        optional: {
            name: string;
            run: string[];
        }[];
    };
    readonly publication: {
        checks: {
            name: string;
            run: string[];
        }[];
        bodyCommand: string[] | null;
        marker: boolean;
        draftFirst: boolean;
        linkMarkerNamespace: string;
        reportPullRequestReason: string | null;
    };
    readonly cleanup: {
        deleteRemoteBranch: boolean;
        deleteLocalBranch: boolean;
        fastForwardPrimary: boolean;
        after: {
            name: string;
            run: string[];
        }[];
    };
};
export declare const ConfigSchema: z.ZodObject<{
    $schema: z.ZodOptional<z.ZodString>;
    schema: z.ZodLiteral<"comforge-config/v1">;
    repository: z.ZodObject<{
        owner: z.ZodString;
        name: z.ZodString;
        baseBranch: z.ZodDefault<z.ZodString>;
        remote: z.ZodDefault<z.ZodString>;
        apiOrigin: z.ZodDefault<z.ZodString>;
        webOrigin: z.ZodDefault<z.ZodString>;
    }, z.core.$strict>;
    tickets: z.ZodDefault<z.ZodObject<{
        pattern: z.ZodDefault<z.ZodString>;
        branchPrefix: z.ZodDefault<z.ZodString>;
    }, z.core.$strict>>;
    checkout: z.ZodDefault<z.ZodObject<{
        parent: z.ZodOptional<z.ZodString>;
        provision: z.ZodDefault<z.ZodArray<z.ZodArray<z.ZodString>>>;
    }, z.core.$strict>>;
    validation: z.ZodObject<{
        commands: z.ZodArray<z.ZodObject<{
            name: z.ZodString;
            run: z.ZodArray<z.ZodString>;
        }, z.core.$strict>>;
        timeoutSeconds: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strict>;
    evidence: z.ZodDefault<z.ZodObject<{
        reportDir: z.ZodDefault<z.ZodString>;
    }, z.core.$strict>>;
    commits: z.ZodDefault<z.ZodObject<{
        trailer: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    }, z.core.$strict>>;
    specification: z.ZodDefault<z.ZodNullable<z.ZodObject<{
        required: z.ZodDefault<z.ZodBoolean>;
        digestScheme: z.ZodString;
        markerNamespace: z.ZodString;
        publisherName: z.ZodString;
        publishToolName: z.ZodString;
    }, z.core.$strict>>>;
    completion: z.ZodDefault<z.ZodNullable<z.ZodObject<{
        scheme: z.ZodString;
        markerNamespace: z.ZodString;
        runner: z.ZodObject<{
            id: z.ZodString;
            label: z.ZodString;
        }, z.core.$strict>;
        publishCommand: z.ZodDefault<z.ZodString>;
    }, z.core.$strict>>>;
    context: z.ZodDefault<z.ZodNullable<z.ZodObject<{
        manifest: z.ZodString;
    }, z.core.$strict>>>;
    state: z.ZodDefault<z.ZodObject<{
        writeLedgerDirectory: z.ZodDefault<z.ZodString>;
        legacy: z.ZodDefault<z.ZodNullable<z.ZodObject<{
            directory: z.ZodString;
            format: z.ZodLiteral<"agent-lifecycle/v1">;
        }, z.core.$strict>>>;
    }, z.core.$strict>>;
    lifecycle: z.ZodDefault<z.ZodObject<{
        remotePreflight: z.ZodDefault<z.ZodBoolean>;
        phaseRequiresCleanParent: z.ZodDefault<z.ZodBoolean>;
    }, z.core.$strict>>;
    verification: z.ZodDefault<z.ZodObject<{
        snapshot: z.ZodDefault<z.ZodBoolean>;
        unavailableExitStatuses: z.ZodDefault<z.ZodArray<z.ZodNumber>>;
        summary: z.ZodDefault<z.ZodNullable<z.ZodObject<{
            path: z.ZodString;
            maxBytes: z.ZodDefault<z.ZodNumber>;
        }, z.core.$strict>>>;
        optional: z.ZodDefault<z.ZodArray<z.ZodObject<{
            name: z.ZodString;
            run: z.ZodArray<z.ZodString>;
        }, z.core.$strict>>>;
    }, z.core.$strict>>;
    publication: z.ZodDefault<z.ZodObject<{
        checks: z.ZodDefault<z.ZodArray<z.ZodObject<{
            name: z.ZodString;
            run: z.ZodArray<z.ZodString>;
        }, z.core.$strict>>>;
        bodyCommand: z.ZodDefault<z.ZodNullable<z.ZodArray<z.ZodString>>>;
        marker: z.ZodDefault<z.ZodBoolean>;
        draftFirst: z.ZodDefault<z.ZodBoolean>;
        linkMarkerNamespace: z.ZodDefault<z.ZodString>;
        reportPullRequestReason: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    }, z.core.$strict>>;
    cleanup: z.ZodDefault<z.ZodObject<{
        deleteRemoteBranch: z.ZodDefault<z.ZodBoolean>;
        deleteLocalBranch: z.ZodDefault<z.ZodBoolean>;
        fastForwardPrimary: z.ZodDefault<z.ZodBoolean>;
        after: z.ZodDefault<z.ZodArray<z.ZodObject<{
            name: z.ZodString;
            run: z.ZodArray<z.ZodString>;
        }, z.core.$strict>>>;
    }, z.core.$strict>>;
    review: z.ZodDefault<z.ZodNullable<z.ZodObject<{
        reviewScheme: z.ZodString;
        markerNamespace: z.ZodString;
        publisherName: z.ZodString;
        publishToolName: z.ZodString;
        trustedAuthors: z.ZodDefault<z.ZodArray<z.ZodString>>;
    }, z.core.$strict>>>;
    discussion: z.ZodDefault<z.ZodNullable<z.ZodObject<{
        scheme: z.ZodString;
        markerNamespace: z.ZodString;
        publisherName: z.ZodString;
        publishToolName: z.ZodString;
    }, z.core.$strict>>>;
    artifacts: z.ZodDefault<z.ZodObject<{
        readable: z.ZodDefault<z.ZodArray<z.ZodString & z.ZodType<string, string, z.core.$ZodTypeInternals<string, string>>>>;
    }, z.core.$strict>>;
    security: z.ZodDefault<z.ZodObject<{
        capabilities: z.ZodDefault<z.ZodArray<z.ZodEnum<{
            "branches:delete": "branches:delete";
            "issues:comment": "issues:comment";
            "issues:create": "issues:create";
            "issues:update": "issues:update";
            "pulls:assign": "pulls:assign";
            "pulls:create": "pulls:create";
            "pulls:ready": "pulls:ready";
            "pulls:update": "pulls:update";
        }>>>;
        authorization: z.ZodDefault<z.ZodNullable<z.ZodDiscriminatedUnion<[z.ZodObject<{
            mode: z.ZodLiteral<"owner-grant">;
            grantScheme: z.ZodString;
            trustedKeys: z.ZodArray<z.ZodObject<{
                keyId: z.ZodString;
                publicKeyPem: z.ZodString;
                label: z.ZodString;
            }, z.core.$strict>>;
            revokedGrants: z.ZodOptional<z.ZodArray<z.ZodString>>;
        }, z.core.$strict>, z.ZodObject<{
            mode: z.ZodLiteral<"operator">;
        }, z.core.$strict>], "mode">>>;
        ledgerNamespace: z.ZodDefault<z.ZodString>;
        markerNamespace: z.ZodDefault<z.ZodString>;
        credentials: z.ZodDefault<z.ZodDiscriminatedUnion<[z.ZodObject<{
            source: z.ZodLiteral<"env">;
            variable: z.ZodString;
        }, z.core.$strict>, z.ZodObject<{
            source: z.ZodLiteral<"gh">;
        }, z.core.$strict>], "source">>;
        delivery: z.ZodDefault<z.ZodObject<{
            assignee: z.ZodDefault<z.ZodNullable<z.ZodString>>;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
}, z.core.$strict>;
export type ComforgeConfig = z.infer<typeof ConfigSchema>;
export type ConfigInput = z.input<typeof ConfigSchema>;
/** Sections a candidate revision may not change for its own publication. */
export declare const TRUSTED_SECTIONS: readonly ["schema", "repository", "tickets", "validation", "specification", "completion", "security", "state", "lifecycle", "verification", "publication", "cleanup", "review", "discussion", "artifacts"];
export declare function parseConfig(text: string, source: string): ComforgeConfig;
/** The working tree's configuration (candidate text: guidance and local settings only). */
export declare function readWorkingConfig(root: string): ComforgeConfig;
export declare const trustedPart: (config: ComforgeConfig) => {
    [k: string]: "comforge-config/v1" | {
        readable: string[];
    } | {
        writeLedgerDirectory: string;
        legacy: {
            directory: string;
            format: "agent-lifecycle/v1";
        } | null;
    } | {
        remotePreflight: boolean;
        phaseRequiresCleanParent: boolean;
    } | {
        snapshot: boolean;
        unavailableExitStatuses: number[];
        summary: {
            path: string;
            maxBytes: number;
        } | null;
        optional: {
            name: string;
            run: string[];
        }[];
    } | {
        checks: {
            name: string;
            run: string[];
        }[];
        bodyCommand: string[] | null;
        marker: boolean;
        draftFirst: boolean;
        linkMarkerNamespace: string;
        reportPullRequestReason: string | null;
    } | {
        deleteRemoteBranch: boolean;
        deleteLocalBranch: boolean;
        fastForwardPrimary: boolean;
        after: {
            name: string;
            run: string[];
        }[];
    } | {
        pattern: string;
        branchPrefix: string;
    } | {
        required: boolean;
        digestScheme: string;
        markerNamespace: string;
        publisherName: string;
        publishToolName: string;
    } | {
        scheme: string;
        markerNamespace: string;
        runner: {
            id: string;
            label: string;
        };
        publishCommand: string;
    } | {
        reviewScheme: string;
        markerNamespace: string;
        publisherName: string;
        publishToolName: string;
        trustedAuthors: string[];
    } | {
        scheme: string;
        markerNamespace: string;
        publisherName: string;
        publishToolName: string;
    } | {
        capabilities: ("branches:delete" | "issues:comment" | "issues:create" | "issues:update" | "pulls:assign" | "pulls:create" | "pulls:ready" | "pulls:update")[];
        authorization: {
            mode: "owner-grant";
            grantScheme: string;
            trustedKeys: {
                keyId: string;
                publicKeyPem: string;
                label: string;
            }[];
            revokedGrants?: string[] | undefined;
        } | {
            mode: "operator";
        } | null;
        ledgerNamespace: string;
        markerNamespace: string;
        credentials: {
            source: "env";
            variable: string;
        } | {
            source: "gh";
        };
        delivery: {
            assignee: string | null;
        };
    } | {
        owner: string;
        name: string;
        baseBranch: string;
        remote: string;
        apiOrigin: string;
        webOrigin: string;
    } | {
        commands: {
            name: string;
            run: string[];
        }[];
        timeoutSeconds: number;
    } | null;
};
/**
 * The path prefixes a remote reader may fetch. The default (an empty `artifacts.readable`) is the
 * report directory, so the effective set is what is compared and authorized, never the raw list.
 */
export declare const readableArtifacts: (config: ComforgeConfig) => readonly string[];
/**
 * Trusted sections in which `candidate` differs from `trusted`. `artifacts` is also reported when
 * only its effective default moved (an `evidence.reportDir` edit widens what may be read).
 */
export declare function trustedChanges(trusted: ComforgeConfig, candidate: ComforgeConfig): string[];
/** The JSON Schema of the configuration, for editors and agents (`comforge schema config`). */
export declare function configJsonSchema(): unknown;
