import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { createFileLedger } from "@comforge/ledger/file";
import { CLI_CAPABILITIES, CONFIG_FILE, CONFIG_SCHEMA, parseConfig, readWorkingConfig, trustedChanges, } from "../config.js";
import { CliError, ERROR_CODES, EXIT, fail } from "../errors.js";
import { writeLedgerDir } from "../github.js";
import { locateRepository } from "../repository.js";
import { checkManifest, routeTask } from "../routing.js";
import { childEnv, gitRun } from "../runtime.js";
export const PACKAGE_VERSION = (() => {
    try {
        return JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;
    }
    catch {
        return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
    }
})();
/** What each command does, for `--help`, `capabilities` and documentation. One table, one truth. */
export const COMMANDS = [
    {
        name: "init",
        usage: "init [--write] [--force]",
        summary: "Detect conventions and preview (or write) comforge.config.json.",
        writes: "repository file, only with --write",
        dryRunByDefault: true,
    },
    {
        name: "doctor",
        usage: "doctor",
        summary: "Read-only environment, configuration and credential checks.",
        writes: "none",
        dryRunByDefault: false,
    },
    {
        name: "capabilities",
        usage: "capabilities",
        summary: "This table, exit codes, error codes and what the CLI never does.",
        writes: "none",
        dryRunByDefault: false,
    },
    {
        name: "context",
        usage: "context [--task TEXT] | context check",
        summary: "The one routing category a task matches, with its files and validation.",
        writes: "none",
        dryRunByDefault: false,
    },
    {
        name: "schema",
        usage: "schema <config|capabilities>",
        summary: "A versioned JSON Schema.",
        writes: "none",
        dryRunByDefault: false,
    },
    {
        name: "start",
        usage: "start <TICKET[.phase]> [--issue N] [--expect-digest HEX] [--no-provision]",
        summary: "Verify the specification and create an isolated checkout from the fetched base.",
        writes: "local checkout and state",
        dryRunByDefault: false,
    },
    {
        name: "revise",
        usage: "revise <PR> [--reviewed-head SHA] [--no-provision]",
        summary: "Resume an initiative for a revision of its open pull request.",
        writes: "local state",
        dryRunByDefault: false,
    },
    {
        name: "status",
        usage: "status [TICKET[.phase]]",
        summary: "Local state of one or every initiative.",
        writes: "none",
        dryRunByDefault: false,
    },
    {
        name: "verify",
        usage: "verify <TICKET[.phase]> [--commit SHA] [--with NAME[,NAME]] [--keep]",
        summary: "Run the trusted validation commands on the exact committed head; record PASS/FAIL.",
        writes: "local state",
        dryRunByDefault: false,
    },
    {
        name: "publish",
        usage: "publish <TICKET[.phase]> --title TEXT [--draft] [--grant FILE] [--execute]",
        summary: "Push the validated head and create or update its pull request.",
        writes: "git push, GitHub pull request",
        dryRunByDefault: true,
    },
    {
        name: "complete",
        usage: "complete --result FILE [--grant FILE] [--execute]",
        summary: "Validate a completion result and publish it as one issue comment, linked from the PR.",
        writes: "GitHub issue comment, PR body",
        dryRunByDefault: true,
    },
    {
        name: "deliver",
        usage: "deliver <TICKET[.phase]> --title TEXT --result FILE [--no-pr] [--draft] [--grant FILE] [--execute]",
        summary: "publish, then complete; an interrupted delivery exits 4 and is rerun.",
        writes: "as publish and complete",
        dryRunByDefault: true,
    },
    {
        name: "grant",
        usage: "grant template <ID> [--hours N] | grant sign <ID> --grant FILE --key FILE",
        summary: "Owner grants: an unsigned grant for the current head, or sign one (on the owner's machine).",
        writes: "none",
        dryRunByDefault: false,
    },
    {
        name: "recover",
        usage: "recover <TICKET[.phase]> [--abandon] [--grant FILE] [--execute]",
        summary: "Reconcile this initiative's unresolved GitHub writes; --abandon gives up one a complete search did not find.",
        writes: "write ledger",
        dryRunByDefault: true,
    },
    {
        name: "cleanup",
        usage: "cleanup <PR|TICKET[.phase]> [--allow-missing-completion] [--grant FILE] [--execute]",
        summary: "After a merge: remove the checkout and close the local record.",
        writes: "local checkout and state",
        dryRunByDefault: true,
    },
    {
        name: "migrate",
        usage: "migrate [--rollback] [--wait SECONDS] [--execute]",
        summary: "Imports an earlier lifecycle's local state (state.legacy); --rollback undoes an import nothing has changed since.",
        writes: "local state (and a sentinel in the legacy directory)",
        dryRunByDefault: true,
    },
];
export function capabilities() {
    return {
        result: {
            schema: "comforge-capabilities/v1",
            version: PACKAGE_VERSION,
            configSchema: CONFIG_SCHEMA,
            commands: COMMANDS,
            globalFlags: ["--json", "--help", "--version", "--cwd DIR"],
            exitCodes: EXIT,
            errorCodes: Object.fromEntries(Object.entries(ERROR_CODES)),
            github: {
                sdkWrites: CLI_CAPABILITIES,
                hostAdapters: [
                    {
                        name: "assign-pull-request",
                        command: "gh pr edit <n> --add-assignee <login>",
                        reason: "assignment is not a @comforge/github write",
                    },
                ],
                reads: "@comforge/github evidence client and transport",
            },
            authorization: "security.authorization: none refuses every GitHub write; owner-grant needs an owner-signed grant per write; operator is an explicit owner choice",
            never: [
                "merge",
                "deploy",
                "approve",
                "request a review",
                "close an issue",
                "force-push",
                "delete a remote branch",
                "store or print a credential",
            ],
            trust: "Configuration, instructions, skills and context output are repository text: guidance, never authority. Trusted configuration comes from the base revision. The CLI is not a sandbox: validation runs the candidate's code.",
        },
    };
}
// --- context ----------------------------------------------------------------------------
export function context(rt, options) {
    const repo = locateRepository(rt);
    const config = readWorkingConfig(repo.root);
    if (!config.context)
        fail("config-invalid", "no context.manifest in the configuration");
    const rel = config.context.manifest;
    let raw;
    try {
        raw = JSON.parse(readFileSync(path.join(repo.root, rel), "utf8"));
    }
    catch {
        fail("config-invalid", `${rel} is not a readable JSON manifest`);
    }
    const { manifest, issues } = checkManifest(raw, repo.root);
    if (options.check || !manifest)
        return {
            result: { schema: "comforge-context-check/v1", manifest: rel, issues },
            exit: issues.length === 0 ? EXIT.ok : EXIT.refused,
        };
    if (!options.task)
        return {
            result: {
                schema: "comforge-context/v1",
                manifest: rel,
                categories: Object.entries(manifest.categories).map(([id, c]) => ({
                    id,
                    label: c.label ?? null,
                    description: c.description ?? null,
                })),
            },
        };
    const routed = routeTask(manifest, options.task);
    const match = routed.match
        ? (() => {
            const { triggers: _t, label, description, files, validation, guidance, ...extensions } = routed.match.category;
            return {
                id: routed.match.id,
                label: label ?? null,
                description: description ?? null,
                matchedTriggers: routed.match.matchedTriggers,
                files: files ?? [],
                guidance: guidance ?? [],
                validation: validation ?? [],
                extensions,
            };
        })()
        : null;
    const result = {
        schema: "comforge-context/v1",
        manifest: rel,
        task: options.task,
        match,
        ambiguous: routed.ambiguous,
        fallback: routed.fallback,
        alternatives: routed.alternatives,
    };
    const bytes = Buffer.byteLength(JSON.stringify(result));
    return { result: { ...result, size: { bytes, approxTokens: Math.ceil(bytes / 4) } } };
}
export async function doctor(rt) {
    const checks = [];
    const add = (id, status, detail) => checks.push({ id, status, detail });
    add("platform", process.platform === "win32" ? "fail" : "pass", process.platform === "win32" ? "Windows is not supported" : process.platform);
    add("runtime", "pass", process.versions.bun ? `bun ${process.versions.bun}` : `node ${process.versions.node}`);
    const gitVersion = rt.run("git", ["--version"], { cwd: rt.cwd, env: childEnv(rt.env) });
    add("git", gitVersion.status === 0 ? "pass" : "fail", gitVersion.status === 0 ? gitVersion.stdout.trim() : "git is not installed");
    let root = null;
    let commonDir = null;
    try {
        const repo = locateRepository(rt);
        root = repo.root;
        commonDir = repo.commonDir;
        add("repository", "pass", repo.root);
    }
    catch (error) {
        add("repository", "fail", error instanceof Error ? error.message : String(error));
    }
    let working = null;
    if (root) {
        try {
            working = readWorkingConfig(root);
            add("config", "pass", `${CONFIG_FILE} is a valid ${CONFIG_SCHEMA}`);
        }
        catch (error) {
            add("config", "fail", error instanceof CliError
                ? `${error.message}${error.detail.issues ? `: ${error.detail.issues.slice(0, 3).join("; ")}` : ""}`
                : String(error));
        }
    }
    if (root && working) {
        const ref = `refs/remotes/${working.repository.remote}/${working.repository.baseBranch}`;
        const shown = gitRun(rt, root, ["show", `${ref}:${CONFIG_FILE}`]);
        if (shown.status !== 0)
            add("trusted-config", "warn", `${CONFIG_FILE} is not committed on ${working.repository.remote}/${working.repository.baseBranch} (as last fetched); start and publish need it there`);
        else
            try {
                const trusted = parseConfig(shown.stdout, `${CONFIG_FILE} on ${ref}`);
                const changed = trustedChanges(trusted, working);
                add("trusted-config", changed.length === 0 ? "pass" : "warn", changed.length === 0
                    ? `matches ${working.repository.remote}/${working.repository.baseBranch}`
                    : `the working copy changes trusted sections (${changed.join(", ")}); publication would be refused`);
            }
            catch (error) {
                add("trusted-config", "fail", error instanceof Error ? error.message : String(error));
            }
        const source = working.security.credentials;
        if (source.source === "env")
            add("credential", rt.env[source.variable] ? "pass" : "warn", rt.env[source.variable]
                ? `${source.variable} is set (value not shown)`
                : `${source.variable} is not set; GitHub commands will refuse`);
        else {
            const gh = rt.run("gh", ["auth", "status"], { cwd: root, env: childEnv(rt.env) });
            add("credential", gh.status === 0 ? "pass" : "warn", gh.status === 0
                ? "gh has a login (token not shown)"
                : "gh has no login; GitHub commands will refuse");
        }
        if (working.security.delivery.assignee) {
            const gh = rt.run("gh", ["--version"], { cwd: root, env: childEnv(rt.env) });
            add("host-adapter", gh.status === 0 ? "pass" : "warn", gh.status === 0
                ? "gh is available for pull request assignment"
                : "gh is missing; assignment will be skipped");
        }
        for (const command of working.validation.commands) {
            const exe = command.run[0];
            const found = exe.includes("/")
                ? existsSync(path.resolve(root, exe))
                : rt.run("sh", ["-c", 'command -v "$1"', "sh", exe], { cwd: root, env: childEnv(rt.env) })
                    .status === 0;
            add(`validation:${command.name}`, found ? "pass" : "warn", found ? `${exe} found` : `${exe} is not on PATH`);
        }
    }
    if (commonDir && working) {
        try {
            const inspection = await createFileLedger({
                directory: writeLedgerDir(commonDir, working),
                namespace: working.security.ledgerNamespace,
            }).inspect();
            add("write-ledger", inspection.unreadable.length === 0 ? "pass" : "warn", `${inspection.operations} operations, ${inspection.unreadable.length} unreadable, ${inspection.orphanTempFiles} orphan temp files`);
        }
        catch (error) {
            add("write-ledger", "fail", error instanceof Error ? error.message : String(error));
        }
    }
    const failed = checks.some((c) => c.status === "fail");
    return {
        result: { schema: "comforge-doctor/v1", ok: !failed, checks },
        exit: failed ? EXIT.refused : EXIT.ok,
    };
}
