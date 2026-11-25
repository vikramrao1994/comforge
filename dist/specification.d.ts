import type { PublishedMarker, SpecificationProtocol, SpecificationVerification } from "@comforge/core";
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
export declare function readSpecificationIssue(evidence: GitHubEvidence, protocol: SpecificationProtocol, number: number): Promise<SpecificationIssueEvidence>;
export type Reconciliation = {
    outcome: "absent";
} | {
    outcome: "existing" | "replayed";
    issue: IssueEvidence;
    marker: PublishedMarker;
};
/**
 * What already exists for a specification about to be published, from every issue in the
 * repository (refuses `incomplete` beyond the listing limit). `replayed`: the same idempotency
 * key already published this exact specification. `existing`: the ticket is published with
 * this digest. A key or ticket already used for different content is a `conflict`.
 */
export declare function reconcileSpecification(evidence: GitHubEvidence, protocol: SpecificationProtocol, request: {
    ticketId: string;
    digest: string;
    keyDigest: string;
}): Promise<Reconciliation>;
