/**
 * Tool handlers: each one calls the published @comforge/cli lifecycle services or the
 * published @comforge/github evidence reads, and shapes the answer summary-first.
 *
 * No handler reimplements governance, persistence or lifecycle logic, shells out to the
 * `comforge` executable or parses its output. Authorization of writes stays inside
 * @comforge/cli (trusted configuration, owner grants or operator mode); a handler cannot
 * pass `authorized`, a path, a URL or a credential through.
 */
import { PACKAGE_VERSION as CLI_VERSION, capabilities as cliCapabilities, context as cliContext, createLifecycleServices, specificationProtocol, toServiceError, } from "@comforge/cli";
import { createFetchTransport, createGitHubEvidence, GitHubAdapterError, readSpecificationIssue, } from "@comforge/github";
import { CAPABILITIES_SCHEMA, DETAIL_PROFILES, LIMITS, TOOLS, } from "./contracts.js";
import { withGrantFile } from "./grants.js";
import { repositoryOf, trustedConfig } from "./host.js";
import { bound, excerpt, fromServiceError, incompleteDelivery, paginate, success, ToolRefusal, } from "./results.js";
export const SERVER_NAME = "comforge-mcp";
export const SERVER_VERSION = "0.1.0";
/** The host's credential provider, wrapped so every value it hands out is redacted later. */
function credentialsFor(c) {
    const provider = c.binding ? c.host.credentials?.(c.binding, c.principal) : undefined;
    if (!provider)
        return undefined;
    return (config) => {
        const token = provider(config);
        if (token)
            c.secrets.push(token);
        return token;
    };
}
/** One services instance per call: its cancellation signal is the call's. */
function services(c) {
    const binding = c.binding;
    return createLifecycleServices({
        runtime: c.rt,
        repository: repositoryOf(binding),
        credentials: credentialsFor(c),
        state: c.host.state?.(binding),
        signal: c.signal,
        ...(c.host.hostPolicy ? { host: c.host.hostPolicy(binding) } : {}),
    });
}
function settle(r, shape) {
    return r.ok ? shape(r.value, r.exit) : fromServiceError(r.error);
}
/** A read credential exactly as @comforge/cli resolves one, from the server's own sources. */
function readToken(c, config) {
    const provider = credentialsFor(c);
    const rt = c.rt;
    let token;
    if (provider)
        token = provider(config);
    else if (config.security.credentials.source === "env")
        token = rt.env[config.security.credentials.variable];
    else {
        const r = rt.run("gh", ["auth", "token"], { cwd: rt.cwd, timeoutMs: 15_000 });
        token = r.status === 0 ? r.stdout.trim() : undefined;
    }
    if (!token)
        throw new ToolRefusal("credential-missing", "the server has no GitHub credential for this repository");
    c.secrets.push(token);
    return token;
}
function evidence(c) {
    const binding = c.binding;
    const config = trustedConfig(c.rt, binding);
    const token = readToken(c, config);
    const transport = createFetchTransport({
        token: () => token,
        ...(c.rt?.fetchImpl ? { fetchImpl: c.rt.fetchImpl } : {}),
    });
    return {
        config,
        reads: createGitHubEvidence({
            transport,
            repository: { owner: binding.owner, name: binding.name },
        }),
    };
}
/** GitHub adapter refusals as the CLI's codes; anything else is rethrown as internal. */
function githubRefusal(error) {
    if (error instanceof GitHubAdapterError) {
        const code = error.code === "not-found"
            ? "not-found"
            : error.code === "unauthorized" || error.code === "forbidden"
                ? "unauthorized"
                : error.code === "stale"
                    ? "stale"
                    : "github-failed";
        throw new ToolRefusal(code, error.message.slice(0, 300), code === "github-failed" ? 3 : 1, {
            github: error.code,
            ...(typeof error.detail.status === "number" ? { status: error.detail.status } : {}),
        });
    }
    throw error;
}
const untrusted = (t, detail) => {
    const e = excerpt(t.text, detail);
    return { text: e.text, truncated: e.truncated || t.truncated, trust: "untrusted" };
};
const detailFor = (p) => p.profiles.some((x) => DETAIL_PROFILES.includes(x));
export const HANDLERS = {
    async comforge_capabilities(c) {
        const cli = cliCapabilities().result;
        const allowed = c.principal.repositories === "*"
            ? c.server.bindings.map((b) => b.id)
            : c.server.bindings
                .map((b) => b.id)
                .filter((id) => c.principal.repositories.includes(id));
        return success("comforge_capabilities", `${c.server.tools.length} tools for ${allowed.length} repositories (${c.principal.profiles.join(", ")})`, {
            schema: CAPABILITIES_SCHEMA,
            server: {
                name: SERVER_NAME,
                version: SERVER_VERSION,
                cli: CLI_VERSION,
                transport: c.transport,
            },
            principal: { id: c.principal.id, profiles: c.principal.profiles },
            repositories: allowed,
            tools: c.server.tools.map((n) => ({
                name: n,
                executes: TOOLS[n].executes,
                writes: TOOLS[n].writes,
            })),
            execution: c.server.executionAvailable
                ? { available: true, isolation: c.server.isolation ?? "local process (stdio)" }
                : { available: false, reason: "no host-provided isolation on this transport" },
            cleanup: {
                plan: true,
                execute: true,
                authorization: "operator mode, or an owner command grant scoping cleanup of the merged pull request; a publication grant never authorizes it",
            },
            advisoryReviews: {
                available: true,
                note: "advisory reviews are marked comments, never native reviews or approvals; publishing one needs the reviewer profile",
            },
            never: [
                ...(cli.never ?? []),
                "run an arbitrary shell command",
                "accept a caller-supplied path, URL, credential or runtime",
            ],
        });
    },
    async comforge_context(c, input) {
        const rt = { ...c.rt, cwd: c.binding.root };
        try {
            const r = cliContext(rt, input.task ? { task: input.task } : {});
            const result = bound(r.result, 12_000);
            return success("comforge_context", r.exit && r.exit !== 0
                ? `manifest has ${(r.result.issues ?? []).length} issues`
                : input.task
                    ? `routed: ${String(r.result.match?.id ?? "no match")}`
                    : "categories", result);
        }
        catch (error) {
            return fromServiceError(toServiceError(error));
        }
    },
    async comforge_status(c, input) {
        const r = await services(c).status(input.initiative ? { id: input.initiative } : {});
        return settle(r, (value) => {
            if (input.initiative) {
                const { validations, publications, completions, revisions, operations, ...head } = value;
                const count = (x) => (Array.isArray(x) ? x.length : 0);
                return success("comforge_status", `${input.initiative}: ${String(head.stage)}`, {
                    ...head,
                    counts: {
                        validations: count(validations),
                        publications: count(publications),
                        completions: count(completions),
                        revisions: count(revisions),
                        operations: count(operations),
                    },
                });
            }
            const all = (value.initiatives ?? []);
            const compact = all.map((i) => ({
                initiative: i.initiative,
                stage: i.stage,
                branch: i.branch,
                lastValidation: i.lastValidation
                    ? {
                        status: i.lastValidation.status,
                        commit: i.lastValidation.commit,
                    }
                    : null,
                cleanedAt: i.cleanedAt ?? null,
            }));
            const p = paginate(compact, input.cursor, input.pageSize);
            return success("comforge_status", `${all.length} initiatives`, { initiatives: p.items }, p.page);
        });
    },
    async comforge_evidence(c, input) {
        const r = await services(c).status({ id: input.initiative });
        return settle(r, (value) => {
            const v = value;
            const raw = v[input.section] ?? [];
            const items = (Array.isArray(raw) ? [...raw].reverse() : []);
            const p = paginate(items, input.cursor, input.pageSize);
            return success("comforge_evidence", `${input.initiative} ${input.section}: ${items.length} (newest first)`, { section: input.section, items: bound(p.items) }, p.page);
        });
    },
    async comforge_issue(c, input) {
        const { config, reads } = evidence(c);
        try {
            if (input.number === undefined) {
                const state = input.state ?? "open";
                // Filtered on each issue's own state as well: the listing is evidence, not a promise.
                const all = (await reads.listIssues({ state }))
                    .filter((i) => state === "all" || i.state === state)
                    .sort((a, b) => b.number - a.number);
                const p = paginate(all, input.cursor, input.pageSize);
                return success("comforge_issue", `${all.length} ${state} issues`, {
                    issues: p.items.map((i) => ({
                        number: i.number,
                        title: untrusted({
                            text: i.title.text.slice(0, 200),
                            truncated: i.title.truncated || i.title.text.length > 200,
                        }, false),
                        state: i.state,
                        labels: i.labels,
                        updatedAt: i.updatedAt,
                    })),
                }, p.page);
            }
            const protocol = specificationProtocol(config);
            const detail = Boolean(input.detail);
            if (protocol) {
                const s = await readSpecificationIssue(reads, protocol, input.number);
                return success("comforge_issue", `#${input.number} ${s.issue.state}; specification ${s.verified ? "verified" : s.verification ? "modified" : "absent"}`, {
                    issue: issueSummary(s.issue, detail),
                    specification: s.verification
                        ? {
                            ticketId: s.verification.ticketId,
                            digest: s.verification.digest,
                            digestMatches: s.verification.digestMatches,
                        }
                        : null,
                    verified: s.verified,
                });
            }
            const issue = await reads.getIssue(input.number);
            return success("comforge_issue", `#${input.number} ${issue.state}`, {
                issue: issueSummary(issue, detail),
                specification: null,
                verified: false,
            });
        }
        catch (error) {
            return githubRefusal(error);
        }
    },
    async comforge_pr(c, input) {
        const { reads } = evidence(c);
        const detail = detailFor(c.principal);
        const include = new Set(input.include ?? []);
        try {
            const pr = await reads.getPullRequest(input.number, input.expectedHeadSha ? { expectedHeadSha: input.expectedHeadSha } : {});
            const data = {
                pullRequest: {
                    number: pr.number,
                    title: untrusted(pr.title, false),
                    state: pr.state,
                    draft: pr.draft,
                    merged: pr.merged,
                    author: pr.author,
                    url: pr.url,
                    base: pr.base,
                    head: { ref: pr.head.ref, sha: pr.head.sha },
                },
            };
            let page;
            if (include.has("checks")) {
                const checks = await reads.getChecks(pr.head.sha);
                data.checks = {
                    ok: checks.ok,
                    total: checks.checks.length,
                    failing: checks.checks
                        .filter((x) => x.conclusion && !["success", "skipped", "neutral"].includes(x.conclusion))
                        .map((x) => x.name),
                    pending: checks.checks.filter((x) => x.status !== "completed").map((x) => x.name),
                };
            }
            if (include.has("files")) {
                const files = await reads.listPullRequestFiles(pr.number, pr.head.sha, detail ? { patches: true } : {});
                const p = paginate(files.files, input.cursor, input.pageSize);
                data.files = p.items.map((f) => ({
                    path: f.path,
                    status: f.status,
                    additions: f.additions,
                    deletions: f.deletions,
                    ...(detail && f.patch ? { patch: untrusted(f.patch, true) } : {}),
                }));
                page = p.page;
            }
            if (include.has("reviews")) {
                const reviews = await reads.listReviews(pr.number);
                data.reviews = {
                    // Native GitHub reviews only. An advisory review (a marked issue comment) is not
                    // a GitHub review and is never presented as one.
                    native: reviews.map((r) => ({
                        id: r.id,
                        author: r.author,
                        state: r.state,
                        commitSha: r.commitSha,
                        current: r.commitSha === pr.head.sha,
                        submittedAt: r.submittedAt,
                        body: untrusted(r.body, detail),
                    })),
                    advisory: {
                        available: false,
                        reason: "the published @comforge/github 0.4.0 has no issue-comment read",
                    },
                };
            }
            return success("comforge_pr", `#${pr.number} ${pr.merged ? "merged" : pr.state} at ${pr.head.sha.slice(0, 12)}`, data, page);
        }
        catch (error) {
            return githubRefusal(error);
        }
    },
    async comforge_start(c, input) {
        const r = await services(c).start({
            id: input.initiative,
            ...(input.issue ? { issue: input.issue } : {}),
            ...(input.expectDigest ? { expectDigest: input.expectDigest } : {}),
        });
        return settle(r, (v) => success("comforge_start", `${v.initiative} on ${v.branch} from ${v.base.sha.slice(0, 12)}`, {
            ...v,
        }));
    },
    async comforge_revise(c, input) {
        const r = await services(c).revise({
            pr: input.pr,
            ...(input.reviewedHead ? { reviewedHead: input.reviewedHead } : {}),
        });
        return settle(r, (v) => success("comforge_revise", `${v.initiative}: ${v.relation}${v.fastForwarded ? ", fast-forwarded" : ""}`, { ...v }));
    },
    async comforge_verify(c, input) {
        const r = await services(c).verify({
            id: input.initiative,
            ...(input.commit ? { commit: input.commit } : {}),
            ...(input.with ? { with: input.with } : {}),
        });
        return settle(r, (v, exit) => success("comforge_verify", `${v.initiative} ${v.status} at ${String(v.commit).slice(0, 12)}`, bound(v), undefined, exit));
    },
    async comforge_deliver(c, input) {
        if (JSON.stringify(input.result).length > 200_000)
            throw new ToolRefusal("result-too-large", "the result document exceeds 200,000 characters", 2);
        return withGrantFile(input.grant, async (grantFile) => {
            const r = await services(c).deliver({
                id: input.initiative,
                title: input.title,
                raw: input.result,
                execute: input.execute,
                ...(input.closes ? { closes: input.closes } : {}),
                ...(input.draft ? { draft: true } : {}),
                ...(input.withoutPullRequest ? { withoutPullRequest: true } : {}),
                ...(grantFile ? { grantFile } : {}),
            });
            if (r.ok && r.value.delivery === "incomplete")
                return incompleteDelivery(r.value, r.exit);
            return settle(r, (v) => success("comforge_deliver", `${v.initiative}: ${v.delivery}`, bound(v)));
        });
    },
    async comforge_recover(c, input) {
        return withGrantFile(input.grant, async (grantFile) => {
            const r = await services(c).recover({
                id: input.initiative,
                execute: input.execute,
                ...(input.abandon ? { abandon: true } : {}),
                ...(grantFile ? { grantFile } : {}),
            });
            return settle(r, (v, exit) => success("comforge_recover", `${input.initiative}: ${exit === 0 ? (input.execute ? "settled" : "planned") : "writes still open"}`, bound(v), undefined, exit));
        });
    },
    async comforge_cleanup(c, input) {
        // Executing is authorized by @comforge/cli: operator mode, or a command grant scoping
        // cleanup of the merged pull request (a publication grant never authorizes it).
        return withGrantFile(input.grant, async (grantFile) => {
            const r = await services(c).cleanup({
                target: input.target,
                execute: input.execute,
                ...(input.allowMissingCompletion ? { allowMissingCompletion: true } : {}),
                ...(grantFile ? { grantFile } : {}),
            });
            return settle(r, (v) => success("comforge_cleanup", `cleanup of ${input.target} ${input.execute ? "executed" : "planned"}`, bound(v)));
        });
    },
    async comforge_prs(c, input) {
        const state = input.state ?? "open";
        const r = await services(c).pullRequests({ state });
        return settle(r, (v) => {
            const all = v.pullRequests.sort((a, b) => b.number - a.number);
            const p = paginate(all, input.cursor, input.pageSize);
            return success("comforge_prs", `${all.length} ${state} pull requests`, {
                pullRequests: p.items.map((pr) => ({
                    number: pr.number,
                    title: untrusted({
                        text: pr.title.text.slice(0, 200),
                        truncated: pr.title.truncated || pr.title.text.length > 200,
                    }, false),
                    state: pr.state,
                    draft: pr.draft,
                    merged: pr.merged,
                    author: pr.author,
                    head: { ref: pr.headRef, sha: pr.headSha },
                    base: pr.baseRef,
                    updatedAt: pr.updatedAt,
                })),
            }, p.page);
        });
    },
    async comforge_comments(c, input) {
        const r = await services(c).issueComments({ issue: input.number });
        const detail = Boolean(input.detail) && detailFor(c.principal);
        return settle(r, (v) => {
            const all = v.comments;
            const p = paginate(all, input.cursor, input.pageSize);
            return success("comforge_comments", `#${input.number}: ${all.length} comments`, {
                comments: p.items.map((cm) => ({
                    id: cm.id,
                    author: cm.author,
                    authorAssociation: cm.authorAssociation,
                    createdAt: cm.createdAt,
                    body: untrusted(cm.body, detail),
                })),
            }, p.page);
        });
    },
    async comforge_reviews(c, input) {
        const r = await services(c).advisoryReviews({ pr: input.pr });
        const detail = detailFor(c.principal);
        return settle(r, (v) => {
            const all = v.reviews;
            const p = paginate(all, input.cursor, input.pageSize);
            return success("comforge_reviews", `#${input.pr}: ${all.length} advisory reviews (${all.filter((x) => x.integrity === "verified" && !x.stale).length} verified and current)`, {
                // Advisory evidence: never a native review, an approval or authorization to act.
                kind: "advisory",
                currentHead: v.currentHead,
                reviews: p.items.map((rv) => ({
                    commentId: rv.commentId,
                    author: rv.author,
                    provenance: rv.provenance,
                    integrity: rv.integrity,
                    stale: rv.stale,
                    reviewedHeadSha: rv.reviewedHeadSha,
                    verdict: rv.verdict,
                    reviewDigest: rv.reviewDigest,
                    ticketId: rv.ticketId,
                    createdAt: rv.createdAt,
                    ...(rv.findingsBySeverity ? { findingsBySeverity: rv.findingsBySeverity } : {}),
                    ...(detail && rv.review ? { review: bound(rv.review, LIMITS.detailChars) } : {}),
                })),
            }, p.page);
        });
    },
    async comforge_artifact(c, input) {
        const r = await services(c).artifact({ commit: input.commit, path: input.path });
        const detail = detailFor(c.principal);
        return settle(r, (v) => {
            const a = v.artifact;
            return success("comforge_artifact", `${a.path} at ${a.commitSha.slice(0, 12)}: ${a.kind}`, {
                artifact: {
                    commitSha: a.commitSha,
                    path: a.path,
                    blobSha: a.blobSha,
                    size: a.size,
                    kind: a.kind,
                    ...(a.text ? { text: untrusted(a.text, detail) } : {}),
                },
            });
        });
    },
    async comforge_publish_review(c, input) {
        return withGrantFile(input.grant, async (grantFile) => {
            const r = await services(c).publishReview({
                review: input.review,
                execute: input.execute,
                ...(grantFile ? { grantFile } : {}),
            });
            return settle(r, (v) => success("comforge_publish_review", `advisory review of #${String(v.pullRequest)}: ${String(v.action)}`, bound(v)));
        });
    },
    async comforge_publish_specification(c, input) {
        return withGrantFile(input.grant, async (grantFile) => {
            const r = await services(c).publishSpecification({
                ticket: input.ticket,
                title: input.title,
                body: input.body,
                ...(input.issue ? { issue: input.issue } : {}),
                ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
                execute: input.execute,
                ...(grantFile ? { grantFile } : {}),
            });
            return settle(r, (v) => success("comforge_publish_specification", `${input.ticket}: ${String(v.action)}`, bound(v)));
        });
    },
};
function issueSummary(issue, detail) {
    return {
        number: issue.number,
        title: untrusted(issue.title, false),
        state: issue.state,
        author: issue.author,
        labels: issue.labels,
        url: issue.url,
        updatedAt: issue.updatedAt,
        body: untrusted(issue.body, detail),
    };
}
