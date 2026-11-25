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
function positive(value, what) {
    if (!Number.isSafeInteger(value) || value < 1)
        throw new GitHubAdapterError("invalid-input", `Invalid ${what}`);
    return value;
}
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
    });
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
                .map((r) => ({
                id: r.id,
                author: r.user?.login ?? null,
                state: r.state,
                commitSha: r.commit_id ?? null,
                submittedAt: r.submitted_at ?? null,
                body: untrusted(r.body),
            }))
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
    });
}
