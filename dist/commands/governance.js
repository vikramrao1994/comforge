import { createHash } from "node:crypto";
import { canonicalBody, canonicalTitle, idempotencyKeyDigest } from "@comforge/core";
import { bodyDigest, listAdvisoryReviews, readSpecificationIssue, reconcileSpecification, } from "@comforge/github";
import { authorizeGovernanceWrite, commandGrantTemplate } from "../authorization.js";
import { isCanonicalRepoPath, readableArtifacts } from "../config.js";
import { fail } from "../errors.js";
import { githubError } from "../github.js";
import { detectSecrets, reviewProtocol, specificationProtocol } from "../protocols.js";
import { trustedBase } from "../repository.js";
/**
 * Governance services (M10): generic, transport-neutral operations a lifecycle tool needs
 * beyond one initiative — publishing a specification, publishing an advisory review, and the
 * verified reads around them (issue comments, pull requests, advisory reviews, commit-bound
 * artifacts). All of them run under the trusted configuration of the base revision.
 *
 * Invariants:
 * - A specification and a review are published through the @comforge/github writer under a
 *   durable operation identity (rerun = replay from the write ledger), and reconciled against
 *   GitHub before anything is written, so a lost response never produces a second issue or
 *   comment.
 * - An advisory review is one marked issue comment on the pull request — never a native
 *   GitHub review, never an approval, never execution authority — bound to the exact head that
 *   was reviewed, and refused for one's own pull request.
 * - Owner-grant repositories need a command grant scoping exactly the command (see
 *   authorizeGovernanceWrite); a publication grant never authorizes either.
 * - Candidate text that carries a reserved marker prefix or a credential is refused, not
 *   published.
 */
