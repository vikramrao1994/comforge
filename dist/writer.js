import { z } from "zod";
import { GitHubAdapterError } from "./errors.js";
import { bodyDigest, carriesMarker, correlationMarker, describe, markedBody, WRITE_CAPABILITIES, } from "./operations.js";
import { sendWrite } from "./request.js";
import { createFetchTransport, DEFAULTS } from "./transport.js";
export const DEFAULT_WRITER_LIMITS = {
    reconcileMaxPages: 5,
    leaseMs: 120_000,
    maxAuthorizationTtlMs: 15 * 60_000,
    searchSkewMs: 10 * 60_000,
};
const NAME = /^[A-Za-z0-9_.-]{1,100}$/;
const NAMESPACE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\[bot\])?$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters
const CONTROL = /[\u0000-\u001f\u007f]/;
const CREATES = new Set([
    "issue.create",
    "issue.comment",
    "pull.review",
    "pull.create",
]);
const User = z.object({ login: z.string() }).nullable().optional();
const IssueRead = z.object({
    number: z.number().int().positive(),
    title: z.string(),
    body: z.string().nullable().optional(),
    state: z.string(),
    state_reason: z.string().nullable().optional(),
    locked: z.boolean().optional(),
    labels: z.array(z.union([z.string(), z.object({ name: z.string() })])).optional(),
    assignees: z
        .array(z.object({ login: z.string() }))
        .nullable()
        .optional(),
    pull_request: z.unknown().optional(),
    html_url: z.string(),
    updated_at: z.string(),
    user: User,
});
const CommentRead = z.object({
    id: z.number().int().positive(),
    body: z.string().nullable().optional(),
    html_url: z.string(),
    issue_url: z.string(),
    updated_at: z.string(),
    user: User,
});
const Ref = z.object({
    ref: z.string(),
    sha: z.string(),
    repo: z.object({ full_name: z.string() }).nullable().optional(),
});
const PullRead = z.object({
    number: z.number().int().positive(),
    title: z.string(),
    body: z.string().nullable().optional(),
    state: z.string(),
    draft: z.boolean().optional(),
    merged_at: z.string().nullable().optional(),
    html_url: z.string(),
    updated_at: z.string().optional(),
    head: Ref,
    base: Ref,
    user: User,
});
const ReviewRead = z.object({
    id: z.number().int().positive(),
    commit_id: z.string().nullable().optional(),
    state: z.string(),
    body: z.string().nullable().optional(),
    user: User,
});
/** The fields a reconciliation search needs from any listed issue, comment, review or pull request. */
const Listed = z.object({
    id: z.number().optional(),
    number: z.number().optional(),
    body: z.string().nullable().optional(),
    user: User,
});
const GitRefRead = z.object({
    ref: z.string(),
    object: z.object({ sha: z.string(), type: z.string() }),
});
const REVIEW_STATE = {
    COMMENT: "COMMENTED",
    APPROVE: "APPROVED",
    REQUEST_CHANGES: "CHANGES_REQUESTED",
};
function fail(code, message, detail = {}) {
    throw new GitHubAdapterError(code, message, detail);
}
function parse(schema, body, what) {
    const parsed = schema.safeParse(body);
    if (!parsed.success)
        fail("malformed-response", `Unexpected GitHub response for ${what}`);
    return parsed.data;
}
const labelNames = (labels) => (labels ?? []).map((l) => (typeof l === "string" ? l : l.name));
const sameSet = (a, b) => a.length === b.length && [...a].sort().join("\n") === [...b].sort().join("\n");
export function createGitHubWriter(options) {
    const { owner, name } = options.repository ?? {};
    if (!NAME.test(owner ?? "") || !NAME.test(name ?? ""))
        fail("invalid-input", "Invalid repository owner or name");
    const repository = `${owner}/${name}`;
    const root = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
    if (!Array.isArray(options.capabilities) || options.capabilities.length === 0)
        fail("invalid-input", "A writer needs at least one explicit capability");
    for (const capability of options.capabilities)
        if (!WRITE_CAPABILITIES.includes(capability))
            fail("invalid-input", `Unknown capability: ${String(capability)}`);
    const capabilities = Object.freeze([...new Set(options.capabilities)]);
    if (typeof options.authorize !== "function")
        fail("invalid-input", "authorize is required");
    if (typeof options.clock !== "function")
        fail("invalid-input", "clock is required");
    const ledger = options.ledger;
    if (!ledger ||
        typeof ledger.get !== "function" ||
        typeof ledger.create !== "function" ||
        typeof ledger.replace !== "function")
        fail("invalid-input", "A durable operation ledger is required");
    if (options.expectedAuthor !== undefined && !LOGIN.test(options.expectedAuthor))
        fail("invalid-input", "Invalid expectedAuthor");
    const namespace = options.markers === false ? null : (options.markers?.namespace ?? "comforge");
    if (namespace !== null && !NAMESPACE.test(namespace))
        fail("invalid-input", "Invalid marker namespace");
    const limits = { ...DEFAULT_WRITER_LIMITS, ...options.limits };
    if (!(Number.isSafeInteger(limits.reconcileMaxPages) &&
        limits.reconcileMaxPages >= 1 &&
        limits.reconcileMaxPages <= 50) ||
        !(limits.leaseMs > 0 && limits.maxAuthorizationTtlMs > 0 && limits.searchSkewMs >= 0))
        fail("invalid-input", "Invalid writer limits");
    const apiOrigin = options.apiOrigin ?? DEFAULTS.apiOrigin;
    const fetchImpl = (...args) => (options.fetchImpl ?? globalThis.fetch)(...args);
    const token = async () => (typeof options.token === "function" ? options.token() : options.token);
    const transport = createFetchTransport({
        token,
        fetchImpl: fetchImpl,
        apiOrigin,
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        ...(options.maxBodyBytes !== undefined ? { maxBodyBytes: options.maxBodyBytes } : {}),
        ...(options.userAgent !== undefined ? { userAgent: options.userAgent } : {}),
    });
    const sendOptions = {
        origin: new URL(apiOrigin).origin,
        base: apiOrigin.replace(/\/+$/, ""),
        token,
        fetchImpl: fetchImpl,
        timeoutMs: options.timeoutMs ?? DEFAULTS.timeoutMs,
        maxBodyBytes: options.maxBodyBytes ?? DEFAULTS.maxBodyBytes,
        ...(options.userAgent !== undefined ? { userAgent: options.userAgent } : {}),
    };
    const now = () => {
        const t = options.clock();
        if (!Number.isFinite(t))
            fail("invalid-input", "The clock returned no time");
        return t;
    };
    const read = (segments, query) => transport.get(`${root}/${segments.map((s) => encodeURIComponent(String(s))).join("/")}`, query);
    const readRef = (branch) => transport.get(`${root}/git/ref/heads/${branch.split("/").map(encodeURIComponent).join("/")}`);
    // --- ledger -------------------------------------------------------------------------------
    async function store(call) {
        try {
            return await call();
        }
        catch (error) {
            if (error instanceof GitHubAdapterError)
                throw error;
            fail("ledger-failure", "The operation ledger failed");
        }
    }
    /** Compare-and-swap; `false` means another caller changed the record first. */
    async function advance(record, changes) {
        const next = {
            ...record,
            ...changes,
            version: record.version + 1,
            changedAt: now(),
        };
        return (await store(() => ledger.replace(record.operationId, record.version, next)))
            ? next
            : null;
    }
    /** As `advance`, after a send: a ledger failure must not hide what happened on GitHub. */
    async function settle(record, changes) {
        try {
            return (await advance(record, changes)) !== null;
        }
        catch {
            return false;
        }
    }
    function storedOutcome(record, replayed) {
        if (!record.outcome)
            fail("conflict", "The operation has no recorded outcome", { reason: record.state });
        return { ...record.outcome, replayed, recorded: true };
    }
    async function refuse(record, error, retryable) {
        const retryAfter = error.detail.retryAfterSeconds;
        await settle(record, {
            state: "failed",
            leaseUntil: null,
            failure: {
                code: error.code,
                message: error.message,
                ...(error.detail.status !== undefined ? { status: error.detail.status } : {}),
                retryable,
                notBefore: typeof retryAfter === "number" ? now() + retryAfter * 1000 : null,
            },
        });
        throw error;
    }
    // --- authorization ------------------------------------------------------------------------
    async function authorize(descriptor) {
        let decision;
        try {
            decision = await options.authorize(descriptor);
        }
        catch {
            fail("authorization-denied", "The authorization callback failed; nothing was sent");
        }
        const d = decision;
        if (!d || typeof d !== "object" || d.allow !== true) {
            const reason = d && typeof d.reason === "string" ? d.reason.slice(0, 200) : undefined;
            fail("authorization-denied", "The consumer's policy did not allow this operation", reason ? { reason } : {});
        }
        if (d.descriptorDigest !== descriptor.digest)
            fail("authorization-denied", "The authorization is for a different descriptor");
        const t = now();
        if (typeof d.expiresAt !== "number" || !Number.isFinite(d.expiresAt) || d.expiresAt <= t)
            fail("authorization-denied", "The authorization has expired or has no expiry");
        if (d.expiresAt > t + limits.maxAuthorizationTtlMs)
            fail("authorization-denied", "The authorization lives longer than the writer accepts");
        if (d.reference !== undefined &&
            (typeof d.reference !== "string" || d.reference.length > 200 || CONTROL.test(d.reference)))
            fail("authorization-denied", "The authorization reference is malformed");
        return { expiresAt: d.expiresAt, reference: d.reference ?? null };
    }
    // --- per-kind GitHub mechanics --------------------------------------------------------------
    function writePath(d) {
        const t = d.target;
        switch (d.kind) {
            case "issue.create":
                return `${root}/issues`;
            case "issue.comment":
                return `${root}/issues/${t.number}/comments`;
            case "pull.review":
                return `${root}/pulls/${t.number}/reviews`;
            case "pull.create":
                return `${root}/pulls`;
            case "pull.update":
                return `${root}/pulls/${t.number}`;
            case "issue.update":
                return `${root}/issues/${t.number}`;
            case "comment.update":
                return `${root}/issues/comments/${t.id}`;
        }
    }
    function payloadOf(d, marker) {
        const payload = { ...d.payload };
        if (CREATES.has(d.kind))
            payload.body = markedBody(String(payload.body ?? ""), marker);
        return payload;
    }
    /** Reads what must hold before the write. Throws a refusal; nothing has been sent. */
    async function preflight(d) {
        const pre = d.precondition;
        switch (d.kind) {
            case "issue.create":
                return {};
            case "issue.comment": {
                const number = d.target.number;
                const issue = parse(IssueRead, await read(["issues", number]), "an issue");
                const isPull = issue.pull_request !== undefined && issue.pull_request !== null;
                if (isPull !== (pre.thread === "pull-request"))
                    fail("wrong-target", `#${number} is ${isPull ? "a pull request" : "an issue"}, not the expected thread`);
                if (issue.state !== "open" && pre.allowClosed !== true)
                    fail("conflict", `#${number} is ${issue.state}`, { reason: "closed" });
                if (issue.locked === true && pre.allowLocked !== true)
                    fail("conflict", `#${number} is locked`, { reason: "locked" });
                return {};
            }
            case "pull.review": {
                const pull = parse(PullRead, await read(["pulls", d.target.number]), "a pull request");
                if (pull.state !== "open" || pull.merged_at)
                    fail("conflict", "The pull request is not open", { reason: "closed" });
                if (pull.head.sha !== pre.headSha)
                    fail("stale", "The pull request head is not the reviewed commit", {
                        expected: pre.headSha,
                        actual: pull.head.sha,
                    });
                return { headSha: pull.head.sha };
            }
            case "pull.create": {
                const t = d.target;
                const head = parse(GitRefRead, await readRef(t.head), "a branch");
                if (head.object.sha !== pre.headSha)
                    fail("stale", "The head branch is not at the expected commit", {
                        expected: pre.headSha,
                        actual: head.object.sha,
                    });
                if (pre.baseSha !== undefined) {
                    const base = parse(GitRefRead, await readRef(t.base), "a branch");
                    if (base.object.sha !== pre.baseSha)
                        fail("stale", "The base branch is not at the expected commit", {
                            expected: pre.baseSha,
                            actual: base.object.sha,
                        });
                }
                const open = parse(z.array(PullRead), await read(["pulls"], {
                    state: "open",
                    head: `${owner}:${t.head}`,
                    base: t.base,
                    per_page: "100",
                }), "pull requests");
                if (open.length > 0)
                    fail("conflict", "An open pull request already exists for this head and base", {
                        reason: "exists",
                        number: open[0]?.number,
                    });
                return {};
            }
            case "pull.update": {
                const pull = parse(PullRead, await read(["pulls", d.target.number]), "a pull request");
                if (pull.state !== "open" || pull.merged_at)
                    fail("conflict", "The pull request is not open", { reason: "closed" });
                await expectPull(pull, pre);
                return {};
            }
            case "issue.update": {
                const number = d.target.number;
                const issue = parse(IssueRead, await read(["issues", number]), "an issue");
                if (issue.pull_request !== undefined && issue.pull_request !== null)
                    fail("wrong-target", `#${number} is a pull request`);
                await expectState(issue.updated_at, issue.body, pre, { state: issue.state });
                return {};
            }
            case "comment.update": {
                const comment = parse(CommentRead, await read(["issues", "comments", d.target.id]), "a comment");
                if (!comment.issue_url.endsWith(`${root}/issues/${pre.issueNumber}`))
                    fail("wrong-target", "The comment is not on the expected issue in this repository");
                if (pre.author !== undefined && comment.user?.login !== pre.author)
                    fail("conflict", "The comment is by another author", { reason: "author" });
                await expectState(comment.updated_at, comment.body, pre, {});
                return {};
            }
        }
    }
    async function expectState(updatedAt, body, pre, actual) {
        if (updatedAt !== pre.updatedAt)
            fail("stale", "The target changed since it was read", {
                expected: pre.updatedAt,
                actual: updatedAt,
            });
        if (pre.bodyDigest !== undefined && (await bodyDigest(body)) !== pre.bodyDigest)
            fail("stale", "The target's body changed since it was read");
        if (pre.state !== undefined && actual.state !== pre.state)
            fail("stale", "The target's state changed since it was read");
    }
    /** A pull request edit's expected state: body always, head and update time when given. */
    async function expectPull(pull, pre) {
        if ((await bodyDigest(pull.body)) !== pre.bodyDigest)
            fail("stale", "The pull request body changed since it was read");
        if (pre.headSha !== undefined && pull.head.sha !== pre.headSha)
            fail("stale", "The pull request head is not the expected commit", {
                expected: pre.headSha,
                actual: pull.head.sha,
            });
        if (pre.updatedAt !== undefined && pull.updated_at !== pre.updatedAt)
            fail("stale", "The pull request changed since it was read", {
                expected: pre.updatedAt,
                actual: pull.updated_at,
            });
    }
    function resourceOf(d, body) {
        const target = d.target;
        switch (d.kind) {
            case "issue.create":
            case "issue.update": {
                const r = IssueRead.safeParse(body);
                return r.success ? { type: "issue", number: r.data.number, url: r.data.html_url } : null;
            }
            case "issue.comment":
            case "comment.update": {
                const r = CommentRead.safeParse(body);
                const issueNumber = d.kind === "issue.comment"
                    ? target.number
                    : d.precondition.issueNumber;
                return r.success
                    ? { type: "comment", id: r.data.id, issueNumber, url: r.data.html_url }
                    : null;
            }
            case "pull.review": {
                const r = ReviewRead.safeParse(body);
                return r.success
                    ? {
                        type: "review",
                        id: r.data.id,
                        pullNumber: target.number,
                        commitSha: r.data.commit_id ?? null,
                        state: r.data.state,
                    }
                    : null;
            }
            case "pull.create":
            case "pull.update": {
                const r = PullRead.safeParse(body);
                return r.success
                    ? { type: "pull", number: r.data.number, url: r.data.html_url, headSha: r.data.head.sha }
                    : null;
            }
        }
    }
    /** A fresh read of the written resource, compared field by field with what was authorized. */
    async function verify(d, resource, sent) {
        const mismatches = [];
        let headMoved;
        /** The resource's own read, kept only to hand back when everything matched. */
        let raw;
        const readResource = async (segments) => {
            raw = await read(segments);
            return raw;
        };
        // Identity first: a well-formed read of another resource is never this write's evidence.
        // An update's resource must be its target; every read must be the resource it asked for.
        const target = d.target;
        if ((d.kind === "issue.update" || d.kind === "pull.update") &&
            resource.number !== target.number)
            mismatches.push("identity");
        if (d.kind === "comment.update" && resource.id !== target.id)
            mismatches.push("identity");
        try {
            switch (resource.type) {
                case "issue": {
                    const issue = parse(IssueRead, await readResource(["issues", resource.number]), "an issue");
                    if (issue.number !== resource.number)
                        mismatches.push("identity");
                    if (sent.title !== undefined && issue.title !== sent.title)
                        mismatches.push("title");
                    if (sent.body !== undefined && (issue.body ?? "") !== sent.body)
                        mismatches.push("body");
                    if (sent.state !== undefined && issue.state !== sent.state)
                        mismatches.push("state");
                    if (sent.labels !== undefined &&
                        !sameSet(labelNames(issue.labels), sent.labels))
                        mismatches.push("labels");
                    if (sent.assignees !== undefined &&
                        !sameSet((issue.assignees ?? []).map((a) => a.login), sent.assignees))
                        mismatches.push("assignees");
                    break;
                }
                case "comment": {
                    const comment = parse(CommentRead, await readResource(["issues", "comments", resource.id]), "a comment");
                    if (comment.id !== resource.id)
                        mismatches.push("identity");
                    if ((comment.body ?? "") !== sent.body)
                        mismatches.push("body");
                    if (!comment.issue_url.endsWith(`${root}/issues/${resource.issueNumber}`))
                        mismatches.push("issue");
                    break;
                }
                case "review": {
                    const review = parse(ReviewRead, await readResource(["pulls", resource.pullNumber, "reviews", resource.id]), "a review");
                    if (review.id !== resource.id)
                        mismatches.push("identity");
                    if (review.commit_id !== sent.commit_id)
                        mismatches.push("commit");
                    if (review.state !== REVIEW_STATE[sent.event])
                        mismatches.push("state");
                    if ((review.body ?? "") !== sent.body)
                        mismatches.push("body");
                    const pull = parse(PullRead, await read(["pulls", resource.pullNumber]), "a pull request");
                    headMoved = pull.head.sha !== d.precondition.headSha;
                    break;
                }
                case "pull": {
                    const pull = parse(PullRead, await readResource(["pulls", resource.number]), "a pull request");
                    const pre = d.precondition;
                    if (pull.number !== resource.number)
                        mismatches.push("identity");
                    if (d.kind === "pull.update") {
                        if ((pull.body ?? "") !== sent.body)
                            mismatches.push("body");
                        if (pre.headSha !== undefined && pull.head.sha !== pre.headSha)
                            mismatches.push("head.sha");
                        break;
                    }
                    if (pull.head.sha !== pre.headSha)
                        mismatches.push("head.sha");
                    if (pull.head.ref !== sent.head)
                        mismatches.push("head.ref");
                    if (pull.head.repo?.full_name !== repository)
                        mismatches.push("head.repository");
                    if (pull.base.ref !== sent.base)
                        mismatches.push("base.ref");
                    if (pull.title !== sent.title)
                        mismatches.push("title");
                    if ((pull.body ?? "") !== sent.body)
                        mismatches.push("body");
                    break;
                }
            }
        }
        catch {
            return { verification: "unavailable", mismatches, headMoved };
        }
        const matched = mismatches.length === 0;
        return {
            verification: matched ? "matched" : "mismatch",
            mismatches,
            headMoved,
            ...(matched ? { response: { source: "verification-read", body: raw } } : {}),
        };
    }
    /** Bounded search for an uncertain create, by its marker. Reads only. */
    async function search(record) {
        const d = record.descriptor;
        const marker = record.marker;
        const empty = { complete: false, matches: 0, foreignMarkers: 0, duplicates: [] };
        if (marker === null || !CREATES.has(d.kind))
            return { found: null, body: null, report: empty };
        const since = record.firstSentAt === null
            ? undefined
            : new Date(Math.max(0, record.firstSentAt - limits.searchSkewMs)).toISOString();
        const t = d.target;
        let segments;
        let query = {};
        switch (d.kind) {
            case "issue.create":
                segments = ["issues"];
                query = { state: "all", sort: "created", direction: "desc", ...(since ? { since } : {}) };
                break;
            case "issue.comment":
                segments = ["issues", t.number, "comments"];
                query = since ? { since } : {};
                break;
            case "pull.review":
                segments = ["pulls", t.number, "reviews"];
                break;
            default:
                segments = ["pulls"];
                query = { state: "all", head: `${owner}:${t.head}`, base: t.base };
        }
        const matches = [];
        let foreign = 0;
        let complete = false;
        for (let page = 1; page <= limits.reconcileMaxPages; page++) {
            const batch = parse(z.array(z.unknown()), await read(segments, { ...query, per_page: "100", page: String(page) }), "a listing");
            for (const raw of batch) {
                const item = parse(Listed, raw, "a listed item");
                if (d.kind === "issue.create" && raw.pull_request)
                    continue;
                if (!carriesMarker(item.body, marker))
                    continue;
                if (options.expectedAuthor !== undefined && item.user?.login !== options.expectedAuthor)
                    foreign += 1;
                else
                    matches.push({ item, raw });
            }
            if (batch.length < 100) {
                complete = true;
                break;
            }
        }
        const first = matches[0];
        const report = {
            complete,
            matches: matches.length,
            foreignMarkers: foreign,
            duplicates: matches.slice(1).map((m) => m.item.id ?? m.item.number ?? 0),
        };
        if (!first)
            return { found: null, body: null, report };
        // Listings are newest-first for issues, oldest-first elsewhere; report the oldest as the write.
        const chosen = d.kind === "issue.create" ? (matches.at(-1) ?? first) : first;
        if (d.kind === "issue.create")
            report.duplicates = matches.slice(0, -1).map((m) => m.item.number ?? 0);
        return { found: resourceOf(d, chosen.raw), body: chosen.item.body ?? null, report };
    }
    function outcome(record, status, fields) {
        return {
            status,
            operationId: record.operationId,
            kind: record.kind,
            repository: record.repository,
            descriptorDigest: record.fingerprint,
            recovered: false,
            resource: null,
            verification: "not-attempted",
            mismatches: [],
            ...fields,
        };
    }
    /** The write was found by reconciliation: record it as succeeded and say how it was found. */
    async function adopt(record, found, report) {
        const sent = payloadOf(record.descriptor, record.marker);
        const checked = await verify(record.descriptor, found, sent);
        const result = outcome(record, checked.verification === "matched" ? "verified" : "accepted", {
            recovered: true,
            resource: found,
            verification: checked.verification,
            mismatches: checked.mismatches,
            reconciliation: report,
            ...(checked.headMoved !== undefined ? { headMovedDuringPublication: checked.headMoved } : {}),
        });
        const recorded = await settle(record, {
            state: "succeeded",
            leaseUntil: null,
            outcome: result,
            failure: null,
        });
        return {
            ...result,
            replayed: false,
            recorded,
            ...(checked.response ? { response: checked.response } : {}),
        };
    }
    async function markIndeterminate(record, reason, report) {
        const result = outcome(record, "indeterminate", {
            reason,
            ...(report ? { reconciliation: report } : {}),
        });
        const recorded = await settle(record, {
            state: "indeterminate",
            leaseUntil: null,
            outcome: result,
        });
        return { ...result, replayed: false, recorded };
    }
    /** For an update that may already have been sent: is it applied, still applicable, or neither? */
    async function updateStatus(d) {
        const sent = payloadOf(d, null);
        const pre = d.precondition;
        if (d.kind === "issue.update") {
            const issue = parse(IssueRead, await read(["issues", d.target.number]), "an issue");
            const applied = (sent.title === undefined || issue.title === sent.title) &&
                (sent.body === undefined || (issue.body ?? "") === sent.body) &&
                (sent.state === undefined || issue.state === sent.state) &&
                (sent.labels === undefined || sameSet(labelNames(issue.labels), sent.labels));
            if (applied)
                return "applied";
            return issue.updated_at === pre.updatedAt ? "applicable" : "diverged";
        }
        if (d.kind === "pull.update") {
            const pull = parse(PullRead, await read(["pulls", d.target.number]), "a pull request");
            if ((pull.body ?? "") === sent.body)
                return "applied";
            try {
                await expectPull(pull, pre);
            }
            catch {
                return "diverged";
            }
            return pull.state === "open" && !pull.merged_at ? "applicable" : "diverged";
        }
        const comment = parse(CommentRead, await read(["issues", "comments", d.target.id]), "a comment");
        if ((comment.body ?? "") === sent.body)
            return "applied";
        return comment.updated_at === pre.updatedAt ? "applicable" : "diverged";
    }
    // --- execution ------------------------------------------------------------------------------
    /** Takes ownership of the operation's record, or answers from it without sending. */
    async function claim(d, marker, reference) {
        for (let round = 0; round < 3; round++) {
            const existing = await store(() => ledger.get(d.operationId));
            const t = now();
            if (!existing) {
                const fresh = {
                    schema: "comforge-github-operation/v1",
                    operationId: d.operationId,
                    repository,
                    kind: d.kind,
                    capability: d.capability,
                    fingerprint: d.digest,
                    descriptor: d,
                    version: 1,
                    state: "reserved",
                    leaseUntil: t + limits.leaseMs,
                    attempts: 0,
                    firstSentAt: null,
                    changedAt: t,
                    authorizationReference: reference,
                    marker,
                    outcome: null,
                    failure: null,
                    note: null,
                };
                if (await store(() => ledger.create(fresh)))
                    return { record: fresh };
                continue;
            }
            if (existing.repository !== repository || existing.fingerprint !== d.digest)
                fail("conflict", "This operationId was already used for a different operation", {
                    reason: "fingerprint-mismatch",
                });
            switch (existing.state) {
                case "succeeded":
                    return { answer: storedOutcome(existing, true) };
                case "indeterminate":
                    return { answer: storedOutcome(existing, true) };
                case "abandoned":
                    fail("conflict", "This operation was abandoned; use a new operationId", {
                        reason: "abandoned",
                    });
                    break;
                case "reserved":
                case "sending": {
                    if (existing.leaseUntil !== null && existing.leaseUntil > t)
                        fail("conflict", "This operation is in progress elsewhere", { reason: "in-progress" });
                    if (existing.state === "sending") {
                        // The sender stopped without recording an answer: the write may have happened.
                        const taken = await advance(existing, { leaseUntil: t + limits.leaseMs });
                        if (!taken)
                            continue;
                        return {
                            answer: await markIndeterminate(taken, "a previous attempt stopped after sending"),
                        };
                    }
                    const taken = await advance(existing, {
                        leaseUntil: t + limits.leaseMs,
                        authorizationReference: reference,
                    });
                    if (taken)
                        return { record: taken };
                    continue;
                }
                case "failed": {
                    const f = existing.failure;
                    if (!f?.retryable)
                        fail(f?.code ?? "conflict", f?.message ?? "This operation failed", {
                            ...(f?.status !== undefined ? { status: f.status } : {}),
                            reason: "failed",
                        });
                    if (f.notBefore !== null && f.notBefore > t)
                        fail("rate-limited", "Retry after GitHub's requested delay", {
                            retryAfterSeconds: Math.ceil((f.notBefore - t) / 1000),
                        });
                    const taken = await advance(existing, {
                        state: "reserved",
                        leaseUntil: t + limits.leaseMs,
                        authorizationReference: reference,
                    });
                    if (taken)
                        return { record: taken };
                    continue;
                }
            }
        }
        fail("conflict", "The operation record kept changing; retry later", { reason: "in-progress" });
    }
    async function execute(operation) {
        const d = await describe(repository, operation);
        if (!capabilities.includes(d.capability))
            fail("capability-denied", `This writer was not constructed with ${d.capability}`);
        const marker = namespace !== null && CREATES.has(d.kind) ? await correlationMarker(namespace, d) : null;
        payloadOf(d, marker); // refuses an over-long body before anything is recorded
        const grant = await authorize(d);
        const claimed = await claim(d, marker, grant.reference);
        if ("answer" in claimed)
            return claimed.answer;
        let record = claimed.record;
        // A create that may already have reached GitHub is looked for before it is sent again.
        if (record.firstSentAt !== null) {
            if (CREATES.has(d.kind)) {
                let found;
                try {
                    found = await search(record);
                }
                catch {
                    return markIndeterminate(record, "could not search for an earlier attempt");
                }
                if (found.found)
                    return adopt(record, found.found, found.report);
                if (!found.report.complete)
                    return markIndeterminate(record, "an earlier attempt could not be ruled out", found.report);
            }
            else {
                const status = await updateStatus(d).catch(() => "diverged");
                if (status === "applied")
                    return adopt(record, resourceOf(d, await readTarget(d)), {
                        complete: true,
                        matches: 1,
                        foreignMarkers: 0,
                        duplicates: [],
                    });
                if (status === "diverged")
                    return markIndeterminate(record, "the target changed after an earlier attempt");
            }
        }
        try {
            await preflight(d);
        }
        catch (error) {
            const e = error instanceof GitHubAdapterError
                ? error
                : new GitHubAdapterError("malformed-response", "Precondition read failed");
            // Stale or wrong targets are permanent for this exact descriptor; transient reads are not.
            return refuse(record, e, ["timeout", "network", "rate-limited", "http-error"].includes(e.code));
        }
        if (grant.expiresAt <= now())
            return refuse(record, new GitHubAdapterError("authorization-denied", "The authorization expired before the write"), true);
        const sending = await advance(record, {
            state: "sending",
            attempts: record.attempts + 1,
            firstSentAt: record.firstSentAt ?? now(),
            leaseUntil: now() + limits.leaseMs,
        });
        if (!sending)
            fail("conflict", "Another caller took this operation", { reason: "in-progress" });
        record = sending;
        const sent = payloadOf(d, marker);
        let result;
        try {
            result = await sendWrite(sendOptions, d.kind, writePath(d), sent);
        }
        catch (error) {
            // Refused before sending (token provider, path): nothing reached GitHub.
            const e = error instanceof GitHubAdapterError
                ? error
                : new GitHubAdapterError("network", "The request could not be built");
            return refuse(record, e, true);
        }
        if (result.kind === "refused")
            return refuse(record, result.error, result.error.code === "rate-limited");
        if (result.kind === "sent-unknown") {
            // Look once; never resend.
            const found = CREATES.has(d.kind) ? await search(record).catch(() => null) : null;
            if (found?.found)
                return adopt(record, found.found, found.report);
            if (!CREATES.has(d.kind)) {
                const status = await updateStatus(d).catch(() => "diverged");
                if (status === "applied")
                    return adopt(record, resourceOf(d, await readTarget(d)), {
                        complete: true,
                        matches: 1,
                        foreignMarkers: 0,
                        duplicates: [],
                    });
            }
            return markIndeterminate(record, `GitHub's answer is unknown (${result.reason})`, found?.report);
        }
        const resource = resourceOf(d, result.body);
        if (!resource)
            return markIndeterminate(record, "GitHub accepted the request but its response was unreadable");
        const checked = await verify(d, resource, sent);
        const final = outcome(record, checked.verification === "matched" ? "verified" : "accepted", {
            resource,
            verification: checked.verification,
            mismatches: checked.mismatches,
            ...(checked.headMoved !== undefined ? { headMovedDuringPublication: checked.headMoved } : {}),
        });
        const recorded = await settle(record, {
            state: "succeeded",
            leaseUntil: null,
            outcome: final,
            failure: null,
        });
        return {
            ...final,
            replayed: false,
            recorded,
            ...(checked.response ? { response: checked.response } : {}),
        };
    }
    async function readTarget(d) {
        if (d.kind === "pull.update")
            return read(["pulls", d.target.number]);
        return d.kind === "issue.update"
            ? read(["issues", d.target.number])
            : read(["issues", "comments", d.target.id]);
    }
    async function reconcile(operationId) {
        const record = await store(() => ledger.get(operationId));
        if (!record || record.repository !== repository)
            fail("not-found", "No such operation in the ledger");
        if (record.state === "succeeded")
            return storedOutcome(record, true);
        const t = now();
        if (record.state === "sending" && record.leaseUntil !== null && record.leaseUntil > t)
            fail("conflict", "This operation is in progress elsewhere", { reason: "in-progress" });
        if (record.state !== "indeterminate" && record.state !== "sending")
            fail("conflict", `A ${record.state} operation has nothing to reconcile`, {
                reason: record.state,
            });
        const owned = await advance(record, { leaseUntil: t + limits.leaseMs });
        if (!owned)
            fail("conflict", "Another caller changed this operation", { reason: "in-progress" });
        const d = owned.descriptor;
        if (CREATES.has(d.kind)) {
            const found = await search(owned);
            if (found.found)
                return adopt(owned, found.found, found.report);
            return markIndeterminate(owned, owned.marker === null
                ? "no correlation marker: resolve by inspection, then abandon"
                : found.report.complete
                    ? "not found; it may still appear, or it was never created — abandon to give up"
                    : "the search was incomplete", found.report);
        }
        const status = await updateStatus(d);
        if (status === "applied")
            return adopt(owned, resourceOf(d, await readTarget(d)), {
                complete: true,
                matches: 1,
                foreignMarkers: 0,
                duplicates: [],
            });
        if (status === "applicable") {
            // Not applied, and the target is as authorized: a later execute may send it again.
            await settle(owned, {
                state: "failed",
                leaseUntil: null,
                outcome: null,
                failure: {
                    code: "incomplete",
                    message: "The update was not applied",
                    retryable: true,
                    notBefore: null,
                },
            });
            return {
                ...outcome(owned, "indeterminate", { reason: "not applied; execute again to resend" }),
                replayed: false,
                recorded: true,
            };
        }
        return markIndeterminate(owned, "the target changed after the attempt; inspect it, then abandon");
    }
    async function abandon(operationId, reason) {
        if (typeof reason !== "string" ||
            reason.trim().length === 0 ||
            reason.length > 500 ||
            CONTROL.test(reason.replace(/\n/g, " ")))
            fail("invalid-input", "An abandonment needs a one-line reason");
        const record = await store(() => ledger.get(operationId));
        if (!record || record.repository !== repository)
            fail("not-found", "No such operation in the ledger");
        if (record.state === "succeeded")
            fail("conflict", "A succeeded operation cannot be abandoned", { reason: "succeeded" });
        if (record.state === "abandoned")
            return;
        if ((record.state === "sending" || record.state === "reserved") &&
            record.leaseUntil !== null &&
            record.leaseUntil > now())
            fail("conflict", "This operation is in progress elsewhere", { reason: "in-progress" });
        if (!(await advance(record, { state: "abandoned", leaseUntil: null, note: reason.trim() })))
            fail("conflict", "Another caller changed this operation", { reason: "in-progress" });
    }
    return Object.freeze({
        repository,
        capabilities,
        prepare: (operation) => describe(repository, operation),
        execute,
        reconcile,
        abandon,
    });
}
