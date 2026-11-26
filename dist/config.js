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
/**
 * Writes outside the SDK, each through one audited host adapter; never granted by default.
 * `pulls:assign` assigns the configured login; `pulls:ready` marks the pull request this
 * command published ready for review (GitHub's REST API cannot); `branches:delete` deletes an
 * initiative's own merged branch under a lease during cleanup.
 */
export const HOST_CAPABILITIES = ["pulls:assign", "pulls:ready", "branches:delete"];
/**
 * Sections added after 0.1.0. Each defaults to 0.1.0 behaviour and is left out of the trusted
 * digest while it equals its default, so initiatives started under 0.1.0 keep their digest.
 */
const LEDGER_DIR = z
    .string()
    .regex(/^[a-z0-9][a-z0-9._-]{0,63}$/, "a directory name inside the git common directory");
const NAMESPACE = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/);
const NAMED_COMMAND = z
    .object({ name: z.string().regex(/^[a-z0-9][a-z0-9:._-]{0,63}$/), run: COMMAND })
    .strict();
const StateSection = z
    .object({
    /**
     * Directory (in the git common directory) of the GitHub write ledger. Sharing the
     * directory of an earlier lifecycle keeps its unresolved writes under their own identities.
     */
    writeLedgerDirectory: LEDGER_DIR.default("comforge"),
    /** An earlier lifecycle's local state that `comforge migrate` imports; until then its tickets are refused. */
    legacy: z
        .object({
        directory: LEDGER_DIR,
        format: z.literal("agent-lifecycle/v1"),
    })
        .strict()
        .nullable()
        .default(null),
})
    .strict();
const LifecycleSection = z
    .object({
    /** start refuses when the remote already has the branch or a pull request for it. */
    remotePreflight: z.boolean().default(false),
    /** A phase starts only after its ticket's initiative was cleaned up. */
    phaseRequiresCleanParent: z.boolean().default(false),
})
    .strict();
const VerificationSection = z
    .object({
    /** Validate a fresh clone of the exact commit (provisioned like a new checkout), not the working checkout. */
    snapshot: z.boolean().default(false),
    /** Exit statuses of a validation command that mean "could not run", recorded as UNAVAILABLE. */
    unavailableExitStatuses: z.array(z.number().int().min(1).max(255)).max(20).default([]),
    /** A JSON file a validation command writes, recorded (size-bounded) with the result. */
    summary: z
        .object({ path: REL_PATH, maxBytes: z.number().int().min(1).max(1_000_000).default(200_000) })
        .strict()
        .nullable()
        .default(null),
    /** Extra validation commands run only when named with --with NAME (for example end-to-end tests). */
    optional: z.array(NAMED_COMMAND).max(10).default([]),
})
    .strict();
const PublicationSection = z
    .object({
    /** Trusted checks run in the checkout before anything is pushed (for example evidence or commit-message checks). */
    checks: z.array(NAMED_COMMAND).max(10).default([]),
    /** A trusted command printing the pull request body (Markdown) on stdout; the CLI appends its marker. */
    bodyCommand: COMMAND.nullable().default(null),
    /** Appends `<!-- <completion namespace>:publication ticket=… head=… -->` to the body. */
    marker: z.boolean().default(false),
    /** Create the pull request as a draft and mark it ready after the handoff checks (needs pulls:ready). */
    draftFirst: z.boolean().default(false),
    /** Namespace of the completion-link block in pull request bodies. */
    linkMarkerNamespace: NAMESPACE.default("comforge"),
    /** pullRequest.reason given to a non-implementation result delivered with its own pull request. */
    reportPullRequestReason: z.string().min(1).max(300).nullable().default(null),
})
    .strict();
const CleanupSection = z
    .object({
    /** Delete the initiative's merged remote branch under a lease (needs branches:delete and an authorization). */
    deleteRemoteBranch: z.boolean().default(false),
    /** Delete the primary's local copy of the initiative branch when it is fully merged. */
    deleteLocalBranch: z.boolean().default(false),
    /** Fast-forward the primary's base branch when it is checked out, clean and behind. */
    fastForwardPrimary: z.boolean().default(false),
    /** Trusted commands run in the primary after the checkout is removed (for example an index refresh). */
    after: z.array(NAMED_COMMAND).max(5).default([]),
})
    .strict();
export const SECTION_DEFAULTS = {
    state: StateSection.parse({}),
    lifecycle: LifecycleSection.parse({}),
    verification: VerificationSection.parse({}),
    publication: PublicationSection.parse({}),
    cleanup: CleanupSection.parse({}),
};
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
    state: StateSection.default(SECTION_DEFAULTS.state),
    lifecycle: LifecycleSection.default(SECTION_DEFAULTS.lifecycle),
    verification: VerificationSection.default(SECTION_DEFAULTS.verification),
    publication: PublicationSection.default(SECTION_DEFAULTS.publication),
    cleanup: CleanupSection.default(SECTION_DEFAULTS.cleanup),
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
        /** Namespace of the write ledger in `<git common dir>/<state.writeLedgerDirectory>/`. */
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
    "state",
    "lifecycle",
    "verification",
    "publication",
    "cleanup",
];
/** Trusted sections added after 0.1.0: in the digest only when they differ from their default. */
const LATER_SECTIONS = new Set(Object.keys(SECTION_DEFAULTS));
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
export const trustedPart = (config) => Object.fromEntries(TRUSTED_SECTIONS.filter((k) => !LATER_SECTIONS.has(k) ||
    canonical(config[k]) !== canonical(SECTION_DEFAULTS[k])).map((k) => [k, config[k]]));
/** Trusted sections in which `candidate` differs from `trusted`. */
export function trustedChanges(trusted, candidate) {
    return TRUSTED_SECTIONS.filter((k) => canonical(trusted[k]) !== canonical(candidate[k]));
}
/** The JSON Schema of the configuration, for editors and agents (`comforge schema config`). */
export function configJsonSchema() {
    return z.toJSONSchema(ConfigSchema, { io: "input", unrepresentable: "any" });
}
