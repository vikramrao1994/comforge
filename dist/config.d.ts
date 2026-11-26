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
/** Writes outside the SDK, each through one audited host adapter; never granted by default. */
export declare const HOST_CAPABILITIES: readonly ["pulls:assign"];
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
    security: z.ZodDefault<z.ZodObject<{
        capabilities: z.ZodDefault<z.ZodArray<z.ZodEnum<{
            "issues:comment": "issues:comment";
            "pulls:assign": "pulls:assign";
            "pulls:create": "pulls:create";
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
export declare const TRUSTED_SECTIONS: readonly ["schema", "repository", "tickets", "validation", "specification", "completion", "security"];
export declare function parseConfig(text: string, source: string): ComforgeConfig;
/** The working tree's configuration (candidate text: guidance and local settings only). */
export declare function readWorkingConfig(root: string): ComforgeConfig;
export declare const trustedPart: (config: ComforgeConfig) => {
    [k: string]: "comforge-config/v1" | {
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
        capabilities: ("issues:comment" | "pulls:assign" | "pulls:create" | "pulls:update")[];
        authorization: {
            mode: "owner-grant";
            grantScheme: string;
            trustedKeys: {
                keyId: string;
                publicKeyPem: string;
                label: string;
            }[];
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
/** Trusted sections in which `candidate` differs from `trusted`. */
export declare function trustedChanges(trusted: ComforgeConfig, candidate: ComforgeConfig): string[];
/** The JSON Schema of the configuration, for editors and agents (`comforge schema config`). */
export declare function configJsonSchema(): unknown;
