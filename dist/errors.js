/**
 * Every refusal the adapter makes, with a stable code. A refusal is never a governance
 * decision: it says GitHub could not supply trustworthy evidence, so the caller stops.
 */
export const GITHUB_ERROR_CODES = [
    "invalid-input",
    "unapproved-origin",
    "not-found",
    "unauthorized",
    "forbidden",
    "rate-limited",
    "http-error",
    "timeout",
    "network",
    "too-large",
    "malformed-response",
    "incomplete",
    "stale",
    "wrong-target",
    "conflict",
];
export class GitHubAdapterError extends Error {
    name = "GitHubAdapterError";
    code;
    detail;
    constructor(code, message, detail = {}) {
        super(message);
        this.code = code;
        this.detail = detail;
    }
}
