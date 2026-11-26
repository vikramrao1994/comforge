/**
 * One error type for every command, with a stable code and a stable exit status. Agents
 * branch on `code` (and the exit status); `message` is for people and may change wording.
 */
/** Exit statuses. Stable across versions of the same major. */
export declare const EXIT: {
    /** The command did what it says. */
    readonly ok: 0;
    /** A governance check refused the request; nothing unsafe happened. Fix the cause, rerun. */
    readonly refused: 1;
    /** Bad usage or an invalid or missing configuration. */
    readonly usage: 2;
    /** The environment failed (git, GitHub, file system). Rerunning may succeed. */
    readonly failed: 3;
    /** A multi-stage command stopped part-way; rerun the same command to finish it. */
    readonly incomplete: 4;
};
export type ExitStatus = (typeof EXIT)[keyof typeof EXIT];
/** Every error code and its exit status. */
export declare const ERROR_CODES: {
    readonly usage: 2;
    readonly "config-missing": 2;
    readonly "config-invalid": 2;
    readonly "unsupported-platform": 2;
    readonly "untrusted-config-change": 1;
    readonly "not-found": 1;
    readonly conflict: 1;
    readonly stale: 1;
    readonly "policy-denied": 1;
    readonly "validation-missing": 1;
    readonly "validation-failed": 1;
    readonly "specification-invalid": 1;
    readonly "evidence-missing": 1;
    readonly "dirty-checkout": 1;
    readonly "credential-missing": 1;
    readonly "authorization-required": 1;
    readonly unauthorized: 1;
    readonly "would-overwrite": 1;
    readonly "git-failed": 3;
    readonly "github-failed": 3;
    readonly ambiguous: 3;
    readonly ledger: 3;
    readonly io: 3;
    readonly incomplete: 4;
    /** The embedding caller aborted the command between stages; rerun to continue. */
    readonly cancelled: 4;
};
export type ErrorCode = keyof typeof ERROR_CODES;
export declare class CliError extends Error {
    readonly code: ErrorCode;
    readonly detail: Record<string, unknown>;
    readonly exit: ExitStatus;
    constructor(code: ErrorCode, message: string, detail?: Record<string, unknown>);
}
export declare const fail: (code: ErrorCode, message: string, detail?: Record<string, unknown>) => never;
/** The JSON form of an error on stderr: `{ error, message, detail }`. */
export declare function errorJson(error: unknown): {
    error: string;
    message: string;
    detail: unknown;
};
export declare const exitOf: (error: unknown) => ExitStatus;
