/**
 * Every refusal the adapter makes, with a stable code. A refusal is never a governance
 * decision: it says GitHub could not supply trustworthy evidence, so the caller stops.
 */
export declare const GITHUB_ERROR_CODES: readonly ["invalid-input", "unapproved-origin", "not-found", "unauthorized", "forbidden", "rate-limited", "http-error", "timeout", "network", "too-large", "malformed-response", "incomplete", "stale", "wrong-target", "conflict"];
export type GitHubErrorCode = (typeof GITHUB_ERROR_CODES)[number];
export interface GitHubErrorDetail {
    /** HTTP status, when GitHub answered. */
    status?: number;
    /** Seconds GitHub asked to wait (`retry-after`), when it said. */
    retryAfterSeconds?: number;
    [key: string]: unknown;
}
export declare class GitHubAdapterError extends Error {
    readonly name = "GitHubAdapterError";
    readonly code: GitHubErrorCode;
    readonly detail: GitHubErrorDetail;
    constructor(code: GitHubErrorCode, message: string, detail?: GitHubErrorDetail);
}
