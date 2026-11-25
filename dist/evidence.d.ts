import type { GitHubTransport } from "./transport.ts";
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
export declare const UNTRUSTED: "untrusted";
export interface RepositoryRef {
    owner: string;
    name: string;
}
export interface EvidenceLimits {
    /** Items per page requested from GitHub (≤ 100). */
    perPage: number;
    /** Pages read before a listing is refused as `incomplete`. */
    maxPages: number;
    /** Characters kept of any person-written text field. */
    maxTextChars: number;
}
export declare const DEFAULT_LIMITS: EvidenceLimits;
export interface UntrustedText {
    text: string;
    truncated: boolean;
    trust: typeof UNTRUSTED;
}
export interface IssueEvidence {
    repository: string;
    number: number;
    isPullRequest: boolean;
    title: UntrustedText;
    body: UntrustedText;
    state: string;
    author: string | null;
    labels: string[];
    url: string;
    createdAt: string;
    updatedAt: string;
}
export interface PullRequestEvidence {
    repository: string;
    number: number;
    title: UntrustedText;
    state: string;
    draft: boolean;
    merged: boolean;
    author: string | null;
    url: string;
    base: {
        ref: string;
        sha: string;
    };
    head: {
        ref: string;
        sha: string;
        repository: string | null;
    };
}
export interface ChangedFile {
    path: string;
    previousPath: string | null;
    status: string;
    additions: number;
    deletions: number;
    changes: number;
}
export interface PullRequestFilesEvidence {
    repository: string;
    number: number;
    headSha: string;
    files: ChangedFile[];
}
export interface ReviewEvidence {
    id: number;
    author: string | null;
    state: string;
    commitSha: string | null;
    submittedAt: string | null;
    body: UntrustedText;
}
export interface CheckEvidence {
    repository: string;
    sha: string;
    checks: {
        name: string;
        status: string;
        conclusion: string | null;
        app: string | null;
        completedAt: string | null;
    }[];
    required: {
        name: string;
        conclusion: string | null;
        satisfied: boolean;
    }[];
    /** Every required check has a successful run on exactly `sha`. False when nothing is required. */
    ok: boolean;
}
export interface GitHubEvidence {
    readonly repository: string;
    getIssue(number: number): Promise<IssueEvidence>;
    /** Issues only (pull requests excluded), oldest first; refuses `incomplete` beyond the page limit. */
    listIssues(options?: {
        state?: "open" | "closed" | "all";
    }): Promise<IssueEvidence[]>;
    getPullRequest(number: number, options?: {
        expectedHeadSha?: string;
    }): Promise<PullRequestEvidence>;
    /** The changed files of a pull request whose head is exactly `headSha`, before and after the read. */
    listPullRequestFiles(number: number, headSha: string): Promise<PullRequestFilesEvidence>;
    /** Reviews; with `commitSha`, only those submitted on that exact commit. */
    listReviews(number: number, options?: {
        commitSha?: string;
    }): Promise<ReviewEvidence[]>;
    /** Check runs GitHub recorded for exactly `sha`, judged against `required` check names. */
    getChecks(sha: string, required?: readonly string[]): Promise<CheckEvidence>;
}
export declare function createGitHubEvidence(options: {
    transport: GitHubTransport;
    repository: RepositoryRef;
    limits?: Partial<EvidenceLimits>;
}): GitHubEvidence;
