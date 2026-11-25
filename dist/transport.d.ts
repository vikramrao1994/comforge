import { GitHubAdapterError } from "./errors.ts";
/**
 * The only route to GitHub: GET requests to absolute API paths on one fixed origin.
 * Trust boundary:
 * - the origin is fixed at construction; a path is a path, never a URL, and redirects fail;
 * - the credential is supplied by the caller and attached here only, never echoed in errors;
 * - there is no mutation method: a write is the caller's governed decision, not the adapter's;
 * - every failure is a typed `GitHubAdapterError`; nothing retries, so the caller's policy decides.
 */
export interface GitHubTransport {
    /** GET an absolute API path (`/repos/o/r/pulls/1`) and return the parsed JSON body. */
    get(path: string, query?: Readonly<Record<string, string>>): Promise<unknown>;
}
export interface FetchTransportOptions {
    /** A token, or a function returning one per request (installation tokens expire). */
    token: string | (() => string | Promise<string>);
    /** Defaults to the global `fetch`. */
    fetchImpl?: typeof fetch;
    /** Defaults to `https://api.github.com`; GitHub Enterprise Server uses its own API origin. */
    apiOrigin?: string;
    /** Per request; defaults to 8 000 ms. */
    timeoutMs?: number;
    /** Response bodies larger than this are refused; defaults to 5 000 000 bytes. */
    maxBodyBytes?: number;
    /** Sent as `User-Agent`; GitHub requires one. */
    userAgent?: string;
}
export declare const API_VERSION = "2022-11-28";
export declare const DEFAULTS: {
    readonly apiOrigin: "https://api.github.com";
    readonly timeoutMs: 8000;
    readonly maxBodyBytes: 5000000;
};
/**
 * Maps a non-2xx response to a refusal. GitHub signals its secondary rate limit with a 403
 * carrying `retry-after` or an exhausted `x-ratelimit-remaining`; that is `rate-limited`,
 * not `forbidden`.
 */
export declare function classifyStatus(status: number, headers: Headers): GitHubAdapterError;
export declare function createFetchTransport(options: FetchTransportOptions): GitHubTransport;
