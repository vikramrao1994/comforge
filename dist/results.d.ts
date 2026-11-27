/**
 * Result shaping: summary first, bounded, paginated, redacted.
 *
 * A tool result is `{schema, tool, ok, summary, data, page?}`; a refusal is a structured
 * error `{schema, code, message, exit, retryable, hint?, detail?}` returned with `isError`.
 * Nothing here decides governance: codes and exit classes are @comforge/cli's own.
 */
import { type ServiceError } from "@comforge/cli";
import { ERROR_SCHEMA, RESULT_SCHEMA, type ToolName } from "./contracts.ts";
export interface McpError {
    schema: typeof ERROR_SCHEMA;
    code: string;
    message: string;
    /** @comforge/cli exit class: 1 refused, 2 usage, 3 failed, 4 incomplete. */
    exit: number;
    retryable: boolean;
    hint?: string;
    detail?: Record<string, unknown>;
}
export declare class ToolRefusal extends Error {
    readonly code: string;
    readonly exit: number;
    readonly detail: Record<string, unknown>;
    readonly hint: string | undefined;
    constructor(code: string, message: string, exit?: number, detail?: Record<string, unknown>, hint?: string);
}
/** Codes this server adds; every other code is @comforge/cli's. */
export declare const MCP_CODES: {
    readonly "unknown-repository": "the repository id is not allowlisted for this principal";
    readonly "repository-mismatch": "the repository's trusted configuration names another repository";
    readonly "profile-denied": "the principal's profiles do not include this tool";
    readonly "execution-unavailable": "this transport has no host-provided isolation for repository commands";
    readonly "command-scope-unsupported": "the published grant format cannot scope a grant to this command";
    readonly "result-too-large": "the request would return more than the result bound";
    readonly unavailable: "the published dependency does not provide this read";
    readonly "checkout-required": "the tool needs a repository checkout; this repository is served without one";
    readonly "config-missing": "the host supplied no trusted configuration for this repository";
    readonly "config-stale": "the host's trusted configuration snapshot is older than allowed";
    readonly "config-mismatch": "the configuration is not the pinned one, or not what GitHub holds at its revision";
};
/** Replaces every value a caller must never see: the call's credentials and secret-like text. */
export declare function redact(value: unknown, secrets: readonly string[]): unknown;
export declare function fromServiceError(error: ServiceError): McpError;
export declare function fromRefusal(r: ToolRefusal): McpError;
export declare function internalError(): McpError;
/** Truncates long strings and caps the serialized size of a value. */
export declare function bound(value: unknown, maxChars?: number): unknown;
export declare function excerpt(text: string, detail: boolean): {
    text: string;
    truncated: boolean;
};
export interface Page<T> {
    items: T[];
    page: {
        cursor: string;
        next: string | null;
        total: number;
        pageSize: number;
    };
}
export declare function paginate<T>(all: readonly T[], cursor?: string, pageSize?: number): Page<T>;
export interface ToolSuccess {
    schema: typeof RESULT_SCHEMA;
    tool: ToolName;
    ok: true;
    /** @comforge/cli exit class of the result: 0, or 1 for a recorded FAIL (verify). */
    exit: number;
    summary: string;
    data: Record<string, unknown>;
    page?: Page<unknown>["page"];
}
export declare function success(tool: ToolName, summary: string, data: Record<string, unknown>, page?: Page<unknown>["page"], exit?: number): ToolSuccess;
/** A delivery the CLI recorded as incomplete: its code, at the stage that failed. */
export declare function incompleteDelivery(v: {
    delivery: string;
    attempt?: number;
    failedStage?: string;
    stages: Record<string, unknown>;
    error?: {
        code?: string;
        message: string;
        detail?: unknown;
    };
}, exit: number): McpError;
