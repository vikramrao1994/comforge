/**
 * Result shaping: summary first, bounded, paginated, redacted.
 *
 * A tool result is `{schema, tool, ok, summary, data, page?}`; a refusal is a structured
 * error `{schema, code, message, exit, retryable, hint?, detail?}` returned with `isError`.
 * Nothing here decides governance: codes and exit classes are @comforge/cli's own.
 */
import { detectSecrets } from "@comforge/cli";
import { ERROR_SCHEMA, LIMITS, RESULT_SCHEMA } from "./contracts.js";
export class ToolRefusal extends Error {
    code;
    exit;
    detail;
    hint;
    constructor(code, message, exit = 1, detail = {}, hint) {
        super(message);
        this.code = code;
        this.exit = exit;
        this.detail = detail;
        this.hint = hint;
    }
}
/** Codes this server adds; every other code is @comforge/cli's. */
export const MCP_CODES = {
    "unknown-repository": "the repository id is not allowlisted for this principal",
    "repository-mismatch": "the repository's trusted configuration names another repository",
    "profile-denied": "the principal's profiles do not include this tool",
    "execution-unavailable": "this transport has no host-provided isolation for repository commands",
    "command-scope-unsupported": "the published grant format cannot scope a grant to this command",
    "result-too-large": "the request would return more than the result bound",
    unavailable: "the published dependency does not provide this read",
};
const HINTS = {
    "authorization-required": "the trusted configuration has no security.authorization; that is an owner decision",
    unauthorized: "a write needs a valid owner grant for this initiative and head (operator mode needs none)",
    "credential-missing": "the server has no credential for this repository; credentials are server-owned",
    "validation-missing": "run comforge_verify on this exact commit first",
    stale: "re-read the pull request or initiative; the head moved",
    "untrusted-config-change": "configuration changes take effect only from the trusted base branch",
    incomplete: "call comforge_recover, then retry",
    ambiguous: "call comforge_recover; an earlier write may have been applied",
    cancelled: "the call stopped between stages; comforge_status shows where",
    "execution-unavailable": "use a local stdio server, or a host that provides isolation",
    "command-scope-unsupported": "run cleanup through the comforge CLI as the owner",
    "unknown-repository": "comforge_capabilities lists the repositories you may use",
};
/** Retrying the same call can help only for transient failures, never for a refusal. */
const RETRYABLE = new Set(["git-failed", "github-failed", "io", "ledger"]);
/** Replaces every value a caller must never see: the call's credentials and secret-like text. */
export function redact(value, secrets) {
    const known = secrets.filter((s) => s.length >= 8);
    const visit = (v, depth) => {
        if (depth > 12)
            return "[depth limit]";
        if (typeof v === "string") {
            let out = v;
            for (const s of known)
                out = out.split(s).join("[redacted]");
            return detectSecrets(out).count > 0 ? "[redacted: secret-like text]" : out;
        }
        if (Array.isArray(v))
            return v.map((x) => visit(x, depth + 1));
        if (v && typeof v === "object")
            return Object.fromEntries(Object.entries(v)
                .filter(([k]) => !/token|secret|password|passphrase|privatekey/i.test(k))
                .map(([k, x]) => [k, visit(x, depth + 1)]));
        return v;
    };
    return visit(value, 0);
}
export function fromServiceError(error) {
    return {
        schema: ERROR_SCHEMA,
        code: error.code,
        message: error.message,
        exit: error.exit,
        retryable: RETRYABLE.has(error.code),
        ...(HINTS[error.code] ? { hint: HINTS[error.code] } : {}),
        ...(Object.keys(error.detail ?? {}).length > 0
            ? { detail: bound(error.detail, 4_000) }
            : {}),
    };
}
export function fromRefusal(r) {
    return {
        schema: ERROR_SCHEMA,
        code: r.code,
        message: r.message,
        exit: r.exit,
        retryable: false,
        ...((r.hint ?? HINTS[r.code]) ? { hint: r.hint ?? HINTS[r.code] } : {}),
        ...(Object.keys(r.detail).length > 0 ? { detail: r.detail } : {}),
    };
}
export function internalError() {
    return {
        schema: ERROR_SCHEMA,
        code: "internal",
        message: "the server failed unexpectedly; nothing about the failure is returned",
        exit: 3,
        retryable: false,
    };
}
/** Truncates long strings and caps the serialized size of a value. */
export function bound(value, maxChars = LIMITS.maxResultChars) {
    const clip = (v, depth) => {
        if (typeof v === "string")
            return v.length > LIMITS.detailChars ? `${v.slice(0, LIMITS.detailChars)}… [truncated]` : v;
        if (depth > 12)
            return "[depth limit]";
        if (Array.isArray(v))
            return v.map((x) => clip(x, depth + 1));
        if (v && typeof v === "object")
            return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clip(x, depth + 1)]));
        return v;
    };
    const clipped = clip(value, 0);
    const text = JSON.stringify(clipped) ?? "null";
    if (text.length <= maxChars)
        return clipped;
    return {
        truncated: true,
        chars: text.length,
        excerpt: `${text.slice(0, Math.max(0, maxChars - 200))}…`,
    };
}
export function excerpt(text, detail) {
    const max = detail ? LIMITS.detailChars : LIMITS.excerptChars;
    return text.length > max
        ? { text: text.slice(0, max), truncated: true }
        : { text, truncated: false };
}
export function paginate(all, cursor, pageSize) {
    const size = Math.min(pageSize ?? LIMITS.pageSize, LIMITS.maxPageSize);
    const start = cursor ? Number(cursor) : 0;
    const items = all.slice(start, start + size);
    const nextAt = start + items.length;
    return {
        items,
        page: {
            cursor: String(start),
            next: nextAt < all.length ? String(nextAt) : null,
            total: all.length,
            pageSize: size,
        },
    };
}
export function success(tool, summary, data, page, exit = 0) {
    return { schema: RESULT_SCHEMA, tool, ok: true, exit, summary, data, ...(page ? { page } : {}) };
}
/** A delivery the CLI recorded as incomplete: its code, at the stage that failed. */
export function incompleteDelivery(v, exit) {
    const code = v.error?.code ?? "incomplete";
    return {
        schema: ERROR_SCHEMA,
        code,
        message: v.error?.message ?? "the delivery is incomplete",
        exit,
        retryable: RETRYABLE.has(code),
        ...(HINTS[code] ? { hint: HINTS[code] } : {}),
        detail: bound({
            delivery: v.delivery,
            attempt: v.attempt ?? null,
            failedStage: v.failedStage ?? null,
            stages: v.stages,
            cause: v.error?.detail ?? null,
        }, 6_000),
    };
}
