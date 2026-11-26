import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { COMPLETION_LIMITS, evaluateLifecycleAction, } from "@comforge/core";
import { bodyDigest } from "@comforge/github";
import { z } from "zod";
import { authorizeWrites } from "../authorization.js";
import { loadInitiative, requireCheckout } from "../context.js";
import { CliError, EXIT, fail } from "../errors.js";
import { assignWithGh, githubError } from "../github.js";
import { completionProtocol, specificationProtocol } from "../protocols.js";
import { initiativeFromBranch, requireTrustedUnchanged } from "../repository.js";
import { git, gitOk } from "../runtime.js";
import { nowIso } from "../state.js";
/**
 * C2: the governed GitHub writes. Every write goes through the @comforge/github writer with
 * the @comforge/ledger file ledger (idempotent per operation id), under the trusted
 * configuration of the initiative's base, after the @comforge/core lifecycle decision for
 * that step allowed it. Nothing here merges, deploys, approves, requests a review or closes.
 */
const refuse = (reasons, fallback) => {
    const [first] = reasons;
    const code = first?.code === "validation_missing" ||
        first?.code === "ledger_missing" ||
        first?.code === "publication_not_recorded"
        ? "validation-missing"
        : first?.code === "validation_not_passing"
            ? "validation-failed"
            : first?.code === "head_moved" || first?.code === "pull_request_not_open"
                ? "stale"
                : first?.code === "multiple_open_pull_requests" ||
                    first?.code === "closed_pull_request_exists" ||
                    first?.code === "wrong_branch"
                    ? "conflict"
                    : "policy-denied";
    throw new CliError(code, first?.message ?? fallback, {
        reasons: reasons.map((r) => ({
            code: r.code,
            message: r.message,
            ...(r.detail ? { detail: r.detail } : {}),
        })),
    });
};
const operationId = (prefix, ...parts) => `${prefix}-${createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 40)}`;
/** Removes the SDK writer's correlation marker, which caller text may not carry. */
export const withoutWriterMarker = (body) => body.replace(/\n*<!-- comforge-op [^\n]*-->\s*$/, "");
const PullSchema = z.object({
    number: z.number(),
    state: z.string(),
    draft: z.boolean().optional(),
    merged_at: z.string().nullable().optional(),
    body: z.string().nullable().optional(),
    html_url: z.string(),
    head: z.object({
        ref: z.string(),
        sha: z.string(),
        repo: z.object({ full_name: z.string() }).nullable(),
    }),
    base: z.object({ ref: z.string() }),
    assignees: z.array(z.object({ login: z.string() })).default([]),
});
async function readPull(gh, config, number) {
    const raw = await gh.transport
        .get(`/repos/${config.repository.owner}/${config.repository.name}/pulls/${number}`)
        .catch(githubError);
    const parsed = PullSchema.safeParse(raw);
    if (!parsed.success)
        fail("github-failed", `unexpected shape for pull request #${number}`);
    return parsed.data;
}
const prState = (p) => (p.merged_at ? "MERGED" : p.state === "open" ? "OPEN" : "CLOSED");
/**
 * The identity for a write: `base`, or after an abandoned attempt under it, the next one
 * (`base-1`, `base-2`, …). An abandoned identity is never reused, and an unresolved one is
 * answered by the writer from the ledger (`recover` reconciles it first).
 */
async function freshIdentity(gh, base) {
    for (let n = 0; n <= 8; n++) {
        const id = n === 0 ? base : `${base}-${n}`;
        const record = await gh.ledger.get(id).catch(githubError);
        if (record?.state !== "abandoned")
            return id;
    }
    return fail("conflict", "eight attempts of this write were abandoned; inspect GitHub before trying again", { operationId: base });
}
/** Records that can never be sent again: succeeded, abandoned, or failed without retry. */
const finished = (record) => record.state === "succeeded" ||
    record.state === "abandoned" ||
    (record.state === "failed" && record.failure?.retryable !== true);
