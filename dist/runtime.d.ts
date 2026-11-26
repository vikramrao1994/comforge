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
export declare function spawnRun(command: string, args: readonly string[], options: RunOptions): RunResult;
export declare function defaultRuntime(): Runtime;
export declare function childEnv(env: Readonly<Record<string, string | undefined>>, options?: {
    dropCredentials?: readonly string[];
}): Record<string, string | undefined>;
export declare function gitRun(rt: Runtime, cwd: string, args: readonly string[]): RunResult;
/** git, returning trimmed stdout; any failure is `git-failed` with the command's stderr. */
export declare function git(rt: Runtime, cwd: string, args: readonly string[]): string;
export declare const gitOk: (rt: Runtime, cwd: string, args: readonly string[]) => boolean;
