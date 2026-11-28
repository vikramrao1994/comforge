import { createHash } from "node:crypto";
import { canonicalBody, canonicalTitle, idempotencyKeyDigest } from "@comforge/core";
import {
  bodyDigest,
  listAdvisoryReviews,
  readSpecificationIssue,
  reconcileSpecification,
} from "@comforge/github";
import {
  type Authorized,
  authorizeGovernanceWrite,
  commandGrantTemplate,
} from "../authorization.ts";
import { type ComforgeConfig, isCanonicalRepoPath, readableArtifacts } from "../config.ts";
import type { CommandContext } from "../context.ts";
import { fail } from "../errors.ts";
import { type GitHubAccess, githubError } from "../github.ts";
import {
  DISCUSSION_LIMITS,
  DISCUSSION_NOTICE,
  type DiscussionReviewReference,
  detectSecrets,
  discussionProtocol,
  reviewProtocol,
  specificationProtocol,
} from "../protocols.ts";
import { trustedBase } from "../repository.ts";
import type { CommandResult } from "./lifecycle.ts";

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

const opId = (prefix: string, ...parts: string[]) =>
  `${prefix}-${createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 40)}`;

/**
 * What a governance command needs, and nothing else (0.6.0): the trusted configuration, GitHub
 * access under it, the write authorization, a clock and cancellation. A checkout-backed command
 * builds it from its CommandContext (`governanceOf`); a checkout-free host builds it from a
 * configuration it has already verified against GitHub (`createRemoteGovernance`). The commands
 * cannot tell the two apart, so both publish the same records under the same checks.
 */
export interface GovernanceContext {
  /** The configuration of the base revision: candidate text cannot change what is checked. */
  trusted(): ComforgeConfig;
  github(trusted: ComforgeConfig): GitHubAccess;
  authorize(trusted: ComforgeConfig, options: AuthorizationRequest): Promise<Authorized>;
  now(): number;
  checkpoint(): void;
}

/** A governance write to authorize: a grant-scoped command, or a discussion comment. */
export type AuthorizationRequest =
  | { grantFile?: string; context: Parameters<typeof authorizeGovernanceWrite>[2]["context"] }
  | {
      grantFile?: string;
      context: {
        command: "publish-comment";
        ticket: string;
        issue: number;
        specification: { ticketId: string; digest: string; digestMatches: boolean };
      };
    };

/**
 * Discussion comments have no owner-grant command scope (the grant protocol cannot bind one), so
 * an owner-grant repository refuses them rather than accept a grant scoped to something else.
 */
export function discussionAuthorization(trusted: ComforgeConfig): Authorized {
  const a = trusted.security.authorization;
  if (!a)
    return fail(
      "authorization-required",
      "GitHub writes are not authorized in this repository: the trusted configuration sets no security.authorization",
    );
  if (a.mode !== "operator")
    return fail(
      "authorization-required",
      "discussion comments are published only in operator mode: no owner grant can be scoped to one",
    );
  return { mode: "operator" };
}

/** The governance context of a checkout: the base revision's configuration and the CLI's own authorization. */
export function governanceOf(ctx: CommandContext): GovernanceContext {
  return {
    trusted: () => trustedBase(ctx.rt, ctx.repo.root, ctx.working()).config,
    github: (trusted) => ctx.github(trusted),
    authorize: async (trusted, options) =>
      options.context.command === "publish-comment"
        ? discussionAuthorization(trusted)
        : authorizeGovernanceWrite(ctx, trusted, {
            ...(options.grantFile ? { grantFile: options.grantFile } : {}),
            context: options.context,
          }),
    now: () => ctx.rt.now(),
    checkpoint: () => ctx.checkpoint(),
  };
}

function reservedPrefixes(trusted: ComforgeConfig): string[] {
  return [
    `${trusted.security.markerNamespace}:`,
    ...(trusted.specification ? [`${trusted.specification.markerNamespace}:`] : []),
    ...(trusted.completion ? [`${trusted.completion.markerNamespace}:`] : []),
    ...(trusted.review ? [`${trusted.review.markerNamespace}:`] : []),
    ...(trusted.discussion ? [`${trusted.discussion.markerNamespace}:`] : []),
  ];
}

