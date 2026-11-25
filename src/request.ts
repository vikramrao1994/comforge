import { GitHubAdapterError } from "./errors.ts";
import { API_VERSION, classifyStatus } from "./transport.ts";

/**
 * The package's only non-GET request, used by the writer alone and not exported from the
 * package. Trust boundary:
 * - the method comes from a fixed table keyed by operation kind, never from a caller;
 * - the path is built by the writer from fixed templates under the bound repository and checked
 *   here again; the origin is fixed and redirects fail;
 * - the token is attached here and never appears in a result, error or ledger record;
 * - nothing retries. A request that may have reached GitHub and has no definite answer is
 *   `sent-unknown`, never a refusal: the caller must not treat it as "nothing happened".
 */

export const WRITE_METHODS = {
  "issue.create": "POST",
  "issue.comment": "POST",
  "pull.review": "POST",
  "pull.create": "POST",
  "issue.update": "PATCH",
  "comment.update": "PATCH",
} as const;
export type WriteMethodKind = keyof typeof WRITE_METHODS;

export interface SendOptions {
  origin: string;
  base: string;
  token: () => Promise<string>;
  fetchImpl: typeof fetch;
  timeoutMs: number;
  maxBodyBytes: number;
  userAgent?: string;
}

/**
 * - `answered`: a 2xx whose JSON body was read.
 * - `refused`: a definite non-2xx answer from GitHub (4xx), with its typed error.
 * - `sent-unknown`: the request may have been applied: no answer, a 5xx, a 408, or a 2xx whose
 *   body could not be read or parsed (`accepted` says GitHub did answer 2xx).
 */
export type SendResult =
  | { kind: "answered"; status: number; body: unknown }
  | { kind: "refused"; error: GitHubAdapterError }
  | { kind: "sent-unknown"; reason: string; status?: number; accepted: boolean };

const PATH =
  /^\/repos\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/(issues|pulls)(\/[0-9]+)?(\/(comments|reviews))?$|^\/repos\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/issues\/comments\/[0-9]+$/;

export async function sendWrite(
  options: SendOptions,
  kind: WriteMethodKind,
  path: string,
  payload: Record<string, unknown>,
): Promise<SendResult> {
  const method = WRITE_METHODS[kind];
  if (!PATH.test(path))
    throw new GitHubAdapterError("invalid-input", "The write path is not a supported API path");
  const url = new URL(`${options.base}${path}`);
  if (url.origin !== options.origin)
    throw new GitHubAdapterError("unapproved-origin", "Unapproved outbound host");
  // Resolved before sending: a failing token provider is a refusal, never an uncertain write.
  let token: string;
  try {
    token = await options.token();
  } catch {
    throw new GitHubAdapterError("unauthorized", "The token provider failed; nothing was sent");
  }
  if (typeof token !== "string" || token.length === 0)
    throw new GitHubAdapterError(
      "unauthorized",
      "The token provider returned no token; nothing was sent",
    );
  let res: Response;
  try {
    res = await options.fetchImpl(url, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(options.timeoutMs),
      headers: {
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": API_VERSION,
        Authorization: `Bearer ${token}`,
        ...(options.userAgent ? { "User-Agent": options.userAgent } : {}),
      },
      body: JSON.stringify(payload),
    });
  } catch {
    return { kind: "sent-unknown", reason: "no answer (network or timeout)", accepted: false };
  }
  if (!res.ok) {
    // A gateway error or timeout from GitHub's edge says nothing about whether the write applied.
    if (res.status >= 500 || res.status === 408)
      return {
        kind: "sent-unknown",
        reason: `HTTP ${res.status}`,
        status: res.status,
        accepted: false,
      };
    return { kind: "refused", error: classifyStatus(res.status, res.headers) };
  }
  const status = res.status;
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > options.maxBodyBytes)
    return { kind: "sent-unknown", reason: "response too large", status, accepted: true };
  let text: string;
  try {
    text = await res.text();
  } catch {
    return { kind: "sent-unknown", reason: "response body unreadable", status, accepted: true };
  }
  if (text.length > options.maxBodyBytes)
    return { kind: "sent-unknown", reason: "response too large", status, accepted: true };
  try {
    return { kind: "answered", status, body: JSON.parse(text) as unknown };
  } catch {
    return { kind: "sent-unknown", reason: "response not JSON", status, accepted: true };
  }
}
