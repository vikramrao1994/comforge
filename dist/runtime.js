import { spawnSync } from "node:child_process";
import { CliError } from "./errors.js";
export function spawnRun(command, args, options) {
    const r = spawnSync(command, args, {
        cwd: options.cwd,
        env: options.env,
        input: options.input,
        timeout: options.timeoutMs,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
    });
    const timedOut = r.error?.code === "ETIMEDOUT";
    return {
        status: r.error && !timedOut ? 127 : r.status,
        stdout: r.stdout ?? "",
        stderr: r.stderr ?? (r.error ? String(r.error.message) : ""),
        timedOut,
    };
}
export function defaultRuntime() {
    return { cwd: process.cwd(), env: process.env, now: Date.now, run: spawnRun };
}
/**
 * Variables that point git at another repository or carry a credential. Removed from every
 * child process the CLI starts, so a hook or an inherited variable cannot redirect a git
 * command, and candidate code never receives a token from the CLI's environment.
 */
const GIT_REDIRECTS = [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_COMMON_DIR",
    "GIT_NAMESPACE",
    "GIT_PREFIX",
];
const CREDENTIALS = [
    "GITHUB_TOKEN",
    "GH_TOKEN",
    "GH_ENTERPRISE_TOKEN",
    "GITHUB_ENTERPRISE_TOKEN",
    "GH_HOST",
];
export function childEnv(env, options = {}) {
    const out = { ...env };
    for (const key of [...GIT_REDIRECTS, ...CREDENTIALS, ...(options.dropCredentials ?? [])])
        delete out[key];
    return out;
}
export function gitRun(rt, cwd, args) {
    return rt.run("git", args, { cwd, env: { ...childEnv(rt.env), GIT_TERMINAL_PROMPT: "0" } });
}
/** git, returning trimmed stdout; any failure is `git-failed` with the command's stderr. */
export function git(rt, cwd, args) {
    const r = gitRun(rt, cwd, args);
    if (r.status !== 0)
        throw new CliError("git-failed", `git ${args[0]} failed: ${r.stderr.trim().slice(0, 400)}`, {
            args: [...args],
            status: r.status,
        });
    return r.stdout.trim();
}
export const gitOk = (rt, cwd, args) => gitRun(rt, cwd, args).status === 0;