function refuseUnsafeText(trusted: ComforgeConfig, texts: readonly string[]) {
  for (const t of texts) {
    const prefix = reservedPrefixes(trusted).find((p) => t.includes(p));
    if (prefix) fail("policy-denied", `the text contains the reserved marker prefix ${prefix}`);
    const secrets = detectSecrets(t);
    if (secrets.count > 0)
      fail("policy-denied", "the text contains what looks like a credential; remove it first", {
        kinds: secrets.kinds,
      });
  }
}

function needCapability(trusted: ComforgeConfig, capability: string, why: string) {
  if (!(trusted.security.capabilities as readonly string[]).includes(capability))
    fail("config-invalid", `${why} needs the ${capability} capability in security.capabilities`);
}

// --- specification publication ------------------------------------------------------------

async function publishSpecificationWith(
  ctx: GovernanceContext,
  options: {
    ticket: string;
    title: string;
    body: string;
    /** Replace the specification of this existing issue instead of creating one. */
    issue?: number;
    idempotencyKey?: string;
    execute: boolean;
    grantFile?: string;
  },
): Promise<CommandResult> {
  const trusted = ctx.trusted();
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

  let target: { number: number; updatedAt: string; body: string } | null = null;
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
  } else {
    const current = await gh.evidence.getIssue(options.issue).catch(githubError);
    if (current.isPullRequest) fail("usage", `#${options.issue} is a pull request`);
    if (current.body.truncated) fail("conflict", `#${options.issue} is too long to compare safely`);
    const published = spec.verifyPublishedSpecification({
      title: current.title.text,
      body: current.body.text,
    });
    if (!published || published.ticketId !== options.ticket)
      return fail(
        "conflict",
        `#${options.issue} is not the published specification of ${options.ticket}`,
      );
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
      now: ctx.now(),
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
  const authorization = await ctx.authorize(trusted, {
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
    .write(
      target
        ? {
            kind: "issue.update",
            operationId,
            issueNumber: target.number,
            expected: { updatedAt: target.updatedAt, bodyDigest: expectedBody as string },
            changes: { title, body: issueBody },
          }
        : { kind: "issue.create", operationId, title, body: issueBody },
    )
    .catch(githubError);
  if (outcome.status !== "verified" || outcome.resource?.type !== "issue")
    return fail(
      "ambiguous",
      "the specification could not be verified; run this command again to reconcile",
      {
        operationId,
        status: outcome.status,
      },
    );
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

async function publishReviewWith(
  ctx: GovernanceContext,
  options: { review: unknown; execute: boolean; grantFile?: string },
): Promise<CommandResult> {
  const trusted = ctx.trusted();
  const rp = reviewProtocol(trusted);
  if (!rp) return fail("config-invalid", "advisory reviews need a review section");
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
  if (pr.state !== "open") fail("conflict", `#${pr.number} is not open`);
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

  let specification: { issueNumber: number; digest: string; digestVerified: boolean } | null = null;
  let verification: { ticketId: string; digest: string; digestMatches: boolean } | null = null;
  if (input.specificationIssueNumber !== undefined) {
    const spec = specificationProtocol(trusted);
    if (!spec) return fail("config-invalid", "a specification issue needs a specification section");
    const read = await readSpecificationIssue(
      gh.evidence,
      spec,
      input.specificationIssueNumber,
    ).catch(githubError);
    verification = read.verification;
    if (!verification)
      return fail(
        "conflict",
        `#${input.specificationIssueNumber} is not a published specification`,
      );
    specification = {
      issueNumber: input.specificationIssueNumber,
      digest: verification.digest,
      digestVerified: verification.digestMatches && verification.ticketId === input.ticketId,
    };
  }
  const payload = rp.buildReviewPayload(input, specification);
  const digest = rp.reviewDigest(rp.serializeReviewPayload(payload));
  const trustedAuthors = trusted.review?.trustedAuthors ?? [];
  const existing = (
    await listAdvisoryReviews(
      gh.evidence,
      rp,
      { number: pr.number, headSha: pr.head.sha },
      { trustedAuthors },
    ).catch(githubError)
  ).find((r) => r.integrity === "verified" && r.reviewDigest === digest && r.author === viewer);
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
    const grantTemplate =
      specification && verification
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
            now: ctx.now(),
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
  const authorization = await ctx.authorize(trusted, {
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
    return fail(
      "ambiguous",
      "the review comment could not be verified; run this command again to reconcile",
      {
        operationId,
        status: outcome.status,
      },
    );
  const commentId = outcome.resource.id;
  const readBack = (
    await listAdvisoryReviews(
      gh.evidence,
      rp,
      { number: pr.number, headSha: pr.head.sha },
      { trustedAuthors },
    ).catch(githubError)
  ).find((r) => r.commentId === commentId);
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

// --- discussion comments (0.6.0) --------------------------------------------------------------

/**
 * One owner-confirmed discussion comment on an open, published specification issue: never a
 * comment on any other issue or on a pull request, never a review, completion or authorization.
 * Idempotent per key: an earlier comment with the same key and content is replayed, the same key
 * with other content is a conflict, and the send goes through the writer's durable operation
 * identity, reconciled against GitHub first. A replay is answered even on a closed issue; a new
 * comment needs an open one.
 */
async function publishCommentWith(
  ctx: GovernanceContext,
  options: {
    issue: number;
    body: string;
    idempotencyKey: string;
    relatedReview?: { prNumber: number; commentId: number; reviewedHeadSha: string };
    execute: boolean;
    grantFile?: string;
  },
): Promise<CommandResult> {
  const trusted = ctx.trusted();
  const dp = discussionProtocol(trusted);
  if (!dp) return fail("config-invalid", "discussion comments need a discussion section");
  const spec = specificationProtocol(trusted);
  if (!spec) return fail("config-invalid", "discussion comments need a specification section");
  if (!Number.isSafeInteger(options.issue) || options.issue < 1)
    fail("usage", "an issue number is a positive integer");
  const body = dp.canonicalCommentBody(options.body ?? "");
  if (!body || body.length > DISCUSSION_LIMITS.bodyMaxChars)
    fail("usage", `a comment needs a body of 1–${DISCUSSION_LIMITS.bodyMaxChars} characters`);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/.test(options.idempotencyKey ?? ""))
    fail("usage", "the idempotency key must be 16–128 characters of [A-Za-z0-9._:-]");
  const related = options.relatedReview;
  if (
    related &&
    (!Number.isSafeInteger(related.prNumber) ||
      related.prNumber < 1 ||
      !Number.isSafeInteger(related.commentId) ||
      related.commentId < 1 ||
      !/^[0-9a-f]{40}$/.test(related.reviewedHeadSha ?? ""))
  )
    fail("usage", "relatedReview needs prNumber, commentId and a full 40-hex reviewedHeadSha");
  refuseUnsafeText(trusted, [body]);
  const input = {
    issueNumber: options.issue,
    body,
    ...(related ? { relatedReview: related } : {}),
  };
  const keyDigest = idempotencyKeyDigest(options.idempotencyKey);
  const digest = dp.commentDigest(input);
  const gh = ctx.github(trusted);
  ctx.checkpoint();

  const issue = await gh.evidence.getIssue(options.issue).catch(githubError);
  if (issue.isPullRequest)
    fail("usage", `#${options.issue} is a pull request; publish an advisory review instead`);
  if (issue.body.truncated) fail("conflict", `#${options.issue} is too long to verify safely`);
  // Narrow by design: never a generic comment tool for any issue in the repository.
  const published = spec.verifyPublishedSpecification({
    title: issue.title.text,
    body: issue.body.text,
  });
  if (!published)
    return fail("policy-denied", `#${options.issue} is not a published specification`);

  const earlier = await discussionComments(gh, dp, options.issue);
  const sameKey = earlier.find((c) => c.marker.keyDigest === keyDigest);
  if (sameKey && sameKey.marker.digest !== digest)
    return fail(
      "conflict",
      "this idempotency key was already used for a different comment; use a new key only for a new comment",
      { existingCommentId: sameKey.id, existingCommentUrl: sameKey.url },
    );
  const review = related
    ? await relatedReviewReference(gh, trusted, related, published.ticketId, Boolean(sameKey))
    : null;
  const shaped = (commentId: number, url: string | null, action: string, extra = {}) => ({
    result: {
      kind: "discussion",
      issueNumber: options.issue,
      ticket: published.ticketId,
      digest,
      scheme: dp.scheme,
      executed: options.execute,
      action,
      commentId,
      url,
      relatedReview: review
        ? {
            prNumber: review.prNumber,
            commentId: review.commentId,
            reviewedHeadSha: review.reviewedHeadSha,
            currentHeadSha: review.currentHeadSha,
            stale: review.stale,
          }
        : null,
      // Evidence only: discussion never authorizes anything.
      notice: DISCUSSION_NOTICE,
      ...extra,
    },
  });
  if (sameKey) return shaped(sameKey.id, sameKey.url, "replayed");
  if (issue.state !== "open")
    fail("conflict", `#${options.issue} is ${issue.state}; discussion belongs on open work`);
  if (!options.execute)
    return {
      result: {
        kind: "discussion",
        issueNumber: options.issue,
        ticket: published.ticketId,
        digest,
        scheme: dp.scheme,
        executed: false,
        action: "create",
      },
    };

  needCapability(trusted, "issues:comment", "publishing a discussion comment");
  const authorization = await ctx.authorize(trusted, {
    grantFile: options.grantFile,
    context: {
      command: "publish-comment",
      ticket: published.ticketId,
      issue: options.issue,
      specification: {
        ticketId: published.ticketId,
        digest: published.digest,
        digestMatches: published.digestMatches,
      },
    },
  });
  ctx.checkpoint();
  const operationId = opId("discussion", String(options.issue), keyDigest);
  const composed = dp.composeComment(input, review, keyDigest, digest);
  const outcome = await gh
    .write({
      kind: "issue.comment",
      operationId,
      issueNumber: options.issue,
      thread: "issue",
      body: composed,
    })
    .catch(githubError);
  if (outcome.status !== "verified" || outcome.resource?.type !== "comment")
    return fail(
      "ambiguous",
      "the comment could not be verified; run this command again with the same key to reconcile",
      { operationId, status: outcome.status },
    );
  const commentId = outcome.resource.id;
  const readBack = await gh.evidence.getIssueComment(commentId).catch(githubError);
  const marker = dp.parseMarker(readBack.body.text);
  if (
    readBack.issueNumber !== options.issue ||
    marker?.digest !== digest ||
    marker.keyDigest !== keyDigest ||
    !readBack.body.text.startsWith(composed)
  )
    fail("ambiguous", "the published comment does not read back as composed", {
      operationId,
      commentId,
    });
  return shaped(commentId, readBack.url, outcome.replayed ? "replayed" : "created", {
    operationId,
    authorization,
  });
}

/** Every discussion marker on the issue; the listing itself refuses past its page bound. */
async function discussionComments(
  gh: GitHubAccess,
  dp: NonNullable<ReturnType<typeof discussionProtocol>>,
  issue: number,
) {
  const comments = await gh.evidence.listIssueComments(issue).catch(githubError);
  if (comments.length > DISCUSSION_LIMITS.scanMax)
    fail(
      "conflict",
      `cannot rule out an earlier publication beyond ${DISCUSSION_LIMITS.scanMax} comments`,
    );
  return comments.flatMap((c) => {
    const marker = dp.parseMarker(c.body.text);
    return marker && marker.issueNumber === issue ? [{ id: c.id, url: c.url, marker }] : [];
  });
}

/** The verified review a comment refers to; on a replay a review that no longer verifies is dropped. */
async function relatedReviewReference(
  gh: GitHubAccess,
  trusted: ComforgeConfig,
  related: { prNumber: number; commentId: number; reviewedHeadSha: string },
  ticketId: string,
  replay: boolean,
): Promise<DiscussionReviewReference | null> {
  const rp = reviewProtocol(trusted);
  try {
    if (!rp) return fail("config-invalid", "a related review needs a review section");
    const pr = await gh.evidence.getPullRequest(related.prNumber).catch(githubError);
    const reviews = await listAdvisoryReviews(
      gh.evidence,
      rp,
      { number: pr.number, headSha: pr.head.sha },
      { trustedAuthors: trusted.review?.trustedAuthors ?? [] },
    ).catch(githubError);
    const r = reviews.find((x) => x.commentId === related.commentId);
    if (!r || r.integrity !== "verified")
      return fail("conflict", "the referenced review does not verify");
    if (r.reviewedHeadSha !== related.reviewedHeadSha)
      return fail("conflict", "the referenced review is of a different head", {
        reviewedHead: r.reviewedHeadSha,
      });
    if (r.ticketId !== ticketId)
      return fail("conflict", `the referenced review is for ${r.ticketId}, not ${ticketId}`);
    return {
      prNumber: pr.number,
      commentId: r.commentId,
      commentUrl: r.commentUrl ?? null,
      reviewedHeadSha: r.reviewedHeadSha,
      currentHeadSha: pr.head.sha,
      stale: r.reviewedHeadSha !== pr.head.sha,
    };
  } catch (error) {
    if (replay) return null;
    throw error;
  }
}

// --- verified reads --------------------------------------------------------------------------

async function issueCommentsWith(
  ctx: GovernanceContext,
  options: { issue: number },
): Promise<CommandResult> {
  const trusted = ctx.trusted();
  const comments = await ctx
    .github(trusted)
    .evidence.listIssueComments(options.issue)
    .catch(githubError);
  return { result: { issue: options.issue, comments } };
}

async function pullRequestsWith(
  ctx: GovernanceContext,
  options: { state?: "open" | "closed" | "all" },
): Promise<CommandResult> {
  const trusted = ctx.trusted();
  const pulls = await ctx
    .github(trusted)
    .evidence.listPullRequests({ state: options.state ?? "open" })
    .catch(githubError);
  return { result: { state: options.state ?? "open", pullRequests: pulls } };
}

async function advisoryReviewsWith(
  ctx: GovernanceContext,
  options: { pr: number },
): Promise<CommandResult> {
  const trusted = ctx.trusted();
  const rp = reviewProtocol(trusted);
  if (!rp) return fail("config-invalid", "advisory reviews need a review section");
  const gh = ctx.github(trusted);
  const pr = await gh.evidence.getPullRequest(options.pr).catch(githubError);
  const reviews = await listAdvisoryReviews(
    gh.evidence,
    rp,
    { number: pr.number, headSha: pr.head.sha },
    { trustedAuthors: trusted.review?.trustedAuthors ?? [] },
  ).catch(githubError);
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
export function artifactReadable(trusted: ComforgeConfig, file: string): boolean {
  if (!isCanonicalRepoPath(file)) return false;
  return readableArtifacts(trusted).some((dir) => file === dir || file.startsWith(`${dir}/`));
}

async function artifactWith(
  ctx: GovernanceContext,
  options: { commit: string; path: string },
): Promise<CommandResult> {
  const trusted = ctx.trusted();
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

// --- checkout-backed entry points (the CLI and the lifecycle services) ------------------------

export function publishSpecification(
  ctx: CommandContext,
  options: Parameters<typeof publishSpecificationWith>[1],
): Promise<CommandResult> {
  return publishSpecificationWith(governanceOf(ctx), options);
}

export function publishReview(
  ctx: CommandContext,
  options: Parameters<typeof publishReviewWith>[1],
): Promise<CommandResult> {
  return publishReviewWith(governanceOf(ctx), options);
}

export function issueComments(
  ctx: CommandContext,
  options: Parameters<typeof issueCommentsWith>[1],
): Promise<CommandResult> {
  return issueCommentsWith(governanceOf(ctx), options);
}

export function pullRequests(
  ctx: CommandContext,
  options: Parameters<typeof pullRequestsWith>[1],
): Promise<CommandResult> {
  return pullRequestsWith(governanceOf(ctx), options);
}

export function advisoryReviews(
  ctx: CommandContext,
  options: Parameters<typeof advisoryReviewsWith>[1],
): Promise<CommandResult> {
  return advisoryReviewsWith(governanceOf(ctx), options);
}

export function artifact(
  ctx: CommandContext,
  options: Parameters<typeof artifactWith>[1],
): Promise<CommandResult> {
  return artifactWith(governanceOf(ctx), options);
}

export function publishComment(
  ctx: CommandContext,
  options: Parameters<typeof publishCommentWith>[1],
): Promise<CommandResult> {
  return publishCommentWith(governanceOf(ctx), options);
}

/** The same commands over a supplied governance context (a checkout-free host). */
export const governanceCommands = {
  publishSpecification: publishSpecificationWith,
  publishReview: publishReviewWith,
  publishComment: publishCommentWith,
  issueComments: issueCommentsWith,
  pullRequests: pullRequestsWith,
  advisoryReviews: advisoryReviewsWith,
  artifact: artifactWith,
} as const;