const opId = (prefix, ...parts) => `${prefix}-${createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 40)}`;
/** The configuration of the base revision (candidate text cannot change what is checked). */
function trustedNow(ctx) {
    return trustedBase(ctx.rt, ctx.repo.root, ctx.working()).config;
}
function reservedPrefixes(trusted) {
    return [
        `${trusted.security.markerNamespace}:`,
        ...(trusted.specification ? [`${trusted.specification.markerNamespace}:`] : []),
        ...(trusted.completion ? [`${trusted.completion.markerNamespace}:`] : []),
        ...(trusted.review ? [`${trusted.review.markerNamespace}:`] : []),
    ];
}
function refuseUnsafeText(trusted, texts) {
    for (const t of texts) {
        const prefix = reservedPrefixes(trusted).find((p) => t.includes(p));
        if (prefix)
            fail("policy-denied", `the text contains the reserved marker prefix ${prefix}`);
        const secrets = detectSecrets(t);
        if (secrets.count > 0)
            fail("policy-denied", "the text contains what looks like a credential; remove it first", {
                kinds: secrets.kinds,
            });
    }
}
function needCapability(trusted, capability, why) {
    if (!trusted.security.capabilities.includes(capability))
        fail("config-invalid", `${why} needs the ${capability} capability in security.capabilities`);
}
// --- specification publication ------------------------------------------------------------
export async function publishSpecification(ctx, options) {
    const trusted = trustedNow(ctx);
    const spec = specificationProtocol(trusted);
    if (!spec)
        return fail("config-invalid", "specification publication needs a specification section");
    if (!new RegExp(trusted.tickets.pattern).test(options.ticket))
        fail("usage", `${options.ticket} is not a ticket id of this repository`);
    const title = canonicalTitle(options.title);
    const body = canonicalBody(options.body);
    if (!title || title.length > 256)
        fail("usage", "a specification needs a title of 1–256 characters");
    if (!body || body.length > 60_000)
        fail("usage", "a specification needs a body of 1–60000 characters");
    refuseUnsafeText(trusted, [title, body]);
    const digest = spec.specificationDigest({ ticketId: options.ticket, title, body });
    const key = options.idempotencyKey ?? `${options.ticket}:${digest}`;
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(key))
        fail("usage", "--key must be 8–128 characters of [A-Za-z0-9._:-]");
    const keyDigest = idempotencyKeyDigest(key);
    const gh = ctx.github(trusted);
    ctx.checkpoint();
    let target = null;
    if (options.issue === undefined) {
        const found = await reconcileSpecification(gh.evidence, spec, {
            ticketId: options.ticket,
            digest,
            keyDigest,
        }).catch(githubError);
        if (found.outcome !== "absent")
            return {
                result: {
                    ticket: options.ticket,
                    digest,
                    executed: options.execute,
                    action: "replayed",
                    issueNumber: found.issue.number,
                    url: found.issue.url,
                },
            };
    }
    else {
        const current = await gh.evidence.getIssue(options.issue).catch(githubError);
        if (current.isPullRequest)
            fail("usage", `#${options.issue} is a pull request`);
        if (current.body.truncated)
            fail("conflict", `#${options.issue} is too long to compare safely`);
        const published = spec.verifyPublishedSpecification({
            title: current.title.text,
            body: current.body.text,
        });
        if (!published || published.ticketId !== options.ticket)
            return fail("conflict", `#${options.issue} is not the published specification of ${options.ticket}`);
        if (published.digest === digest && published.digestMatches)
            return {
                result: {
                    ticket: options.ticket,
                    digest,
                    executed: options.execute,
                    action: "replayed",
                    issueNumber: current.number,
                    url: current.url,
                },
            };
        target = { number: current.number, updatedAt: current.updatedAt, body: current.body.text };
    }
    const action = target ? "update" : "create";
    if (!options.execute) {
        const grantTemplate = commandGrantTemplate(trusted, {
            ticket: options.ticket,
            issue: target?.number ?? null,
            specDigest: digest,
            scope: {
                command: "publish-specification",
                target: target ? { kind: "issue", number: target.number } : { kind: "new" },
            },
            now: ctx.rt.now(),
        });
        return {
            result: {
                ticket: options.ticket,
                digest,
                executed: false,
                action,
                issueNumber: target?.number ?? null,
                ...(grantTemplate ? { grantTemplate } : {}),
            },
        };
    }
    needCapability(trusted, target ? "issues:update" : "issues:create", "publishing a specification");
    const authorization = await authorizeGovernanceWrite(ctx, trusted, {
        grantFile: options.grantFile,
        context: {
            command: "publish-specification",
            ticket: options.ticket,
            publishing: { ticketId: options.ticket, digest, issue: target?.number ?? null },
        },
    });
    ctx.checkpoint();
    const issueBody = spec.composeIssueBody({ ticketId: options.ticket, body, digest, keyDigest });
    const operationId = opId("specification", options.ticket, digest, keyDigest);
    const expectedBody = target ? await bodyDigest(target.body) : null;
    const outcome = await gh
        .write(target
        ? {
            kind: "issue.update",
            operationId,
            issueNumber: target.number,
            expected: { updatedAt: target.updatedAt, bodyDigest: expectedBody },
            changes: { title, body: issueBody },
        }
        : { kind: "issue.create", operationId, title, body: issueBody })
        .catch(githubError);
    if (outcome.status !== "verified" || outcome.resource?.type !== "issue")
        return fail("ambiguous", "the specification could not be verified; run this command again to reconcile", {
            operationId,
            status: outcome.status,
        });
    const number = outcome.resource.number;
    // Read back through the same verification every consumer uses.
    const readBack = await readSpecificationIssue(gh.evidence, spec, number).catch(githubError);
    if (!readBack.verification?.digestMatches || readBack.verification.digest !== digest)
        fail("ambiguous", `#${number} does not verify as the published specification`, { operationId });
    return {
        result: {
            ticket: options.ticket,
            digest,
            executed: true,
            action: outcome.replayed ? "replayed" : target ? "updated" : "created",
            issueNumber: number,
            url: readBack.issue.url,
            operationId,
            authorization,
        },
    };
}
// --- advisory review publication -----------------------------------------------------------
export async function publishReview(ctx, options) {
    const trusted = trustedNow(ctx);
    const rp = reviewProtocol(trusted);
    if (!rp)
        return fail("config-invalid", "advisory reviews need a review section");
    const parsed = rp.inputSchema.safeParse(options.review);
    if (!parsed.success)
        return fail("usage", "the review does not match the review input schema", {
            issues: parsed.error.issues
                .slice(0, 10)
                .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
        });
    const input = parsed.data;
    if (rp.containsReservedMarker(input))
        fail("policy-denied", "the review contains a reserved marker prefix");
    refuseUnsafeText(trusted, rp.reviewTexts(input));
    const gh = ctx.github(trusted);
    ctx.checkpoint();
    const pr = await gh.evidence.getPullRequest(input.prNumber).catch(githubError);
    if (pr.state !== "open")
        fail("conflict", `#${pr.number} is not open`);
    if (pr.head.sha !== input.expectedHeadSha)
        fail("stale", "the pull request head moved after the reviewed head; review the current head", {
            reviewedHead: input.expectedHeadSha,
            currentHead: pr.head.sha,
        });
    const viewer = await gh.login();
    if (pr.author && pr.author.toLowerCase() === viewer.toLowerCase())
        fail("policy-denied", "an advisory review of one's own pull request is refused", {
            author: pr.author,
        });
    let specification = null;
    let verification = null;
    if (input.specificationIssueNumber !== undefined) {
        const spec = specificationProtocol(trusted);
        if (!spec)
            return fail("config-invalid", "a specification issue needs a specification section");
        const read = await readSpecificationIssue(gh.evidence, spec, input.specificationIssueNumber).catch(githubError);
        verification = read.verification;
        if (!verification)
            return fail("conflict", `#${input.specificationIssueNumber} is not a published specification`);
        specification = {
            issueNumber: input.specificationIssueNumber,
            digest: verification.digest,
            digestVerified: verification.digestMatches && verification.ticketId === input.ticketId,
        };
    }
    const payload = rp.buildReviewPayload(input, specification);
    const digest = rp.reviewDigest(rp.serializeReviewPayload(payload));
    const trustedAuthors = trusted.review?.trustedAuthors ?? [];
    const existing = (await listAdvisoryReviews(gh.evidence, rp, { number: pr.number, headSha: pr.head.sha }, { trustedAuthors }).catch(githubError)).find((r) => r.integrity === "verified" && r.reviewDigest === digest && r.author === viewer);
    if (existing)
        return {
            result: {
                kind: "advisory",
                pullRequest: pr.number,
                reviewedHead: pr.head.sha,
                digest,
                executed: options.execute,
                action: "replayed",
                commentId: existing.commentId,
            },
        };
    if (!options.execute) {
        const grantTemplate = specification && verification
            ? commandGrantTemplate(trusted, {
                ticket: input.ticketId,
                issue: specification.issueNumber,
                specDigest: verification.digest,
                scope: {
                    command: "publish-review",
                    pullRequest: pr.number,
                    reviewedHead: input.expectedHeadSha,
                    reviewDigest: digest,
                },
                now: ctx.rt.now(),
            })
            : null;
        return {
            result: {
                kind: "advisory",
                pullRequest: pr.number,
                reviewedHead: pr.head.sha,
                digest,
                executed: false,
                action: "create",
                ...(grantTemplate ? { grantTemplate } : {}),
            },
        };
    }
    needCapability(trusted, "issues:comment", "publishing an advisory review");
    const authorization = await authorizeGovernanceWrite(ctx, trusted, {
        grantFile: options.grantFile,
        context: {
            command: "publish-review",
            ticket: input.ticketId,
            ...(specification ? { issue: specification.issueNumber } : {}),
            specification: verification,
            pullRequest: { number: pr.number, headSha: pr.head.sha, open: true, merged: false },
            review: { pullRequest: pr.number, reviewedHead: input.expectedHeadSha, digest },
        },
    });
    ctx.checkpoint();
    const operationId = opId("review", String(pr.number), digest);
    const outcome = await gh
        .write({
        kind: "issue.comment",
        operationId,
        issueNumber: pr.number,
        thread: "pull-request",
        body: rp.composeReviewComment(payload, idempotencyKeyDigest(input.idempotencyKey)),
    })
        .catch(githubError);
    if (outcome.status !== "verified" || outcome.resource?.type !== "comment")
        return fail("ambiguous", "the review comment could not be verified; run this command again to reconcile", {
            operationId,
            status: outcome.status,
        });
    const commentId = outcome.resource.id;
    const readBack = (await listAdvisoryReviews(gh.evidence, rp, { number: pr.number, headSha: pr.head.sha }, { trustedAuthors }).catch(githubError)).find((r) => r.commentId === commentId);
    if (readBack?.integrity !== "verified" || readBack.reviewDigest !== digest)
        fail("ambiguous", "the published review does not verify", { operationId, commentId });
    return {
        result: {
            kind: "advisory",
            pullRequest: pr.number,
            reviewedHead: pr.head.sha,
            digest,
            executed: true,
            action: outcome.replayed ? "replayed" : "created",
            commentId,
            operationId,
            authorization,
        },
    };
}
// --- verified reads --------------------------------------------------------------------------
export async function issueComments(ctx, options) {
    const trusted = trustedNow(ctx);
    const comments = await ctx
        .github(trusted)
        .evidence.listIssueComments(options.issue)
        .catch(githubError);
    return { result: { issue: options.issue, comments } };
}
export async function pullRequests(ctx, options) {
    const trusted = trustedNow(ctx);
    const pulls = await ctx
        .github(trusted)
        .evidence.listPullRequests({ state: options.state ?? "open" })
        .catch(githubError);
    return { result: { state: options.state ?? "open", pullRequests: pulls } };
}
export async function advisoryReviews(ctx, options) {
    const trusted = trustedNow(ctx);
    const rp = reviewProtocol(trusted);
    if (!rp)
        return fail("config-invalid", "advisory reviews need a review section");
    const gh = ctx.github(trusted);
    const pr = await gh.evidence.getPullRequest(options.pr).catch(githubError);
    const reviews = await listAdvisoryReviews(gh.evidence, rp, { number: pr.number, headSha: pr.head.sha }, { trustedAuthors: trusted.review?.trustedAuthors ?? [] }).catch(githubError);
    return {
        result: {
            pullRequest: pr.number,
            currentHead: pr.head.sha,
            // Advisory evidence only: not native reviews, not approvals, never authorization.
            kind: "advisory",
            reviews,
        },
    };
}
/**
 * Whether `file` may be read remotely under the trusted configuration's artifact policy. Only a
 * canonical path is matched (no `..`, `.`, empty segment or backslash), and only at a directory
 * boundary; a non-canonical spelling is refused, never normalized into a match.
 */
export function artifactReadable(trusted, file) {
    if (!isCanonicalRepoPath(file))
        return false;
    return readableArtifacts(trusted).some((dir) => file === dir || file.startsWith(`${dir}/`));
}
export async function artifact(ctx, options) {
    const trusted = trustedNow(ctx);
    if (!/^[0-9a-f]{40}$/.test(options.commit))
        fail("usage", "an artifact is read at a full 40-character commit sha");
    if (!artifactReadable(trusted, options.path))
        fail("policy-denied", `${options.path} is outside the readable artifact paths`, {
            readable: readableArtifacts(trusted),
            ...(isCanonicalRepoPath(options.path) ? {} : { reason: "not a canonical repository path" }),
        });
    const file = await ctx
        .github(trusted)
        .evidence.getFileAtCommit(options.commit, options.path)
        .catch(githubError);
    return { result: { artifact: file } };
}
