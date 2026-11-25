import { GitHubAdapterError } from "./errors.js";
export const API_VERSION = "2022-11-28";
export const DEFAULTS = {
    apiOrigin: "https://api.github.com",
    timeoutMs: 8_000,
    maxBodyBytes: 5_000_000,
};
function headerNumber(headers, name) {
    const value = headers.get(name);
    if (value === null)
        return undefined;
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? n : undefined;
}
/**
 * Maps a non-2xx response to a refusal. GitHub signals its secondary rate limit with a 403
 * carrying `retry-after` or an exhausted `x-ratelimit-remaining`; that is `rate-limited`,
 * not `forbidden`.
 */
export function classifyStatus(status, headers) {
    const retryAfterSeconds = headerNumber(headers, "retry-after");
    if (status === 404)
        return new GitHubAdapterError("not-found", "Not found", { status });
    const exhausted = headers.get("x-ratelimit-remaining") === "0" || retryAfterSeconds !== undefined;
    if (status === 429 || (status === 403 && exhausted))
        return new GitHubAdapterError("rate-limited", "GitHub rate limit reached; retry later", {
            status,
            ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
        });
    if (status === 401)
        return new GitHubAdapterError("unauthorized", "The credential was not accepted", { status });
    if (status === 403)
        return new GitHubAdapterError("forbidden", "The credential is not permitted to do this", {
            status,
        });
    return new GitHubAdapterError("http-error", `GitHub returned HTTP ${status}`, { status });
}
const PATH = /^\/[A-Za-z0-9._~%/-]*$/;
/**
 * GitHub's commit-comparison range (`compare/BASE...HEAD`) is the only API path with dots in a
 * row. It is accepted only as the last segment and only between two full commit SHAs, so it can
 * never spell a parent-directory step; every other `..` is refused.
 */
const COMPARE_RANGE = /\/compare\/[0-9a-f]{40}\.\.\.[0-9a-f]{40}$/;
/** A request that never completed: a timeout, or the network. */
function unreachable(error, message, status) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    return new GitHubAdapterError(timedOut ? "timeout" : "network", timedOut ? "GitHub did not answer in time" : message, status === undefined ? {} : { status });
}
export function createFetchTransport(options) {
    const origin = new URL(options.apiOrigin ?? DEFAULTS.apiOrigin).origin;
    const base = (options.apiOrigin ?? DEFAULTS.apiOrigin).replace(/\/+$/, "");
    const timeoutMs = options.timeoutMs ?? DEFAULTS.timeoutMs;
    const maxBodyBytes = options.maxBodyBytes ?? DEFAULTS.maxBodyBytes;
    const fetchImpl = (...args) => (options.fetchImpl ?? globalThis.fetch)(...args);
    const token = async () => (typeof options.token === "function" ? options.token() : options.token);
    return {
        async get(path, query) {
            if (typeof path !== "string" ||
                !PATH.test(path) ||
                path.replace(COMPARE_RANGE, "/compare/range").includes("..") ||
                path.includes("//"))
                throw new GitHubAdapterError("invalid-input", "The request path is not an API path");
            const url = new URL(`${base}${path}`);
            if (url.origin !== origin)
                throw new GitHubAdapterError("unapproved-origin", "Unapproved outbound host");
            for (const [key, value] of Object.entries(query ?? {}))
                url.searchParams.set(key, value);
            let res;
            try {
                res = await fetchImpl(url, {
                    method: "GET",
                    redirect: "error",
                    signal: AbortSignal.timeout(timeoutMs),
                    headers: {
                        Accept: "application/vnd.github+json",
                        "X-GitHub-Api-Version": API_VERSION,
                        Authorization: `Bearer ${await token()}`,
                        ...(options.userAgent ? { "User-Agent": options.userAgent } : {}),
                    },
                });
            }
            catch (error) {
                throw unreachable(error, "GitHub could not be reached");
            }
            if (!res.ok)
                throw classifyStatus(res.status, res.headers);
            const status = res.status;
            const bounded = (bytes) => {
                if (bytes > maxBodyBytes)
                    throw new GitHubAdapterError("too-large", "The response exceeds the size limit", {
                        status,
                    });
            };
            bounded(headerNumber(res.headers, "content-length") ?? 0);
            let text;
            try {
                text = await res.text();
            }
            catch (error) {
                // The status line arrived but the body did not.
                throw unreachable(error, "The response body could not be read", status);
            }
            bounded(text.length);
            try {
                return JSON.parse(text);
            }
            catch {
                throw new GitHubAdapterError("malformed-response", "GitHub returned a non-JSON body", {
                    status,
                });
            }
        },
    };
}