/** Same bound as the portfolio's lifecycle writer for repeats of one transition. */
export const MAX_TRANSITION_REPEATS = 8;
/**
 * The identity for an update the command has just found not applied (it read the current
 * body and it is not the target). A finished record under the derived identity therefore
 * describes a transition that was undone since, so the update takes the next identity
 * (`base-1`, …) instead of being answered from the ledger. Any other recorded state is the
 * writer's to answer or reconcile under that same identity. After `MAX_TRANSITION_REPEATS`
 * undone repeats it refuses as ambiguous and sends nothing.
 */
async function transitionIdentity(gh, base) {
    for (let n = 0; n <= MAX_TRANSITION_REPEATS; n++) {
        const id = n === 0 ? base : `${base}-${n}`;
        const record = await gh.ledger.get(id).catch(githubError);
        if (!record || !finished(record))
            return id;
    }
    return fail("ambiguous", `this update was undone more than ${MAX_TRANSITION_REPEATS} times; inspect the pull request`, {
        operationId: base,
    });
}
/** Notes an operation id in the initiative before its write, so `recover` can find it after a crash. */
async function remember(ctx, initiative, id) {
    if (!initiative)
        return;
    await ctx.state.update(initiative, (r) => {
        if (!r.operations.includes(id))
            r.operations.push(id);
    });
}
// --- publish ----------------------------------------------------------------------------
function composeBody(record, config, checkout, ctx, head) {
    const validation = record.validations.filter((v) => v.commit === head).at(-1);
    const reports = git(ctx.rt, checkout, [
        "diff",
        "--name-only",
        `${record.base.sha}..${head}`,
        "--",
        config.evidence.reportDir,
    ])
        .split("\n")
        .filter(Boolean);
    const spec = record.specification;
    return [
        `## ${record.operationId}`,
        "",
        spec
            ? `- Specification: #${spec.issueNumber} (digest \`${spec.digest}\`)`
            : "- Specification: none",
        `- Base: \`${record.base.branch}\` at \`${record.base.sha}\``,
        `- Validated head: \`${head}\` — ${validation?.status ?? "not validated"} (${validation?.commands.map((c) => c.name).join(", ") ?? ""})`,
        ...(reports.length > 0
            ? ["", "### Reports and evidence", "", ...reports.map((f) => `- \`${f}\``)]
            : []),
        "",
        "Published by comforge. Not an approval: merging, deploying and closing are separate owner decisions.",
    ].join("\n");
}
export async function publish(ctx, options) {
    const { rt } = ctx;
    if (!options.title.trim() || options.title.length > 256)
        fail("usage", "--title needs 1–256 characters");
    const { record, trusted } = await loadInitiative(ctx, options.id);
    const checkout = requireCheckout(record);
    requireTrustedUnchanged(trusted, checkout);
    if (git(rt, checkout, ["status", "--porcelain", "--untracked-files=normal"]))
        fail("dirty-checkout", "commit or remove local changes first");
    const head = git(rt, checkout, ["rev-parse", "HEAD"]);
    const publishDecision = evaluateLifecycleAction({
        action: "publish",
        evidence: {
            head,
            validations: record.validations.map((v) => ({ commit: v.commit, status: v.status })),
        },
    });
    if (publishDecision.decision !== "allow")
        refuse(publishDecision.reasons, "publication refused");
    const gh = ctx.github(trusted);
    const { owner, name, remote, baseBranch } = trusted.repository;
    const remoteLine = git(rt, checkout, ["ls-remote", remote, `refs/heads/${record.branch}`]);
    const remoteSha = remoteLine ? remoteLine.split(/\s/)[0] : null;
    if (remoteSha)
        git(rt, checkout, [
            "fetch",
            "--quiet",
            remote,
            `+refs/heads/${record.branch}:refs/remotes/${remote}/${record.branch}`,
        ]);
    const remoteIsAncestor = remoteSha
        ? gitOk(rt, checkout, ["merge-base", "--is-ancestor", remoteSha, head])
        : undefined;
    const listed = (await gh.transport
        .get(`/repos/${owner}/${name}/pulls`, {
        head: `${owner}:${record.branch}`,
        state: "all",
        per_page: "100",
    })
        .catch(githubError));
    const pulls = z.array(PullSchema).safeParse(listed);
    if (!pulls.success)
        fail("github-failed", "unexpected shape for the pull request list");
    const candidates = pulls.data.filter((p) => p.head.ref === record.branch);
    const target = evaluateLifecycleAction({
        action: "publication-target",
        evidence: {
            head,
            remoteSha,
            ...(remoteIsAncestor === undefined ? {} : { remoteIsAncestor }),
            pullRequests: candidates.map((p) => ({
                number: p.number,
                state: prState(p),
                crossRepository: p.head.repo?.full_name !== `${owner}/${name}`,
                baseRef: p.base.ref,
            })),
            baseBranch,
        },
    });
    if (target.decision !== "allow")
        return refuse(target.reasons, "publication target refused");
    const facts = target.facts;
    const existing = facts.openPullRequestIndex === null ? null : candidates[facts.openPullRequestIndex];
    const body = composeBody(record, trusted, checkout, ctx, head);
    const plan = {
        initiative: record.operationId,
        head,
        push: facts.push,
        pullRequest: existing
            ? { action: "update", number: existing.number }
            : { action: "create", draft: options.draft === true, base: baseBranch },
        assignee: trusted.security.delivery.assignee,
        authorization: trusted.security.authorization?.mode ?? "none: writes are refused",
    };
    if (!options.execute)
        return { result: { executed: false, plan, body } };
    const authorized = options.authorized ??
        (await authorizeWrites(ctx, trusted, record, {
            head,
            grantFile: options.grantFile,
            command: "publish",
        }));
    if (facts.push !== "up-to-date")
        git(rt, checkout, ["push", "--quiet", remote, `${head}:refs/heads/${record.branch}`]);
    let pull;
    const ops = [];
    if (existing) {
        const current = await readPull(gh, trusted, existing.number);
        // A completion link already in the body is kept: publishing again must not remove it.
        const link = completionLinkBlock(current.body ?? "");
        const next = link ? `${body}\n\n${link}\n` : body;
        if (withoutWriterMarker(current.body ?? "") !== next) {
            const digest = await bodyDigest(current.body ?? "");
            const id = await transitionIdentity(gh, operationId("pr-body", record.operationId, String(existing.number), head, digest, next));
            ops.push(id);
            await remember(ctx, record.operationId, id);
            const outcome = await gh.write({
                kind: "pull.update",
                operationId: id,
                pullNumber: existing.number,
                expected: { bodyDigest: digest, headSha: head },
                body: next,
            });
            if (outcome.status !== "verified")
                throw new CliError("ambiguous", "the pull request body update is unresolved; run comforge recover, then this command", {
                    operationId: id,
                    status: outcome.status,
                });
        }
        pull = await readPull(gh, trusted, existing.number);
    }
    else {
        const id = await freshIdentity(gh, operationId("pr-create", record.operationId, head));
        ops.push(id);
        await remember(ctx, record.operationId, id);
        const outcome = await gh.write({
            kind: "pull.create",
            operationId: id,
            title: options.title,
            body,
            head: record.branch,
            base: baseBranch,
            expectedHeadSha: head,
            draft: options.draft === true,
        });
        if (outcome.status !== "verified" || outcome.resource?.type !== "pull")
            throw new CliError("ambiguous", "the pull request could not be verified; rerun comforge recover", { operationId: id, status: outcome.status });
        pull = await readPull(gh, trusted, outcome.resource.number);
    }
    let assignment = null;
    // Assignment is the one host-adapter write: only with its own capability.
    const assignee = trusted.security.capabilities.includes("pulls:assign")
        ? trusted.security.delivery.assignee
        : null;
    if (assignee && !pull.assignees.some((a) => a.login === assignee)) {
        assignment = assignWithGh(rt, trusted, pull.number, assignee);
        pull = await readPull(gh, trusted, pull.number);
    }
    await ctx.state.update(record.operationId, (r) => {
        r.publications.push({
            commit: head,
            prNumber: pull.number,
            url: pull.html_url,
            at: nowIso(rt.now()),
        });
        for (const id of ops)
            if (!r.operations.includes(id))
                r.operations.push(id);
    });
    const handoff = evaluateLifecycleAction({
        action: "pull-request-handoff",
        evidence: {
            head,
            pullRequest: {
                state: prState(pull),
                headSha: pull.head.sha,
                isDraft: pull.draft === true,
                assignees: pull.assignees.map((a) => a.login),
            },
            requireReady: options.draft !== true,
            assignee,
        },
    });
    const problems = handoff.decision === "allow" ? [] : handoff.reasons.map((r) => r.message);
    return {
        result: {
            executed: true,
            plan,
            pullRequest: {
                number: pull.number,
                url: pull.html_url,
                headSha: pull.head.sha,
                draft: pull.draft === true,
            },
            assignment,
            authorization: authorized,
            handoff: problems.length === 0 ? "ok" : problems,
        },
        exit: problems.length === 0 ? EXIT.ok : EXIT.incomplete,
        pullRequest: pull,
    };
}
// --- complete ---------------------------------------------------------------------------
const IssueSchema = z.object({
    number: z.number(),
    title: z.string(),
    body: z.string().nullable().optional(),
    state: z.string(),
    pull_request: z.unknown().optional(),
});
const CommentSchema = z.object({
    id: z.number(),
    body: z.string().nullable().optional(),
    user: z.object({ login: z.string() }).nullable(),
    created_at: z.string(),
});
const LINK_BEGIN = "<!-- comforge:completion-link-begin -->";
const LINK_END = "<!-- comforge:completion-link-end -->";
/** The completion-link block of a body, or null. */
export function completionLinkBlock(body) {
    const begin = body.indexOf(LINK_BEGIN);
    const end = body.indexOf(LINK_END);
    return begin >= 0 && end > begin ? body.slice(begin, end + LINK_END.length) : null;
}
export function withCompletionLink(body, link) {
    const block = [
        LINK_BEGIN,
        "## Issue completion",
        "",
        `- Completion result on #${link.issueNumber} for head \`${link.headSha}\`: ${link.url}`,
        "- A completion result is not an approval; merge authorization is a separate owner decision.",
        LINK_END,
    ].join("\n");
    const begin = body.indexOf(LINK_BEGIN);
    const end = body.indexOf(LINK_END);
    if (begin >= 0 && end > begin)
        return body.slice(0, begin) + block + body.slice(end + LINK_END.length);
    return `${body.replace(/\s+$/, "")}\n\n${block}\n`;
}
async function scanComments(gh, config, issue) {
    const out = [];
    for (let page = 1; page <= 10; page++) {
        const raw = await gh.transport
            .get(`/repos/${config.repository.owner}/${config.repository.name}/issues/${issue}/comments`, {
            per_page: "100",
            page: String(page),
        })
            .catch(githubError);
        const batch = z.array(CommentSchema).safeParse(raw);
        if (!batch.success)
            fail("github-failed", "unexpected shape for issue comments");
        out.push(...batch.data);
        if (batch.data.length < 100)
            return { comments: out, truncated: false };
    }
    return { comments: out, truncated: true };
}
export function parseResult(config, raw) {
    const protocol = completionProtocol(config);
    const parsed = protocol.inputSchema.safeParse(raw);
    if (!parsed.success)
        fail("usage", "the completion result does not match the contract", {
            issues: parsed.error.issues
                .slice(0, 20)
                .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
        });
    const input = parsed.data;
    const problems = [...protocol.contentProblems(input), ...protocol.consistencyProblems(input)];
    if (problems.length > 0)
        fail("policy-denied", "the completion result is inconsistent or unsafe", { problems });
    return input;
}
export const readResultFile = (file) => {
    try {
        return JSON.parse(readFileSync(file, "utf8"));
    }
    catch {
        return fail("usage", `${file} is not a readable JSON file`, { file });
    }
};
export async function complete(ctx, options) {
    const { rt, repo } = ctx;
    const working = ctx.working();
    // The ticket's own record (if any) decides which base, and so which trusted configuration, applies.
    const pre = completionProtocol(working).inputSchema.safeParse(options.raw);
    const ticketHint = pre.success ? pre.data.ticketId : null;
    const ghWorking = ctx.github(working);
    let initiativeId = ticketHint ?? "";
    const prHint = pre.success ? pre.data.pullRequest : undefined;
    if (prHint) {
        const p = await readPull(ghWorking, working, prHint.number);
        const fromBranch = initiativeFromBranch(p.head.ref, working);
        if (fromBranch && fromBranch.ticket === ticketHint)
            initiativeId = fromBranch.id;
    }
    const local = initiativeId ? await ctx.state.get(initiativeId) : null;
    const { record, trusted } = local
        ? await loadInitiative(ctx, initiativeId)
        : { record: null, trusted: working };
    if (!local) {
        // Without an initiative, the trusted configuration is the base branch's committed one.
        const { remote, baseBranch } = working.repository;
        git(rt, repo.root, [
            "fetch",
            "--quiet",
            remote,
            `+refs/heads/${baseBranch}:refs/remotes/${remote}/${baseBranch}`,
        ]);
    }
    const input = parseResult(trusted, options.raw);
    const protocol = completionProtocol(trusted);
    const spec = specificationProtocol(trusted);
    const gh = ctx.github(trusted);
    const { owner, name, remote } = trusted.repository;
    // The specification on the issue, unedited, is the one the result names.
    const issueRaw = await gh.transport
        .get(`/repos/${owner}/${name}/issues/${input.issueNumber}`)
        .catch(githubError);
    const issue = IssueSchema.safeParse(issueRaw);
    if (!issue.success)
        fail("github-failed", "unexpected issue shape");
    const iss = issue.data;
    if (iss.pull_request !== undefined)
        fail("policy-denied", `#${input.issueNumber} is a pull request`);
    if (iss.state !== "open")
        fail("stale", `#${input.issueNumber} is ${iss.state}`);
    if (!spec)
        fail("config-invalid", "completion needs a specification section in the configuration");
    const v = spec.verifyPublishedSpecification({
        title: iss.title,
        body: iss.body,
    });
    if (!v)
        fail("specification-invalid", `#${input.issueNumber} is not a published specification`);
    const verification = v;
    if (verification.ticketId !== input.ticketId)
        fail("conflict", `#${input.issueNumber} specifies ${verification.ticketId}`);
    if (verification.digest !== input.specificationDigest)
        fail("conflict", "the result names another specification digest than the issue");
    if (!verification.digestMatches)
        fail("stale", "the specification was edited after publication");
    if (record?.specification &&
        (record.specification.issueNumber !== input.issueNumber ||
            record.specification.digest !== input.specificationDigest))
        fail("conflict", `${record.operationId} started from another specification`);
    // Every revision the result names is committed and reachable from the remote.
    git(rt, repo.root, ["fetch", "--quiet", remote]);
    const onRemote = (sha) => gitOk(rt, repo.root, ["cat-file", "-e", `${sha}^{commit}`]) &&
        git(rt, repo.root, ["branch", "-r", "--contains", sha])
            .split("\n")
            .some((b) => b.trim().startsWith(`${remote}/`));
    if (!onRemote(input.sourceRevision))
        fail("evidence-missing", "sourceRevision is not a commit on the remote", {
            sha: input.sourceRevision,
        });
    const missing = input.evidence.filter((e) => !onRemote(e.commit) || !gitOk(rt, repo.root, ["cat-file", "-e", `${e.commit}:${e.path}`]));
    if (missing.length > 0)
        fail("evidence-missing", "evidence must be committed at a commit on the remote", {
            missing: missing.map((e) => `${e.path}@${e.commit}`),
        });
    // The lifecycle gate: a PR of this initiative needs a passing validation and a publication of its head.
    let pull = null;
    let gates = [];
    let applies = false;
    if (input.pullRequest) {
        pull = await readPull(gh, trusted, input.pullRequest.number);
        if (pull.head.sha !== input.pullRequest.headSha)
            fail("stale", "the pull request head is no longer the one the result names", {
                expected: input.pullRequest.headSha,
                current: pull.head.sha,
            });
        if (pull.state !== "open" && !pull.merged_at)
            fail("stale", `#${pull.number} is closed without merging`);
        const branch = record?.branch ?? `${trusted.tickets.branchPrefix}${input.ticketId.toLowerCase()}`;
        const decision = evaluateLifecycleAction({
            action: "complete",
            evidence: {
                issueType: input.issueType,
                outcome: input.outcome,
                head: input.pullRequest.headSha,
                ticketBranch: branch,
                repository: `${owner}/${name}`,
                pullRequest: {
                    number: pull.number,
                    headRef: pull.head.ref,
                    headRepository: pull.head.repo?.full_name ?? null,
                },
                ledger: record
                    ? {
                        validations: record.validations.map((x) => ({ commit: x.commit, status: x.status })),
                        publications: record.publications.map((p) => ({
                            commit: p.commit,
                            prNumber: p.prNumber,
                        })),
                    }
                    : null,
            },
        });
        if (decision.decision !== "allow")
            refuse(decision.reasons, "completion refused");
        if (decision.decision === "allow" && decision.facts.applies && record) {
            applies = true;
            const validated = record.validations[decision.facts.validationIndex];
            gates = [
                {
                    gate: "Exact-snapshot validation (comforge verify)",
                    command: trusted.validation.commands.map((c) => c.run.join(" ")).join(" && "),
                    status: validated?.status ?? "FAIL",
                    reason: validated?.status === "PASS" ? null : "see comforge status",
                    source: "lifecycle-ledger",
                },
            ];
        }
    }
    const viewer = await gh.login();
    const scan = await scanComments(gh, trusted, input.issueNumber);
    if (scan.truncated)
        fail("policy-denied", "too many comments to rule out an earlier result; publish nothing");
    const results = scan.comments.flatMap((comment) => {
        const marker = protocol.parseCompletionMarker(comment.body);
        if (!marker || marker.issueNumber !== input.issueNumber || marker.ticketId !== input.ticketId)
            return [];
        return [{ comment, marker, ...protocol.decodeCompletion(marker) }];
    });
    const own = results.filter((e) => e.comment.user?.login === viewer && e.integrity === "verified");
    const latestOwn = own.at(-1) ?? null;
    const payload = protocol.buildCompletionPayload(input, {
        digestVerified: true,
        ledgerGates: gates,
        supersedes: latestOwn ? [latestOwn.comment.id] : [],
    });
    const replay = latestOwn?.payload && protocol.sameResult(latestOwn.payload, payload) ? latestOwn : null;
    const body = protocol.composeCompletionComment(payload);
    if (body.length > COMPLETION_LIMITS.commentMaxChars)
        fail("policy-denied", "the completion comment is too large; link a committed report instead");
    const digest = protocol.completionDigest(protocol.serializeCompletionPayload(payload));
    const plan = {
        repository: `${owner}/${name}`,
        issueNumber: input.issueNumber,
        ticketId: input.ticketId,
        initiative: record?.operationId ?? null,
        outcome: input.outcome,
        disposition: payload.disposition,
        comment: replay ? { action: "replay", commentId: replay.comment.id } : { action: "create" },
        supersedes: replay ? [] : payload.supersedes,
        pullRequestLink: pull && applies ? { prNumber: pull.number, action: "ensure" } : null,
        ignoredForeignResults: results
            .filter((e) => e.comment.user?.login !== viewer)
            .map((e) => ({ commentId: e.comment.id, author: e.comment.user?.login ?? null })),
        completionDigest: digest,
        closesIssue: false,
        authorization: trusted.security.authorization?.mode ?? "none: writes are refused",
    };
    if (!options.execute)
        return { result: { executed: false, plan, body } };
    const authorized = options.authorized ??
        (await authorizeWrites(ctx, trusted, record, {
            head: input.pullRequest?.headSha ?? input.sourceRevision,
            grantFile: options.grantFile,
            command: "complete",
        }));
    let commentId;
    let action;
    const ops = [];
    if (replay) {
        commentId = replay.comment.id;
        action = "replayed";
    }
    else {
        const id = await freshIdentity(gh, operationId("completion", String(input.issueNumber), digest));
        ops.push(id);
        await remember(ctx, record?.operationId ?? null, id);
        const outcome = await gh.write({
            kind: "issue.comment",
            operationId: id,
            issueNumber: input.issueNumber,
            body,
        });
        if (outcome.status !== "verified" || outcome.resource?.type !== "comment")
            throw new CliError("ambiguous", "the completion comment could not be verified; rerun comforge recover, then this command", { operationId: id, status: outcome.status });
        commentId = outcome.resource.id;
        action = outcome.replayed ? "replayed" : "created";
    }
    const commentUrl = `${trusted.repository.webOrigin}/${owner}/${name}/issues/${input.issueNumber}#issuecomment-${commentId}`;
    const linkHead = input.pullRequest?.headSha ?? input.sourceRevision;
    if (record)
        await ctx.state.update(record.operationId, (r) => {
            if (!r.completions.some((c) => c.commentId === commentId))
                r.completions.push({
                    commit: linkHead,
                    issueNumber: input.issueNumber,
                    commentId,
                    completionDigest: digest,
                    outcome: input.outcome,
                    prNumber: input.pullRequest?.number ?? null,
                    at: nowIso(rt.now()),
                });
            for (const id of ops)
                if (!r.operations.includes(id))
                    r.operations.push(id);
        });
    let pullRequestLink = null;
    if (pull && applies) {
        const fresh = await readPull(gh, trusted, pull.number);
        if (fresh.head.sha !== linkHead)
            pullRequestLink = {
                prNumber: pull.number,
                action: "skipped",
                detail: `head moved to ${fresh.head.sha}`,
            };
        else {
            const current = fresh.body ?? "";
            const next = withCompletionLink(withoutWriterMarker(current), {
                issueNumber: input.issueNumber,
                url: commentUrl,
                headSha: linkHead,
            });
            if (next === withoutWriterMarker(current))
                pullRequestLink = { prNumber: pull.number, action: "up-to-date" };
            else {
                const digest = await bodyDigest(current);
                const id = await transitionIdentity(gh, operationId("pr-link", String(pull.number), digest, next));
                await remember(ctx, record?.operationId ?? null, id);
                try {
                    const outcome = await gh.write({
                        kind: "pull.update",
                        operationId: id,
                        pullNumber: pull.number,
                        expected: { bodyDigest: digest, headSha: linkHead },
                        body: next,
                    });
                    pullRequestLink =
                        outcome.status === "verified"
                            ? { prNumber: pull.number, action: "updated" }
                            : {
                                prNumber: pull.number,
                                action: "unresolved",
                                detail: "run comforge recover, then rerun",
                            };
                }
                catch (error) {
                    pullRequestLink = {
                        prNumber: pull.number,
                        action: "failed",
                        detail: `${error instanceof Error ? error.message : String(error)}; rerun to finish`,
                    };
                }
                if (record)
                    await ctx.state.update(record.operationId, (r) => {
                        if (!r.operations.includes(id))
                            r.operations.push(id);
                    });
            }
        }
    }
    const partial = pullRequestLink !== null &&
        pullRequestLink.action !== "updated" &&
        pullRequestLink.action !== "up-to-date";
    return {
        result: {
            executed: true,
            status: partial ? "partial" : "published",
            plan,
            comment: { id: commentId, url: commentUrl, action },
            pullRequestLink,
            authorization: authorized,
            closesIssue: false,
        },
        exit: partial ? EXIT.incomplete : EXIT.ok,
    };
}
// --- deliver ----------------------------------------------------------------------------
export async function deliver(ctx, options) {
    const { record, trusted } = await loadInitiative(ctx, options.id);
    const checkout = requireCheckout(record);
    const head = git(ctx.rt, checkout, ["rev-parse", "HEAD"]);
    const result = { ...options.raw };
    const path = evaluateLifecycleAction({
        action: "deliver",
        evidence: {
            issueType: String(result.issueType ?? ""),
            outcome: String(result.outcome ?? ""),
            head,
            baseSha: record.base.sha,
            ...(typeof result.sourceRevision === "string" && /^[0-9a-f]{40}$/.test(result.sourceRevision)
                ? { sourceRevision: result.sourceRevision }
                : {}),
            withoutPullRequest: options.withoutPullRequest === true,
        },
    });
    if (path.decision !== "allow")
        return refuse(path.reasons, "delivery refused");
    result.sourceRevision = path.facts.sourceRevision;
    const needsPr = path.facts.pullRequest === "required";
    const stages = {};
    if (!options.execute) {
        if (needsPr) {
            const dry = await publish(ctx, {
                id: options.id,
                title: options.title,
                draft: options.draft,
                execute: false,
            });
            stages.publish = dry.result.plan;
            result.pullRequest = {
                number: dry.result.plan.pullRequest.number ?? 1,
                headSha: head,
            };
        }
        parseResult(trusted, result);
        stages.completion = {
            action: "validated locally; published after the pull request is verified",
        };
        return { result: { initiative: options.id, executed: false, delivery: "planned", stages } };
    }
    const stop = (stage, error) => ({
        result: {
            initiative: options.id,
            executed: true,
            delivery: "incomplete",
            failedStage: stage,
            stages,
            error: error instanceof CliError
                ? { code: error.code, message: error.message, detail: error.detail }
                : { message: String(error) },
        },
        exit: EXIT.incomplete,
    });
    // One authorization for the whole delivery (one attempt of an owner grant).
    const authorized = await authorizeWrites(ctx, trusted, record, {
        head,
        grantFile: options.grantFile,
        command: "deliver",
    });
    stages.authorization = authorized;
    let prNumber = null;
    if (needsPr) {
        try {
            const published = await publish(ctx, {
                id: options.id,
                title: options.title,
                draft: options.draft,
                execute: true,
                authorized,
            });
            stages.publish = published.result;
            if (published.exit === EXIT.incomplete)
                return stop("publish", new CliError("incomplete", "the pull request handoff is incomplete", {
                    handoff: published.result.handoff,
                }));
            prNumber = published.result.pullRequest.number;
            result.pullRequest = { number: prNumber, headSha: head };
        }
        catch (error) {
            return stop("publish", error);
        }
    }
    try {
        const completed = await complete(ctx, { raw: result, execute: true, authorized });
        stages.completion = completed.result;
        if (completed.exit === EXIT.incomplete)
            return stop("completion", new CliError("incomplete", "the completion link is incomplete"));
    }
    catch (error) {
        return stop("completion", error);
    }
    return {
        result: {
            initiative: options.id,
            executed: true,
            delivery: "complete",
            pullRequest: prNumber,
            stages,
        },
    };
}
// --- recover ----------------------------------------------------------------------------
export async function recover(ctx, options) {
    const { record, trusted } = await loadInitiative(ctx, options.id);
    const gh = ctx.github(trusted);
    const operations = [];
    for (const id of record.operations) {
        const op = await gh.ledger.get(id).catch(() => null);
        operations.push({ operationId: id, kind: op?.kind ?? null, state: op?.state ?? "missing" });
    }
    const unresolved = operations.filter((o) => o.state === "indeterminate" || o.state === "sending" || o.state === "reserved");
    if (!options.execute)
        return {
            result: {
                initiative: options.id,
                executed: false,
                operations,
                unresolved: unresolved.map((o) => o.operationId),
            },
        };
    const authorized = await authorizeWrites(ctx, trusted, record, {
        head: record.publications.at(-1)?.commit ?? record.base.sha,
        grantFile: options.grantFile,
        command: "recover",
        // Reconciliation reads GitHub and settles the write ledger; abandoning is local. Neither is
        // a remote write, so the grant is verified (scope, expiry) but no attempt is spent.
        consume: false,
    });
    const reconciled = [];
    for (const o of unresolved) {
        const outcome = await gh.reconcile(o.operationId);
        let abandoned = false;
        // Abandoned only on request, and only when a complete search found no copy.
        if (options.abandon &&
            outcome.status === "indeterminate" &&
            outcome.reconciliation?.complete === true &&
            outcome.reconciliation.matches === 0) {
            await gh.abandon(o.operationId, "abandoned with comforge recover --abandon: a complete search found no copy");
            abandoned = true;
        }
        reconciled.push({
            operationId: o.operationId,
            status: abandoned ? "abandoned" : outcome.status,
            resource: outcome.resource,
            reason: outcome.reason ?? null,
        });
    }
    const stillOpen = reconciled.filter((r) => r.status !== "verified" && r.status !== "abandoned");
    return {
        result: {
            initiative: options.id,
            executed: true,
            operations,
            reconciled,
            authorization: authorized,
        },
        exit: stillOpen.length === 0 ? EXIT.ok : EXIT.incomplete,
    };
}
