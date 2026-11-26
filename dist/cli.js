#!/usr/bin/env node
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { COMMANDS, capabilities, context, doctor, PACKAGE_VERSION } from "./commands/agent.js";
import { complete, deliver, publish, readResultFile, recover } from "./commands/delivery.js";
import { grantCommand } from "./commands/grant.js";
import { init } from "./commands/init.js";
import { cleanup, revise, start, status, verify, } from "./commands/lifecycle.js";
import { configJsonSchema } from "./config.js";
import { openContext } from "./context.js";
import { CliError, EXIT, errorJson, exitOf, fail } from "./errors.js";
import { stableJson } from "./json.js";
import { defaultRuntime } from "./runtime.js";
const VALUE_FLAGS = new Set([
    "--grant",
    "--key",
    "--hours",
    "--issue",
    "--expect-digest",
    "--reviewed-head",
    "--commit",
    "--title",
    "--result",
    "--task",
    "--cwd",
]);
export function parseArgs(argv) {
    const positional = [];
    const flags = new Map();
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg.startsWith("--")) {
            const eq = arg.indexOf("=");
            const name = eq > 0 ? arg.slice(0, eq) : arg;
            if (VALUE_FLAGS.has(name)) {
                const value = eq > 0 ? arg.slice(eq + 1) : argv[++i];
                if (value === undefined || value.startsWith("--"))
                    fail("usage", `${name} needs a value`);
                flags.set(name, value);
            }
            else
                flags.set(name, true);
        }
        else
            positional.push(arg);
    }
    const [command = "", ...rest] = positional;
    return { command, positional: rest, flags };
}
const KNOWN_FLAGS = {
    init: ["--write", "--force"],
    doctor: [],
    capabilities: [],
    context: ["--task"],
    schema: [],
    start: ["--issue", "--expect-digest", "--no-provision"],
    revise: ["--reviewed-head"],
    status: [],
    verify: ["--commit"],
    publish: ["--title", "--draft", "--execute", "--grant"],
    grant: ["--grant", "--key", "--hours"],
    complete: ["--result", "--execute", "--grant"],
    deliver: ["--title", "--result", "--no-pr", "--draft", "--execute", "--grant"],
    recover: ["--abandon", "--execute", "--grant"],
    cleanup: ["--allow-missing-completion", "--execute"],
};
const GLOBAL_FLAGS = ["--json", "--help", "--version", "--cwd"];
function help(command) {
    const entry = COMMANDS.find((c) => c.name === command);
    if (entry)
        return `comforge ${entry.usage}\n\n${entry.summary}\nWrites: ${entry.writes}.${entry.dryRunByDefault ? " A dry run unless --execute (or --write)." : ""}\n`;
    return [
        `comforge ${PACKAGE_VERSION} — a governed agent lifecycle for a Git repository`,
        "",
        ...COMMANDS.map((c) => `  comforge ${c.usage.padEnd(84)} ${c.summary}`),
        "",
        "Global: --json (deterministic JSON on stdout), --cwd DIR, --help, --version.",
        "Exit: 0 ok, 1 refused, 2 usage/configuration, 3 environment failure, 4 incomplete (rerun).",
        "Never merges, deploys, approves, requests reviews or closes issues.",
        "",
    ].join("\n");
}
const intArg = (value, what) => {
    const n = Number(value);
    if (!value || !Number.isSafeInteger(n) || n < 1)
        fail("usage", `${what} must be a positive integer`);
    return n;
};
const needOne = (p, what) => {
    if (p.positional.length !== 1)
        fail("usage", `comforge ${p.command} needs exactly one ${what}`);
    return p.positional[0];
};
const str = (p, name) => {
    const v = p.flags.get(name);
    return typeof v === "string" ? v : undefined;
};
const grantFile = (p, rt) => {
    const f = str(p, "--grant");
    return f ? path.resolve(rt.cwd, f) : undefined;
};
const required = (p, name) => str(p, name) ?? fail("usage", `${name} is required`);
export async function runCommand(p, rt) {
    const allowed = KNOWN_FLAGS[p.command];
    if (!allowed)
        fail("usage", p.command ? `unknown command ${p.command}` : "no command given (comforge --help)");
    for (const flag of p.flags.keys())
        if (!allowed?.includes(flag) && !GLOBAL_FLAGS.includes(flag))
            fail("usage", `${flag} is not an option of ${p.command}`);
    const execute = p.flags.has("--execute");
    switch (p.command) {
        case "init":
            return init(rt, { write: p.flags.has("--write"), force: p.flags.has("--force") });
        case "doctor":
            return doctor(rt);
        case "capabilities":
            return capabilities();
        case "schema": {
            const which = needOne(p, "schema name (config, capabilities)");
            if (which === "config")
                return { result: configJsonSchema() };
            if (which === "capabilities")
                return capabilities();
            return fail("usage", `unknown schema ${which}`);
        }
        case "context":
            if (p.positional[0] === "check")
                return context(rt, { check: true });
            if (p.positional.length > 0)
                fail("usage", "context takes --task TEXT or the word check");
            return context(rt, { task: str(p, "--task") });
    }
    const ctx = openContext(rt);
    switch (p.command) {
        case "start":
            return start(ctx, {
                id: needOne(p, "initiative id"),
                issue: p.flags.has("--issue") ? intArg(str(p, "--issue"), "--issue") : undefined,
                expectDigest: str(p, "--expect-digest"),
                provision: !p.flags.has("--no-provision"),
            });
        case "revise":
            return revise(ctx, {
                pr: intArg(needOne(p, "pull request number"), "the pull request"),
                reviewedHead: str(p, "--reviewed-head"),
            });
        case "status":
            if (p.positional.length > 1)
                fail("usage", "status takes at most one initiative id");
            return status(ctx, { id: p.positional[0] });
        case "verify":
            return verify(ctx, { id: needOne(p, "initiative id"), commit: str(p, "--commit") });
        case "publish":
            return publish(ctx, {
                id: needOne(p, "initiative id"),
                title: required(p, "--title"),
                draft: p.flags.has("--draft"),
                execute,
                grantFile: grantFile(p, rt),
            });
        case "complete":
            if (p.positional.length > 0)
                fail("usage", "complete takes only --result FILE");
            return complete(ctx, {
                raw: readResultFile(path.resolve(rt.cwd, required(p, "--result"))),
                execute,
                grantFile: grantFile(p, rt),
            });
        case "deliver":
            return deliver(ctx, {
                id: needOne(p, "initiative id"),
                title: required(p, "--title"),
                raw: readResultFile(path.resolve(rt.cwd, required(p, "--result"))),
                withoutPullRequest: p.flags.has("--no-pr"),
                draft: p.flags.has("--draft"),
                execute,
                grantFile: grantFile(p, rt),
            });
        case "grant":
            return grant(ctx, p);
        case "recover":
            return recover(ctx, {
                id: needOne(p, "initiative id"),
                execute,
                grantFile: grantFile(p, rt),
                abandon: p.flags.has("--abandon"),
            });
        case "cleanup":
            return cleanup(ctx, {
                target: needOne(p, "pull request number or initiative id"),
                execute,
                allowMissingCompletion: p.flags.has("--allow-missing-completion"),
            });
    }
    return fail("usage", `unknown command ${p.command}`);
}
function grant(ctx, p) {
    const [sub, id] = p.positional;
    if (sub === "template" && id && p.positional.length === 2)
        return grantCommand.template(ctx, {
            id,
            hours: p.flags.has("--hours") ? intArg(str(p, "--hours"), "--hours") : 24,
        });
    if (sub === "sign" && p.positional.length === 2 && id)
        return grantCommand.sign(ctx, {
            id,
            grantFile: path.resolve(ctx.rt.cwd, required(p, "--grant")),
            keyFile: path.resolve(ctx.rt.cwd, required(p, "--key")),
        });
    return fail("usage", "grant template <ID> [--hours N] | grant sign <ID> --grant FILE --key FILE");
}
/** Human rendering: the result's scalar fields, one per line; nested values as compact JSON. */
export function renderHuman(command, result) {
    const lines = [`comforge ${command}`];
    for (const [key, value] of Object.entries(result)) {
        if (value === undefined)
            continue;
        lines.push(`  ${key}: ${typeof value === "object" && value !== null ? JSON.stringify(value) : String(value)}`);
    }
    return `${lines.join("\n")}\n`;
}
/** Runs one invocation; returns the exit status. Never throws. */
export async function main(argv, rt = defaultRuntime(), io = { out: (t) => process.stdout.write(t), err: (t) => process.stderr.write(t) }) {
    let parsed;
    try {
        parsed = parseArgs(argv);
    }
    catch (error) {
        io.err(stableJson(errorJson(error)));
        return exitOf(error);
    }
    if (parsed.flags.has("--version")) {
        io.out(`${PACKAGE_VERSION}\n`);
        return EXIT.ok;
    }
    if (parsed.flags.has("--help") || parsed.command === "help" || parsed.command === "") {
        io.out(help(parsed.command === "help" ? parsed.positional[0] : parsed.command));
        return parsed.command === "" && !parsed.flags.has("--help") ? EXIT.usage : EXIT.ok;
    }
    const cwd = parsed.flags.get("--cwd");
    const runtime = typeof cwd === "string" ? { ...rt, cwd: path.resolve(rt.cwd, cwd) } : rt;
    try {
        if (process.platform === "win32")
            fail("unsupported-platform", "comforge does not support Windows");
        const { result, exit = EXIT.ok } = await runCommand(parsed, runtime);
        io.out(parsed.flags.has("--json") ? stableJson(result) : renderHuman(parsed.command, result));
        return exit;
    }
    catch (error) {
        io.err(stableJson(errorJson(error)));
        return error instanceof CliError ? error.exit : EXIT.failed;
    }
}
const invoked = (() => {
    try {
        return (process.argv[1] !== undefined &&
            realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)));
    }
    catch {
        return false;
    }
})();
if (invoked)
    process.exitCode = await main(process.argv.slice(2));
