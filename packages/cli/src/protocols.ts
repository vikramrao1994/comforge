import {
  type CompletionProtocol,
  createCompletionProtocol,
  createReviewProtocol,
  createSpecificationProtocol,
  type Redaction,
  type ReviewProtocol,
  type SpecificationProtocol,
} from "@comforge/core";
import type { ComforgeConfig } from "./config.ts";
import { fail } from "./errors.ts";

/**
 * The @comforge/core specification and completion protocols, bound to the identity in the
 * trusted configuration. The kernel holds the contracts (schemas, digests, markers,
 * rendering); the configuration only names them, so a repository that configures the same
 * names produces byte-identical records.
 */

export function specificationProtocol(config: ComforgeConfig): SpecificationProtocol | null {
  const s = config.specification;
  return s
    ? createSpecificationProtocol({
        digestScheme: s.digestScheme,
        markerNamespace: s.markerNamespace,
        publisherName: s.publisherName,
        publishToolName: s.publishToolName,
      })
    : null;
}

/** Credential shapes a completion record must never carry. Pattern-based: a floor, not a proof. */
/** Bounds of a published advisory review; generous, fixed, and part of no digest. */
export const REVIEW_LIMITS = {
  summaryMaxChars: 4000,
  findingsMax: 50,
  findingTitleMaxChars: 200,
  findingTextMaxChars: 4000,
  notesMax: 20,
  noteMaxChars: 1000,
} as const;

export function reviewProtocol(config: ComforgeConfig): ReviewProtocol | null {
  const r = config.review;
  return r
    ? createReviewProtocol({
        reviewScheme: r.reviewScheme,
        repository: `${config.repository.owner}/${config.repository.name}`,
        markerNamespace: r.markerNamespace,
        publisherName: r.publisherName,
        publishToolName: r.publishToolName,
        ticketPattern: new RegExp(config.tickets.pattern),
        limits: { ...REVIEW_LIMITS },
      })
    : null;
}

const SECRET_PATTERNS: readonly [string, RegExp][] = [
  ["github-token", /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/g],
  ["aws-access-key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
  ["private-key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/g],
  ["slack-token", /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g],
  ["api-key", /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}\b/g],
  ["jwt", /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g],
];

export function detectSecrets(value: string): Redaction {
  const kinds: string[] = [];
  let count = 0;
  for (const [kind, pattern] of SECRET_PATTERNS) {
    const n = value.match(pattern)?.length ?? 0;
    if (n > 0) {
      count += n;
      kinds.push(kind);
    }
  }
  return { count, kinds };
}

export function completionProtocol(config: ComforgeConfig): CompletionProtocol {
  const c = config.completion;
  if (!c) return fail("config-invalid", "completion is not configured (completion section)");
  const spec = config.specification;
  const { owner, name, webOrigin } = config.repository;
  const slug = `${owner}/${name}`;
  const ticketPattern = new RegExp(config.tickets.pattern);
  return createCompletionProtocol({
    completionScheme: c.scheme,
    repository: slug,
    markerNamespace: c.markerNamespace,
    ticketPattern,
    reservedMarkerPrefixes: [
      `${c.markerNamespace}:`,
      ...(spec ? [`${spec.markerNamespace}:`] : []),
      `${config.security.markerNamespace}:`,
    ],
    runner: c.runner,
    publishCommand: c.publishCommand,
    links: {
      comment: (issue, comment) => `${webOrigin}/${slug}/issues/${issue}#issuecomment-${comment}`,
      blob: (commit, file) => `${webOrigin}/${slug}/blob/${commit}/${file}`,
    },
    redact: detectSecrets,
  });
}

/** Comment authors GitHub reports as owning the repository; a result by anyone else is never current. */
export const TRUSTED_ASSOCIATIONS: readonly string[] = ["OWNER", "MEMBER", "COLLABORATOR"];

export interface IssueCommentView {
  id: number;
  authorAssociation: string | null;
  body: string | null | undefined;
}

/**
 * The current completion result per ticket on one issue: the newest verified record by a
 * repository owner, member or collaborator. Earlier ones are superseded, never edited; a
 * forged or altered marker stays readable evidence and is never current.
 */
export function currentResults(
  protocol: CompletionProtocol,
  issueNumber: number,
  comments: readonly IssueCommentView[],
) {
  const current = new Map<string, number>();
  for (const comment of comments) {
    const marker = protocol.parseCompletionMarker(comment.body);
    if (!marker || marker.issueNumber !== issueNumber) continue;
    if (protocol.decodeCompletion(marker).integrity !== "verified") continue;
    if (!TRUSTED_ASSOCIATIONS.includes(comment.authorAssociation ?? "")) continue;
    current.set(marker.ticketId, comment.id);
  }
  return [...current.entries()].map(([ticketId, commentId]) => ({ ticketId, commentId }));
}
