/**
 * One error type for every command, with a stable code and a stable exit status. Agents
 * branch on `code` (and the exit status); `message` is for people and may change wording.
 */

/** Exit statuses. Stable across versions of the same major. */
export const EXIT = {
  /** The command did what it says. */
  ok: 0,
  /** A governance check refused the request; nothing unsafe happened. Fix the cause, rerun. */
  refused: 1,
  /** Bad usage or an invalid or missing configuration. */
  usage: 2,
  /** The environment failed (git, GitHub, file system). Rerunning may succeed. */
  failed: 3,
  /** A multi-stage command stopped part-way; rerun the same command to finish it. */
  incomplete: 4,
} as const;
export type ExitStatus = (typeof EXIT)[keyof typeof EXIT];

/** Every error code and its exit status. */
export const ERROR_CODES = {
  usage: EXIT.usage,
  "config-missing": EXIT.usage,
  "config-invalid": EXIT.usage,
  "unsupported-platform": EXIT.usage,
  "untrusted-config-change": EXIT.refused,
  "not-found": EXIT.refused,
  conflict: EXIT.refused,
  stale: EXIT.refused,
  "policy-denied": EXIT.refused,
  "validation-missing": EXIT.refused,
  "validation-failed": EXIT.refused,
  "specification-invalid": EXIT.refused,
  "evidence-missing": EXIT.refused,
  "dirty-checkout": EXIT.refused,
  "credential-missing": EXIT.refused,
  "authorization-required": EXIT.refused,
  unauthorized: EXIT.refused,
  "would-overwrite": EXIT.refused,
  "git-failed": EXIT.failed,
  "github-failed": EXIT.failed,
  ambiguous: EXIT.failed,
  ledger: EXIT.failed,
  io: EXIT.failed,
  incomplete: EXIT.incomplete,
} as const;
export type ErrorCode = keyof typeof ERROR_CODES;

export class CliError extends Error {
  readonly code: ErrorCode;
  readonly detail: Record<string, unknown>;
  readonly exit: ExitStatus;
  constructor(code: ErrorCode, message: string, detail: Record<string, unknown> = {}) {
    super(message);
    this.name = "CliError";
    this.code = code;
    this.detail = detail;
    this.exit = ERROR_CODES[code];
  }
}

export const fail = (code: ErrorCode, message: string, detail?: Record<string, unknown>): never => {
  throw new CliError(code, message, detail);
};

/** The JSON form of an error on stderr: `{ error, message, detail }`. */
export function errorJson(error: unknown): { error: string; message: string; detail: unknown } {
  if (error instanceof CliError)
    return { error: error.code, message: error.message, detail: error.detail };
  return {
    error: "internal",
    message: error instanceof Error ? error.message : String(error),
    detail: {},
  };
}

export const exitOf = (error: unknown): ExitStatus =>
  error instanceof CliError ? error.exit : EXIT.failed;
