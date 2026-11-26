import { spawnSync } from "node:child_process";
import { CliError } from "./errors.ts";

/** A finished child process. */
export interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface RunOptions {
  cwd: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  input?: string;
}

/**
 * Everything a command touches outside its arguments, so tests and embedders can supply it:
 * the working directory, environment, clock, `fetch` and how child processes run.
 */
export interface Runtime {
  cwd: string;
  env: Readonly<Record<string, string | undefined>>;
  now(): number;
  fetchImpl?: typeof fetch;
  run(command: string, args: readonly string[], options: RunOptions): RunResult;
}

export function spawnRun(command: string, args: readonly string[], options: RunOptions): RunResult {
  const r = spawnSync(command, args as string[], {
    cwd: options.cwd,
    env: options.env as NodeJS.ProcessEnv | undefined,
    input: options.input,
    timeout: options.timeoutMs,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const timedOut = (r.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
  return {
    status: r.error && !timedOut ? 127 : r.status,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? (r.error ? String(r.error.message) : ""),
    timedOut,
  };
}

export function defaultRuntime(): Runtime {
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

export function childEnv(
  env: Readonly<Record<string, string | undefined>>,
  options: { dropCredentials?: readonly string[] } = {},
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = { ...env };
  for (const key of [...GIT_REDIRECTS, ...CREDENTIALS, ...(options.dropCredentials ?? [])])
    delete out[key];
  return out;
}

export function gitRun(rt: Runtime, cwd: string, args: readonly string[]): RunResult {
  return rt.run("git", args, { cwd, env: { ...childEnv(rt.env), GIT_TERMINAL_PROMPT: "0" } });
}

/** git, returning trimmed stdout; any failure is `git-failed` with the command's stderr. */
export function git(rt: Runtime, cwd: string, args: readonly string[]): string {
  const r = gitRun(rt, cwd, args);
  if (r.status !== 0)
    throw new CliError("git-failed", `git ${args[0]} failed: ${r.stderr.trim().slice(0, 400)}`, {
      args: [...args],
      status: r.status,
    });
  return r.stdout.trim();
}

export const gitOk = (rt: Runtime, cwd: string, args: readonly string[]): boolean =>
  gitRun(rt, cwd, args).status === 0;
