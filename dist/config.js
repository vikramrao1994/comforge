import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { CliError, fail } from "./errors.js";
import { canonical } from "./json.js";
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
export const CONFIG_FILE = "comforge.config.json";
export const CONFIG_SCHEMA = "comforge-config/v1";
const NAME = z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/, "a GitHub owner or repository name");
const LOGIN = z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\[bot\])?$/, "a GitHub login");
const REF = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/, "a branch name");
const REL_PATH = z
    .string()
    .min(1)
    .max(300)
    .refine((p) => !path.isAbsolute(p) && !p.split(/[\\/]/).includes("..") && !p.includes("\0"), "a path inside the repository");
/** A command is an argument vector, never a shell string: nothing is interpolated. */
const COMMAND = z.array(z.string().min(1).max(4000)).min(1).max(100);
const ORIGIN = z
    .string()
    .url()
    .refine((u) => /^https:\/\//.test(u) || /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(u), {
    message: "https, or http on localhost for a local test server",
});
const ENV_NAME = z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/, "an environment variable name");
/** Capabilities the CLI can use; each maps to exactly one @comforge/github write kind. */
export const CLI_CAPABILITIES = ["pulls:create", "pulls:update", "issues:comment"];
/** Writes outside the SDK, each through one audited host adapter; never granted by default. */
export const HOST_CAPABILITIES = ["pulls:assign"];
export const ConfigSchema = z
    .object({
    $schema: z.string().max(500).optional(),
    schema: z.literal(CONFIG_SCHEMA),
    repository: z
        .object({
        owner: NAME,
        name: NAME,
        baseBranch: REF.default("main"),
        remote: z
            .string()
            .regex(/^[A-Za-z0-9._-]{1,100}$/)
            .default("origin"),
        apiOrigin: ORIGIN.default("https://api.github.com"),
        webOrigin: ORIGIN.default("https://github.com"),
    })
        .strict(),
    tickets: z
        .object({
        pattern: z
            .string()
            .max(300)
            .refine((p) => {
            if (!p.startsWith("^") || !p.endsWith("$"))
                return false;
            try {
                new RegExp(p);
                return true;
            }
            catch {
                return false;
            }
        }, "an anchored regular expression (^…$)")
            .default("^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+$"),
        branchPrefix: z
            .string()
            .regex(/^[a-z0-9][a-z0-9._-]*\/$/, "a lower-case prefix ending in /")
            .default("agent/"),
    })
        .strict()
        .default({ pattern: "^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+$", branchPrefix: "agent/" }),
    checkout: z
        .object({
        /** Where isolated checkouts are created, relative to the repository root. */
        parent: z.string().min(1).max(300).optional(),
        /** Run in each new checkout, in order, before anything else (e.g. install). */
        provision: z.array(COMMAND).max(20).default([]),
    })
        .strict()
        .default({ provision: [] }),
    validation: z
        .object({
        commands: z
            .array(z
            .object({ name: z.string().regex(/^[a-z0-9][a-z0-9:._-]{0,63}$/), run: COMMAND })
            .strict())
            .min(1)
            .max(20),
        timeoutSeconds: z.number().int().min(1).max(86_400).default(3600),
    })
        .strict(),
    evidence: z
        .object({
        /** Where reports and evidence of an initiative are committed. */
        reportDir: REL_PATH.default("docs/comforge"),
    })
        .strict()
        .default({ reportDir: "docs/comforge" }),
    commits: z
        .object({
        /** Every commit of an initiative carries `<trailer>: <TICKET>`; null to not require one. */
        trailer: z
            .string()
            .regex(/^[A-Z][A-Za-z-]{0,39}$/)
            .nullable()
            .default("Ticket"),
    })
        .strict()
        .default({ trailer: "Ticket" }),
    specification: z
        .object({
        /** When true, `start` needs `--issue N` naming a published, digest-verified specification. */
        required: z.boolean().default(true),
        digestScheme: z.string().regex(/^[a-z0-9][a-z0-9.-]{0,63}\/v\d+$/),
        markerNamespace: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/),
        publisherName: z.string().min(1).max(80),
        publishToolName: z.string().regex(/^[a-z0-9_]{1,64}$/),
    })
        .strict()
        .nullable()
        .default(null),
    completion: z
        .object({
        scheme: z.string().regex(/^[a-z0-9][a-z0-9.-]{0,63}\/v\d+$/),
        markerNamespace: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/),
        runner: z
            .object({
            id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/),
            label: z.string().min(1).max(80),
        })
            .strict(),
        publishCommand: z.string().min(1).max(120).default("comforge complete"),
    })
        .strict()
        .nullable()
        .default(null),
    context: z.object({ manifest: REL_PATH }).strict().nullable().default(null),
    security: z
        .object({
        capabilities: z
            .array(z.enum([...CLI_CAPABILITIES, ...HOST_CAPABILITIES]))
            .max(CLI_CAPABILITIES.length + HOST_CAPABILITIES.length)
            .default([...CLI_CAPABILITIES]),
        /**
         * Who authorizes GitHub writes. Absent: every write is refused. `owner-grant`: each
         * write needs an owner-signed grant (Ed25519, @comforge/core grant protocol) bound to
         * this repository, ticket, issue, specification digest, base, commit and branch, with
         * an expiry and an attempt limit. `operator`: whoever runs the CLI with the credential
         * is the authority (no independent authorization; an explicit owner choice).
         */
        authorization: z
            .discriminatedUnion("mode", [
            z
                .object({
                mode: z.literal("owner-grant"),
                grantScheme: z.string().regex(/^[a-z0-9][a-z0-9.-]{0,63}\/v\d+$/),
                trustedKeys: z
                    .array(z
                    .object({
                    keyId: z.string().regex(/^[0-9a-f]{16,64}$/),
                    publicKeyPem: z.string().startsWith("-----BEGIN PUBLIC KEY-----").max(1000),
                    label: z.string().min(1).max(80),
                })
                    .strict())
                    .min(1)
                    .max(10),
            })
                .strict(),
            z.object({ mode: z.literal("operator") }).strict(),
        ])
            .nullable()
            .default(null),
        /** Namespace of the write ledger in `<git common dir>/comforge/`. */
        ledgerNamespace: z
            .string()
            .regex(/^[a-z0-9][a-z0-9._-]{0,63}$/)
            .default("writes"),
        /** Namespace of the correlation markers the writer appends to created bodies. */
        markerNamespace: z
            .string()
            .regex(/^[a-z0-9][a-z0-9-]{0,39}$/)
            .default("comforge-cli"),
        credentials: z
            .discriminatedUnion("source", [
            z.object({ source: z.literal("env"), variable: ENV_NAME }).strict(),
            z.object({ source: z.literal("gh") }).strict(),
        ])
            .default({ source: "env", variable: "GITHUB_TOKEN" }),
        delivery: z
            .object({
            /** Assigned to each published pull request (through the audited `gh` host adapter). */
            assignee: LOGIN.nullable().default(null),
        })
            .strict()
            .default({ assignee: null }),
    })
        .strict()
        .default({
        capabilities: [...CLI_CAPABILITIES],
        authorization: null,
        ledgerNamespace: "writes",
        markerNamespace: "comforge-cli",
        credentials: { source: "env", variable: "GITHUB_TOKEN" },
        delivery: { assignee: null },
    }),
})
    .strict();
