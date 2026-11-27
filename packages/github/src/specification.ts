import type {
  PublishedMarker,
  SpecificationProtocol,
  SpecificationVerification,
} from "@comforge/core";
import { GitHubAdapterError } from "./errors.ts";
import type { GitHubEvidence, IssueEvidence } from "./evidence.ts";

/**
 * Published specifications on GitHub, read through `@comforge/core`'s specification
 * protocol. The protocol (digest scheme, marker namespace) is the caller's: this module
 * only fetches issues and asks the protocol. Publishing a specification issue is not here
 * on purpose: no `@comforge/core` authorization covers creating an issue, so the write
 * stays with a caller that has its own governed authority, and uses `reconcileSpecification`
 * first to stay idempotent.
 */

export interface SpecificationIssueEvidence {
  issue: IssueEvidence;
  /** The marker and whether the issue still hashes to it; null when the issue carries none. */
  verification: SpecificationVerification | null;
  /** The delimited text the digest covers, or null. Untrusted data. */
  specification: string | null;
  /** A marker is present and the current title and body still hash to it. */
  verified: boolean;
}

export async function readSpecificationIssue(
  evidence: GitHubEvidence,
  protocol: SpecificationProtocol,
  number: number,
): Promise<SpecificationIssueEvidence> {
  const issue = await evidence.getIssue(number);
  if (issue.isPullRequest)
    throw new GitHubAdapterError(
      "wrong-target",
      `#${number} is a pull request, not a specification issue`,
    );
  if (issue.title.truncated || issue.body.truncated)
    throw new GitHubAdapterError(
      "incomplete",
      `#${number} exceeds the text limit; its digest cannot be checked`,
    );
  const verification = protocol.verifyPublishedSpecification({
    title: issue.title.text,
    body: issue.body.text,
  });
  return {
    issue,
    verification,
    specification: protocol.extractSpecificationBody(issue.body.text),
    verified: verification?.digestMatches === true,
  };
}

export type Reconciliation =
  | { outcome: "absent" }
  | { outcome: "existing" | "replayed"; issue: IssueEvidence; marker: PublishedMarker };

/**
 * What already exists for a specification about to be published, from every issue in the
 * repository (refuses `incomplete` beyond the listing limit). `replayed`: the same idempotency
 * key already published this exact specification. `existing`: the ticket is published with
 * this digest. A key or ticket already used for different content is a `conflict`.
 */
export async function reconcileSpecification(
  evidence: GitHubEvidence,
  protocol: SpecificationProtocol,
  request: { ticketId: string; digest: string; keyDigest: string },
): Promise<Reconciliation> {
  const published: { issue: IssueEvidence; marker: PublishedMarker }[] = [];
  for (const issue of await evidence.listIssues({ state: "all" })) {
    // A cut body could hide its marker, and "absent" would then invite a duplicate.
    if (issue.body.truncated)
      throw new GitHubAdapterError(
        "incomplete",
        `#${issue.number} exceeds the text limit; cannot reconcile`,
      );
    const marker = protocol.parsePublishedMarker(issue.body.text);
    if (marker) published.push({ issue, marker });
  }
  const sameKey = published.find((p) => p.marker.keyDigest === request.keyDigest);
  if (sameKey) {
    if (sameKey.marker.ticketId === request.ticketId && sameKey.marker.digest === request.digest)
      return { outcome: "replayed", ...sameKey };
    throw new GitHubAdapterError(
      "conflict",
      "The idempotency key was already used for a different specification",
      {
        issue: sameKey.issue.number,
      },
    );
  }
  const sameTicket = published.find((p) => p.marker.ticketId === request.ticketId);
  if (sameTicket) {
    if (sameTicket.marker.digest === request.digest) return { outcome: "existing", ...sameTicket };
    throw new GitHubAdapterError(
      "conflict",
      `${request.ticketId} is already published with different content`,
      {
        issue: sameTicket.issue.number,
      },
    );
  }
  return { outcome: "absent" };
}
