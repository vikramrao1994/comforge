import { z } from "zod";
import { GitHubAdapterError } from "./errors.js";
/**
 * Typed GitHub evidence for one repository. GitHub is an external evidence source: every
 * value returned here is what GitHub said at read time, and text written by people (titles,
 * bodies, review text) is data marked `untrusted`, never an instruction or a proof. Nothing
 * here authorizes anything; `@comforge/core` verifies grants, receipts and records.
 *
 * Mutable state is never passed off as immutable: a pull request's files and the checks of a
 * commit are read for an exact SHA, and a head that moves during the read is refused (`stale`)
 * rather than silently followed.
 */
export const UNTRUSTED = "untrusted";
export const DEFAULT_LIMITS = { perPage: 100, maxPages: 10, maxTextChars: 65_536 };
const NAME = /^[A-Za-z0-9_.-]{1,100}$/;
const SHA = /^[0-9a-f]{40}$/;
const User = z.object({ login: z.string() }).nullable().optional();
const Label = z.union([z.string(), z.object({ name: z.string() })]);
const App = z.object({ slug: z.string() }).nullable().optional();
const IssueSchema = z.object({
    number: z.number().int().positive(),
    title: z.string(),
    body: z.string().nullable().optional(),
    state: z.string(),
    html_url: z.string(),
    user: User,
    labels: z.array(Label).optional(),
    pull_request: z.unknown().optional(),
    created_at: z.string(),
    updated_at: z.string(),
    author_association: z.string().optional(),
    performed_via_github_app: App,
    closed_at: z.string().nullable().optional(),
    comments: z.number().int().nonnegative().optional(),
});
const RefSchema = z.object({
    ref: z.string(),
    sha: z.string().regex(SHA),
    repo: z.object({ full_name: z.string() }).nullable().optional(),
});
const PullSchema = z.object({
    number: z.number().int().positive(),
    title: z.string(),
    state: z.string(),
    draft: z.boolean().optional(),
    merged: z.boolean().optional(),
    merged_at: z.string().nullable().optional(),
    html_url: z.string(),
    user: User,
    base: RefSchema,
    head: RefSchema,
    body: z.string().nullable().optional(),
    created_at: z.string().optional(),
    updated_at: z.string().optional(),
    commits: z.number().int().nonnegative().optional(),
    changed_files: z.number().int().nonnegative().optional(),
});
const CommentSchema = z.object({
    id: z.number().int(),
    user: z.object({ login: z.string(), type: z.string().optional() }).nullable().optional(),
    author_association: z.string().optional(),
    created_at: z.string(),
    updated_at: z.string(),
    body: z.string().nullable().optional(),
    html_url: z.string().optional(),
    issue_url: z.string().optional(),
    performed_via_github_app: App,
});
const PullListSchema = z.object({
    number: z.number().int().positive(),
    title: z.string(),
    state: z.string(),
    draft: z.boolean().optional(),
    merged_at: z.string().nullable().optional(),
    user: User,
    head: z.object({ ref: z.string(), sha: z.string().regex(SHA) }),
    base: z.object({ ref: z.string(), sha: z.string().regex(SHA).optional() }),
    created_at: z.string(),
    updated_at: z.string(),
});
const EventSchema = z.object({
    id: z.number().int().optional(),
    event: z.string(),
    actor: User,
    created_at: z.string(),
    label: z.object({ name: z.string() }).nullable().optional(),
    performed_via_github_app: App,
});
const ReviewCommentSchema = z.object({
    id: z.number().int(),
    user: User,
    path: z.string(),
    line: z.number().int().nullable().optional(),
    commit_id: z.string(),
    created_at: z.string(),
    body: z.string().nullable().optional(),
});
const CommitRefSchema = z.object({ sha: z.string().regex(SHA) });
const ContentsSchema = z.object({
    type: z.string(),
    path: z.string(),
    sha: z.string().regex(SHA),
    size: z.number().int().nonnegative(),
    encoding: z.string().optional(),
    content: z.string().nullable().optional(),
});
const FileSchema = z.object({
    filename: z.string(),
    previous_filename: z.string().optional(),
    status: z.string(),
    additions: z.number().int(),
    deletions: z.number().int(),
    changes: z.number().int(),
    patch: z.string().optional(),
});
const ReviewSchema = z.object({
    id: z.number().int(),
    user: User,
    state: z.string(),
    commit_id: z.string().nullable().optional(),
    submitted_at: z.string().nullable().optional(),
    body: z.string().nullable().optional(),
});
const CheckRunsSchema = z.object({
    total_count: z.number().int().nonnegative(),
    check_runs: z.array(z.object({
        id: z.number().int(),
        name: z.string(),
        head_sha: z.string(),
        status: z.string(),
        conclusion: z.string().nullable(),
        started_at: z.string().nullable().optional(),
        completed_at: z.string().nullable().optional(),
        app: z.object({ slug: z.string() }).nullable().optional(),
    })),
});
const WorkflowRunsSchema = z.object({
    total_count: z.number().int().nonnegative(),
    workflow_runs: z.array(z.object({
        id: z.number().int(),
        name: z.string().nullable(),
        head_sha: z.string(),
        status: z.string().nullable(),
        conclusion: z.string().nullable(),
        event: z.string(),
        created_at: z.string(),
    })),
});
/** Extensions whose missing patch means binary content, not an unreadable one. */
const BINARY_EXTENSIONS = /\.(png|jpe?g|gif|webp|avif|ico|pdf|zip|gz|woff2?|ttf|bin|db|sqlite)$/i;
const CompareSchema = z.object({
    status: z.enum(["identical", "ahead", "behind", "diverged"]),
    ahead_by: z.number().int().nonnegative(),
    behind_by: z.number().int().nonnegative(),
    base_commit: z.object({ sha: z.string().regex(SHA) }),
    merge_base_commit: z.object({ sha: z.string().regex(SHA) }),
});
export const DEFAULT_PATCH_LIMITS = {
    perFileMaxChars: 20_000,
    totalMaxChars: 100_000,
};
export const DEFAULT_FILE_LIMITS = { maxBytes: 262_144 };
const SAFE_REF = /^[A-Za-z0-9._/-]{1,200}$/;
/** Refuses anything but a plain repository-relative path, before any request is made. */
function safePath(path) {
    const bad = () => new GitHubAdapterError("invalid-input", "Invalid file path");
    if (typeof path !== "string" || path.length === 0 || path.length > 1024)
        throw bad();
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is refused
    if (path.startsWith("/") || path.includes("\\") || /[\u0000-\u001f\u007f]/.test(path))
        throw bad();
    const segments = path.split("/");
    if (segments.some((s) => s === "" || s === "." || s === ".." || s.includes("..")))
        throw bad();
    return segments;
}
function positive(value, what) {
    if (!Number.isSafeInteger(value) || value < 1)
        throw new GitHubAdapterError("invalid-input", `Invalid ${what}`);
    return value;
}
function pageRequest(options) {
    const page = options?.page ?? 1;
    const perPage = options?.perPage ?? 30;
    if (!Number.isSafeInteger(page) ||
        page < 1 ||
        !Number.isSafeInteger(perPage) ||
        perPage < 1 ||
        perPage > 100)
        throw new GitHubAdapterError("invalid-input", "Invalid page request");
    return { page, perPage };
}
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is refused
const LABEL = /^[^,\u0000-\u001f]{1,100}$/;
function sha(value, what = "commit SHA") {
    if (typeof value !== "string" || !SHA.test(value))
        throw new GitHubAdapterError("invalid-input", `${what} must be a full 40-character lowercase SHA`);
    return value;
}
function parse(schema, body, what) {
    const parsed = schema.safeParse(body);
    if (!parsed.success)
        throw new GitHubAdapterError("malformed-response", `Unexpected GitHub response for ${what}`);
    return parsed.data;
}
export function createGitHubEvidence(options) {
    const { owner, name } = options.repository;
    if (!NAME.test(owner) || !NAME.test(name))
        throw new GitHubAdapterError("invalid-input", "Invalid repository owner or name");
    const limits = { ...DEFAULT_LIMITS, ...options.limits };
    if (!(limits.perPage >= 1 &&
        limits.perPage <= 100 &&
        limits.maxPages >= 1 &&
        limits.maxTextChars >= 1))
        throw new GitHubAdapterError("invalid-input", "Invalid evidence limits");
    const repository = `${owner}/${name}`;
    const root = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
    const get = (segments, query) => options.transport.get(`${root}/${segments.map((s) => encodeURIComponent(String(s))).join("/")}`, query);
    const untrusted = (value) => {
        const text = value ?? "";
        return {
            text: text.length > limits.maxTextChars ? text.slice(0, limits.maxTextChars) : text,
            truncated: text.length > limits.maxTextChars,
            trust: UNTRUSTED,
        };
    };
    /**
     * Reads every page of a listing, or refuses: an unread tail could hold what the caller
     * needs. `total`, when GitHub reports one, must be reached exactly.
     */
    async function pages(segments, query, read) {
        const all = [];
        for (let page = 1; page <= limits.maxPages; page++) {
            const { items, total } = read(await get(segments, { ...query, per_page: String(limits.perPage), page: String(page) }));
            all.push(...items);
            if (items.length < limits.perPage || (total !== undefined && all.length >= total)) {
                if (total !== undefined && all.length < total)
                    throw new GitHubAdapterError("incomplete", `GitHub listed ${all.length} of ${total} items`);
                return all;
            }
        }
        throw new GitHubAdapterError("incomplete", `More than ${limits.maxPages * limits.perPage} items; refusing a partial listing`);
    }
    const issueEvidence = (i) => ({
        repository,
        number: i.number,
        isPullRequest: i.pull_request !== undefined && i.pull_request !== null,
        title: untrusted(i.title),
        body: untrusted(i.body),
        state: i.state,
        author: i.user?.login ?? null,
        labels: (i.labels ?? []).map((l) => (typeof l === "string" ? l : l.name)),
        url: i.html_url,
        createdAt: i.created_at,
        updatedAt: i.updated_at,
        authorAssociation: i.author_association ?? "",
        performedViaGitHubApp: i.performed_via_github_app?.slug ?? null,
        closedAt: i.closed_at ?? null,
        commentCount: i.comments ?? null,
    });
    const commentEvidence = (c) => ({
        id: c.id,
        author: c.user?.login ?? null,
        authorType: c.user?.type ?? null,
        authorAssociation: c.author_association ?? "",
        createdAt: c.created_at,
        updatedAt: c.updated_at,
        body: untrusted(c.body),
        url: c.html_url ?? null,
        performedViaGitHubApp: c.performed_via_github_app?.slug ?? null,
    });
    const pullSummary = (p) => ({
        number: p.number,
        state: p.state,
        draft: p.draft ?? false,
        merged: p.merged_at !== null && p.merged_at !== undefined,
        title: untrusted(p.title),
        author: p.user?.login ?? null,
        headRef: p.head.ref,
        headSha: p.head.sha,
        baseRef: p.base.ref,
        baseSha: p.base.sha ?? null,
        createdAt: p.created_at,
        updatedAt: p.updated_at,
    });
    const reviewEvidence = (r) => ({
        id: r.id,
        author: r.user?.login ?? null,
        state: r.state,
        commitSha: r.commit_id ?? null,
        submittedAt: r.submitted_at ?? null,
        body: untrusted(r.body),
    });
    /** One page, as GitHub windowed it. */
    async function windowOf(segments, query, request, schema, what, map) {
        const { page, perPage } = pageRequest(request);
        const raw = parse(schema, await get(segments, { ...query, per_page: String(perPage), page: String(page) }), what);
        if (raw.length > perPage)
            throw new GitHubAdapterError("malformed-response", `GitHub returned more ${what} than requested`);
        return { items: raw.map(map), page, perPage, hasMore: raw.length === perPage, raw };
    }
    async function fileContents(commitSha, path, fileLimits) {
        sha(commitSha);
        const segments = safePath(path);
        const maxBytes = fileLimits.maxBytes ?? DEFAULT_FILE_LIMITS.maxBytes;
        if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
            throw new GitHubAdapterError("invalid-input", "Invalid file limits");
        const body = await get(["contents", ...segments], { ref: commitSha });
        if (Array.isArray(body))
            throw new GitHubAdapterError("wrong-target", "The path is a directory, not a file", {
                reason: "not-a-file",
            });
        const f = parse(ContentsSchema, body, "file contents");
        if (f.type !== "file")
            throw new GitHubAdapterError("wrong-target", `The path is a ${f.type}, not a file`, {
                reason: "not-a-file",
            });
        // A symlinked directory on the way would make GitHub answer for a different path.
        if (f.path !== path)
            throw new GitHubAdapterError("wrong-target", "GitHub answered for another path", {
                reason: "other-path",
            });
        const base = { commitSha, path, blobSha: f.sha, size: f.size };
        if (f.size > maxBytes || f.encoding !== "base64" || !f.content)
            return { base, bytes: null, tooLarge: true };
        const bytes = Buffer.from(f.content.replace(/\s/g, ""), "base64");
        if (bytes.length !== f.size)
            throw new GitHubAdapterError("malformed-response", "File content does not match its size");
        return { base, bytes, tooLarge: false };
    }
    async function getPullRequest(number, opts = {}) {
        if (opts.expectedHeadSha !== undefined)
            sha(opts.expectedHeadSha, "expectedHeadSha");
        const p = parse(PullSchema, await get(["pulls", positive(number, "pull request number")]), "a pull request");
        const evidence = {
            repository,
            number: p.number,
            title: untrusted(p.title),
            state: p.state,
            draft: p.draft ?? false,
            merged: p.merged ?? (p.merged_at !== null && p.merged_at !== undefined),
            author: p.user?.login ?? null,
            url: p.html_url,
            base: { ref: p.base.ref, sha: p.base.sha },
            head: { ref: p.head.ref, sha: p.head.sha, repository: p.head.repo?.full_name ?? null },
            body: untrusted(p.body),
            createdAt: p.created_at ?? null,
            updatedAt: p.updated_at ?? null,
            mergedAt: p.merged_at ?? null,
            commits: p.commits ?? null,
            changedFiles: p.changed_files ?? null,
        };
        if (opts.expectedHeadSha !== undefined && evidence.head.sha !== opts.expectedHeadSha)
            throw new GitHubAdapterError("stale", `The pull request head is ${evidence.head.sha}, not ${opts.expectedHeadSha}`, {
                expected: opts.expectedHeadSha,
                actual: evidence.head.sha,
            });
        return evidence;
    }
    return Object.freeze({
        repository,
        async getIssue(number) {
            return issueEvidence(parse(IssueSchema, await get(["issues", positive(number, "issue number")]), "an issue"));
        },
        async listIssues(opts = {}) {
            const all = await pages(["issues"], { state: opts.state ?? "all", sort: "created", direction: "asc" }, (body) => ({ items: parse(z.array(IssueSchema), body, "an issue listing") }));
            return all.map(issueEvidence).filter((i) => !i.isPullRequest);
        },
        getPullRequest,
        async listPullRequestFiles(number, headSha, opts = {}) {
            sha(headSha, "headSha");
            const patchLimits = opts.patches === undefined
                ? null
                : { ...DEFAULT_PATCH_LIMITS, ...(opts.patches === true ? {} : opts.patches) };
            if (patchLimits &&
                !(Number.isSafeInteger(patchLimits.perFileMaxChars) &&
                    Number.isSafeInteger(patchLimits.totalMaxChars) &&
                    patchLimits.perFileMaxChars >= 1 &&
                    patchLimits.totalMaxChars >= 1))
                throw new GitHubAdapterError("invalid-input", "Invalid patch limits");
            await getPullRequest(number, { expectedHeadSha: headSha });
            const files = await pages(["pulls", number, "files"], {}, (body) => ({
                items: parse(z.array(FileSchema), body, "pull request files"),
            }));
            // The listing is of whatever the head was while it was read; prove it did not move.
            await getPullRequest(number, { expectedHeadSha: headSha });
            let budget = patchLimits?.totalMaxChars ?? 0;
            return {
                repository,
                number,
                headSha,
                files: files.map((f) => {
                    let patchStatus = "unavailable";
                    let patch = null;
                    if (f.patch !== undefined) {
                        if (!patchLimits)
                            patchStatus = "omitted-by-request";
                        else if (budget <= 0)
                            patchStatus = "omitted-budget";
                        else {
                            const max = Math.min(patchLimits.perFileMaxChars, budget);
                            const truncated = f.patch.length > max;
                            patch = {
                                text: truncated ? f.patch.slice(0, max) : f.patch,
                                truncated,
                                trust: UNTRUSTED,
                            };
                            budget -= patch.text.length;
                            patchStatus = truncated ? "truncated" : "included";
                        }
                    }
                    return {
                        path: f.filename,
                        previousPath: f.previous_filename ?? null,
                        status: f.status,
                        additions: f.additions,
                        deletions: f.deletions,
                        changes: f.changes,
                        binary: f.patch === undefined && BINARY_EXTENSIONS.test(f.filename),
                        patchStatus,
                        patch,
                    };
                }),
            };
        },
        async listReviews(number, opts = {}) {
            if (opts.commitSha !== undefined)
                sha(opts.commitSha, "commitSha");
            const reviews = await pages(["pulls", positive(number, "pull request number"), "reviews"], {}, (body) => ({ items: parse(z.array(ReviewSchema), body, "reviews") }));
            return reviews
                .map(reviewEvidence)
                .filter((r) => opts.commitSha === undefined || r.commitSha === opts.commitSha);
        },
        async getChecks(commit, required = []) {
            sha(commit);
            const runs = await pages(["commits", commit, "check-runs"], {}, (body) => {
                const page = parse(CheckRunsSchema, body, "check runs");
                return { items: page.check_runs, total: page.total_count };
            });
            // A run reported under another SHA is not evidence about this commit.
            if (runs.some((r) => r.head_sha !== commit))
                throw new GitHubAdapterError("malformed-response", "A check run belongs to another commit");
            const checks = runs.map((r) => ({
                name: r.name,
                status: r.status,
                conclusion: r.conclusion,
                app: r.app?.slug ?? null,
                startedAt: r.started_at ?? null,
                completedAt: r.completed_at ?? null,
            }));
            // Any successful run of a required name on exactly this commit proves it passed on this tree.
            const requiredEvidence = required.map((name) => {
                const matching = checks.filter((c) => c.name === name);
                const success = matching.find((c) => c.status === "completed" && c.conclusion === "success");
                return {
                    name,
                    conclusion: success ? "success" : (matching[0]?.conclusion ?? null),
                    satisfied: Boolean(success),
                };
            });
            return {
                repository,
                sha: commit,
                checks,
                required: requiredEvidence,
                ok: requiredEvidence.length > 0 && requiredEvidence.every((r) => r.satisfied),
            };
        },
        async listWorkflowRuns(commit) {
            sha(commit);
            const runs = await pages(["actions", "runs"], { head_sha: commit }, (body) => {
                const page = parse(WorkflowRunsSchema, body, "workflow runs");
                return { items: page.workflow_runs, total: page.total_count };
            });
            if (runs.some((r) => r.head_sha !== commit))
                throw new GitHubAdapterError("malformed-response", "A workflow run belongs to another commit");
            return {
                repository,
                sha: commit,
                runs: runs.map((r) => ({
                    id: r.id,
                    name: r.name,
                    status: r.status,
                    conclusion: r.conclusion,
                    event: r.event,
                    createdAt: r.created_at,
                })),
            };
        },
        async listIssueComments(number, opts = {}) {
            if (opts.since !== undefined && Number.isNaN(Date.parse(opts.since)))
                throw new GitHubAdapterError("invalid-input", "since must be an ISO 8601 timestamp");
            const comments = await pages(["issues", positive(number, "issue number"), "comments"], opts.since === undefined ? {} : { since: opts.since }, (body) => ({ items: parse(z.array(CommentSchema), body, "issue comments") }));
            return comments.map(commentEvidence);
        },
        async listPullRequests(opts = {}) {
            const state = opts.state ?? "open";
            if (state !== "open" && state !== "closed" && state !== "all")
                throw new GitHubAdapterError("invalid-input", "Invalid pull request state");
            if (opts.base !== undefined &&
                (!SAFE_REF.test(opts.base) ||
                    opts.base.includes("..") ||
                    opts.base.includes("//") ||
                    /^[-/]|[/.]$/.test(opts.base)))
                throw new GitHubAdapterError("invalid-input", "Invalid base ref name");
            const pulls = await pages(["pulls"], {
                state,
                sort: "created",
                direction: "desc",
                ...(opts.base === undefined ? {} : { base: opts.base }),
            }, (body) => ({ items: parse(z.array(PullListSchema), body, "a pull request listing") }));
            return pulls.map(pullSummary);
        },
        async getFileAtCommit(commitSha, path, fileLimits = {}) {
            const { base, bytes, tooLarge } = await fileContents(commitSha, path, fileLimits);
            if (tooLarge)
                return { ...base, kind: "too-large" };
            if (bytes.includes(0))
                return { ...base, kind: "binary" };
            let text;
            try {
                text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
            }
            catch {
                return { ...base, kind: "binary" };
            }
            return { ...base, kind: "text", text: untrusted(text) };
        },
        async compareCommits(baseSha, headSha) {
            sha(baseSha, "base");
            sha(headSha, "head");
            const c = parse(CompareSchema, await get(["compare", `${baseSha}...${headSha}`]), "a commit comparison");
            // GitHub resolves the range itself; an answer about another base is not this comparison.
            if (c.base_commit.sha !== baseSha)
                throw new GitHubAdapterError("malformed-response", "The comparison names another base");
            return {
                repository,
                base: baseSha,
                head: headSha,
                status: c.status,
                aheadBy: c.ahead_by,
                behindBy: c.behind_by,
                mergeBase: c.merge_base_commit.sha,
            };
        },
        async listIssuesPage(opts = {}) {
            const state = opts.state ?? "open";
            if (!["open", "closed", "all"].includes(state))
                throw new GitHubAdapterError("invalid-input", "Invalid issue state");
            if (opts.sort !== undefined && !["created", "updated", "comments"].includes(opts.sort))
                throw new GitHubAdapterError("invalid-input", "Invalid sort");
            if (opts.direction !== undefined && !["asc", "desc"].includes(opts.direction))
                throw new GitHubAdapterError("invalid-input", "Invalid direction");
            if (opts.labels && (opts.labels.length > 20 || opts.labels.some((l) => !LABEL.test(l))))
                throw new GitHubAdapterError("invalid-input", "Invalid labels");
            const query = {
                state,
                sort: opts.sort ?? "created",
                direction: opts.direction ?? "desc",
            };
            if (opts.labels?.length)
                query.labels = opts.labels.join(",");
            const w = await windowOf(["issues"], query, opts, z.array(IssueSchema), "issues", issueEvidence);
            const items = w.items.filter((i) => !i.isPullRequest);
            return {
                items,
                page: w.page,
                perPage: w.perPage,
                hasMore: w.hasMore,
                excludedPullRequests: w.items.length - items.length,
            };
        },
        async listPullRequestsPage(opts = {}) {
            const state = opts.state ?? "open";
            if (!["open", "closed", "all"].includes(state))
                throw new GitHubAdapterError("invalid-input", "Invalid pull request state");
            if (opts.sort !== undefined && !["created", "updated"].includes(opts.sort))
                throw new GitHubAdapterError("invalid-input", "Invalid sort");
            if (opts.direction !== undefined && !["asc", "desc"].includes(opts.direction))
                throw new GitHubAdapterError("invalid-input", "Invalid direction");
            const { raw: _raw, ...w } = await windowOf(["pulls"], { state, sort: opts.sort ?? "created", direction: opts.direction ?? "desc" }, opts, z.array(PullListSchema), "pull requests", pullSummary);
            return w;
        },
        async listIssueCommentsPage(number, opts = {}) {
            const { raw: _raw, ...w } = await windowOf(["issues", positive(number, "issue number"), "comments"], {}, opts, z.array(CommentSchema), "issue comments", commentEvidence);
            return w;
        },
        async listIssueEventsPage(number, opts = {}) {
            const { raw: _raw, ...w } = await windowOf(["issues", positive(number, "issue number"), "events"], {}, opts, z.array(EventSchema), "issue events", (e) => ({
                event: e.event,
                actor: e.actor?.login ?? null,
                label: e.label?.name ?? null,
                performedViaGitHubApp: e.performed_via_github_app?.slug ?? null,
                createdAt: e.created_at,
            }));
            return w;
        },
        async listReviewsPage(number, opts = {}) {
            const { raw: _raw, ...w } = await windowOf(["pulls", positive(number, "pull request number"), "reviews"], {}, opts, z.array(ReviewSchema), "reviews", reviewEvidence);
            return w;
        },
        async listReviewCommentsPage(number, opts = {}) {
            const { raw: _raw, ...w } = await windowOf(["pulls", positive(number, "pull request number"), "comments"], {}, opts, z.array(ReviewCommentSchema), "review comments", (c) => ({
                id: c.id,
                author: c.user?.login ?? null,
                path: c.path,
                line: c.line ?? null,
                commitSha: c.commit_id,
                createdAt: c.created_at,
                body: untrusted(c.body),
            }));
            return w;
        },
        async getIssueComment(id) {
            const c = parse(CommentSchema, await get(["issues", "comments", positive(id, "comment id")]), "an issue comment");
            // The comment's own issue URL must be under this repository; anything else is not its comment.
            const m = /\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)$/.exec(c.issue_url ?? "");
            if (!m || `${m[1]}/${m[2]}`.toLowerCase() !== repository.toLowerCase())
                throw new GitHubAdapterError("wrong-target", "The comment does not belong to this repository");
            return { ...commentEvidence(c), issueNumber: Number(m[3]) };
        },
        async getFileBytesAtCommit(commitSha, path, fileLimits = {}) {
            const { base, bytes, tooLarge } = await fileContents(commitSha, path, fileLimits);
            if (tooLarge)
                return { ...base, kind: "too-large" };
            return { ...base, kind: "bytes", bytes: new Uint8Array(bytes) };
        },
        async pullRequestContainsCommit(number, commitSha, opts = {}) {
            sha(commitSha);
            const maxCommits = opts.maxCommits ?? 250;
            if (!Number.isSafeInteger(maxCommits) || maxCommits < 1)
                throw new GitHubAdapterError("invalid-input", "Invalid maxCommits");
            const pr = await getPullRequest(number);
            if (pr.head.sha === commitSha)
                return { belongs: true, isHead: true };
            const pageCount = Math.ceil(maxCommits / 100);
            for (let page = 1; page <= pageCount; page++) {
                const commits = parse(z.array(CommitRefSchema), await get(["pulls", number, "commits"], { per_page: "100", page: String(page) }), "pull request commits");
                if (commits.some((c) => c.sha === commitSha))
                    return { belongs: true, isHead: false };
                if (commits.length < 100)
                    return { belongs: false, isHead: false };
            }
            return { belongs: false, isHead: false };
        },
    });
}