/** Sections a candidate revision may not change for its own publication. */
export const TRUSTED_SECTIONS = [
    "schema",
    "repository",
    "tickets",
    "validation",
    "specification",
    "completion",
    "security",
];
export function parseConfig(text, source) {
    let raw;
    try {
        raw = JSON.parse(text);
    }
    catch {
        fail("config-invalid", `${source} is not JSON`, { source });
    }
    if (raw !== null &&
        typeof raw === "object" &&
        "schema" in raw &&
        raw.schema !== CONFIG_SCHEMA)
        fail("config-invalid", `${source} has an unknown schema version`, {
            source,
            schema: raw.schema,
            supported: CONFIG_SCHEMA,
        });
    const parsed = ConfigSchema.safeParse(raw);
    if (!parsed.success)
        fail("config-invalid", `${source} is not a valid ${CONFIG_SCHEMA} configuration`, {
            source,
            issues: parsed.error.issues
                .slice(0, 20)
                .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
        });
    return parsed.data;
}
/** The working tree's configuration (candidate text: guidance and local settings only). */
export function readWorkingConfig(root) {
    const file = path.join(root, CONFIG_FILE);
    let text;
    try {
        text = readFileSync(file, "utf8");
    }
    catch {
        throw new CliError("config-missing", `no ${CONFIG_FILE} in ${root}; run comforge init`, {
            root,
        });
    }
    return parseConfig(text, CONFIG_FILE);
}
export const trustedPart = (config) => Object.fromEntries(TRUSTED_SECTIONS.map((k) => [k, config[k]]));
/** Trusted sections in which `candidate` differs from `trusted`. */
export function trustedChanges(trusted, candidate) {
    return TRUSTED_SECTIONS.filter((k) => canonical(trusted[k]) !== canonical(candidate[k]));
}
/** The JSON Schema of the configuration, for editors and agents (`comforge schema config`). */
export function configJsonSchema() {
    return z.toJSONSchema(ConfigSchema, { io: "input", unrepresentable: "any" });
}
