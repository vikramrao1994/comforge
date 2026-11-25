import { GitHubAdapterError } from "./errors.ts";
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
export declare const WRITE_METHODS: {
    readonly "issue.create": "POST";
    readonly "issue.comment": "POST";
    readonly "pull.review": "POST";
    readonly "pull.create": "POST";
    readonly "issue.update": "PATCH";
    readonly "comment.update": "PATCH";
};
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
export type SendResult = {
    kind: "answered";
    status: number;
    body: unknown;
} | {
    kind: "refused";
    error: GitHubAdapterError;
} | {
    kind: "sent-unknown";
    reason: string;
    status?: number;
    accepted: boolean;
};
export declare function sendWrite(options: SendOptions, kind: WriteMethodKind, path: string, payload: Record<string, unknown>): Promise<SendResult>;
