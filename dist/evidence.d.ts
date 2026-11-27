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
    /** GitHub's `author_association`; empty when GitHub sent none. */
    authorAssociation: string;
    /** The GitHub App the issue was created through, when GitHub said. Attribution, not authority. */
    performedViaGitHubApp: string | null;
    closedAt: string | null;
    /** GitHub's comment count, when it said. */
    commentCount: number | null;
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
    body: UntrustedText;
    /** The fields below are null when GitHub did not send them. */
    createdAt: string | null;
    updatedAt: string | null;
    mergedAt: string | null;
    commits: number | null;
    changedFiles: number | null;
}
export type PatchStatus = "included" | "truncated" | "omitted-budget" | "omitted-by-request" | "unavailable";
export interface ChangedFile {
    path: string;
    previousPath: string | null;
    status: string;
    additions: number;
    deletions: number;
    changes: number;
    /** GitHub sent no patch and the name is a binary format: there is no text to show. */
    binary: boolean;
    /**
     * Why `patch` is or is not here. `unavailable`: GitHub sent none (binary or too large for it);
     * never an empty patch. `omitted-*`: GitHub sent one and the caller's request or budget left it out.
     */
    patchStatus: PatchStatus;
    patch: UntrustedText | null;
}
export interface PatchLimits {
    /** Characters kept of one file's patch. */
    perFileMaxChars: number;
    /** Characters kept across all patches, in GitHub's file order. */
    totalMaxChars: number;
}
export declare const DEFAULT_PATCH_LIMITS: PatchLimits;
export interface WorkflowRunEvidence {
    repository: string;
    sha: string;
    /** Workflow runs for exactly `sha`. Evidence of what ran, never a verdict on required checks. */
    runs: {
        id: number;
        name: string | null;
        status: string | null;
        conclusion: string | null;
        event: string;
        createdAt: string;
    }[];
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
        startedAt: string | null;
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
export interface CommitComparison {
    repository: string;
    base: string;
    head: string;
    /** How `head` relates to `base`: `ahead` means `head` has commits `base` lacks. */
    status: "identical" | "ahead" | "behind" | "diverged";
    /** Commits on `head` that are not on `base`. */
    aheadBy: number;
    /** Commits on `base` that are not on `head`. */
    behindBy: number;
    mergeBase: string;
}
export interface IssueCommentEvidence {
    id: number;
    author: string | null;
    /** GitHub's account type (`User`, `Bot`, ...), when it said. */
    authorType: string | null;
    /** GitHub's `author_association` (`OWNER`, `NONE`, ...); empty when GitHub sent none. */
    authorAssociation: string;
    createdAt: string;
    updatedAt: string;
    body: UntrustedText;
    /** The comment's web URL, when GitHub sent it. */
    url: string | null;
    performedViaGitHubApp: string | null;
}
export interface PullRequestSummary {
    number: number;
    state: string;
    draft: boolean;
    /** `merged_at` is set. */
    merged: boolean;
    title: UntrustedText;
    author: string | null;
    headRef: string;
    headSha: string;
    baseRef: string;
    /** The base branch's SHA as GitHub listed it, when it did. */
    baseSha: string | null;
    createdAt: string;
    updatedAt: string;
}
export interface FileLimits {
    /** Largest file read as text, in bytes. Default 262 144. */
    maxBytes: number;
}
export declare const DEFAULT_FILE_LIMITS: FileLimits;
export interface FileAtCommitEvidence {
    commitSha: string;
    path: string;
    /** The blob's SHA as GitHub reported it. */
    blobSha: string;
    size: number;
    /** `too-large`: over `maxBytes`, or GitHub sent no inline content. `binary`: NUL or not UTF-8. */
    kind: "text" | "binary" | "too-large";
    /** Present only for `kind: "text"`. Untrusted data; raw base64 is never returned. */
    text?: UntrustedText;
}
/**
 * One page of a listing, exactly as GitHub windowed it: nothing is read beyond it, so it is
 * never complete evidence of the whole listing. `hasMore` is GitHub's page being full.
 */
export interface PageWindow<T> {
    items: T[];
    page: number;
    perPage: number;
    hasMore: boolean;
}
export interface PageRequest {
    /** 1-based. */
    page?: number;
    /** 1–100. */
    perPage?: number;
}
export interface IssueEventEvidence {
    event: string;
    actor: string | null;
    label: string | null;
    performedViaGitHubApp: string | null;
    createdAt: string;
}
export interface ReviewCommentEvidence {
    id: number;
    author: string | null;
    path: string;
    line: number | null;
    commitSha: string;
    createdAt: string;
    body: UntrustedText;
}
/** Exact bytes of a file at one commit (never decoded or re-encoded). */
export type FileBytesEvidence = {
    commitSha: string;
    path: string;
    blobSha: string;
    size: number;
    kind: "bytes";
    bytes: Uint8Array;
} | {
    commitSha: string;
    path: string;
    blobSha: string;
    size: number;
    kind: "too-large";
};
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
    /**
     * The changed files of a pull request whose head is exactly `headSha`, before and after the
     * read. With `patches`, each file's patch text within the per-file and total budgets.
     */
    listPullRequestFiles(number: number, headSha: string, options?: {
        patches?: Partial<PatchLimits> | true;
    }): Promise<PullRequestFilesEvidence>;
    /** Reviews; with `commitSha`, only those submitted on that exact commit. */
    listReviews(number: number, options?: {
        commitSha?: string;
    }): Promise<ReviewEvidence[]>;
    /** Check runs GitHub recorded for exactly `sha`, judged against `required` check names. */
    getChecks(sha: string, required?: readonly string[]): Promise<CheckEvidence>;
    /**
     * Workflow runs GitHub recorded for exactly `sha`: a read for credentials without check-run
     * access. Which one to trust when is the caller's policy; this never reports success.
     */
    listWorkflowRuns(sha: string): Promise<WorkflowRunEvidence>;
    /**
     * Every comment of an issue or pull request (GitHub's issue-comments endpoint), oldest
     * first. `since` (ISO 8601) is passed to GitHub. A listing beyond `maxPages` is refused
     * with `incomplete`, never returned partial. Comment bodies are bounded untrusted text.
     */
    listIssueComments(issue: number, options?: {
        since?: string;
    }): Promise<IssueCommentEvidence[]>;
    /**
     * Pull requests, newest first (`state` default `open`; optionally only those targeting
     * `base`). Refuses `incomplete` beyond `maxPages`, like every listing.
     */
    listPullRequests(options?: {
        state?: "open" | "closed" | "all";
        base?: string;
    }): Promise<PullRequestSummary[]>;
    /**
     * A file bound to one immutable revision: `commitSha` must be a full 40-hex commit SHA
     * (never a branch or tag) and `path` a plain relative path, both checked before any request.
     * A directory, symlink, submodule or a response for another path is refused.
     */
    getFileAtCommit(commitSha: string, path: string, limits?: Partial<FileLimits>): Promise<FileAtCommitEvidence>;
    /** How commit `head` relates to commit `base` (both full SHAs), as GitHub's compare reports it. */
    compareCommits(base: string, head: string): Promise<CommitComparison>;
    /** Issues of one page; pull requests are dropped from the page and counted. */
    listIssuesPage(options?: PageRequest & {
        state?: "open" | "closed" | "all";
        labels?: readonly string[];
        sort?: "created" | "updated" | "comments";
        direction?: "asc" | "desc";
    }): Promise<PageWindow<IssueEvidence> & {
        excludedPullRequests: number;
    }>;
    listPullRequestsPage(options?: PageRequest & {
        state?: "open" | "closed" | "all";
        sort?: "created" | "updated";
        direction?: "asc" | "desc";
    }): Promise<PageWindow<PullRequestSummary>>;
    listIssueCommentsPage(issue: number, options?: PageRequest): Promise<PageWindow<IssueCommentEvidence>>;
    listIssueEventsPage(issue: number, options?: PageRequest): Promise<PageWindow<IssueEventEvidence>>;
    listReviewsPage(pullRequest: number, options?: PageRequest): Promise<PageWindow<ReviewEvidence>>;
    /** Inline review comments of a pull request (`pulls/{n}/comments`). */
    listReviewCommentsPage(pullRequest: number, options?: PageRequest): Promise<PageWindow<ReviewCommentEvidence>>;
    /** One issue or pull-request comment by id, with the issue number it belongs to. */
    getIssueComment(id: number): Promise<IssueCommentEvidence & {
        issueNumber: number;
    }>;
    /**
     * The exact bytes of a file at a full 40-hex commit, under the same path and target checks as
     * `getFileAtCommit`. `too-large`: over `maxBytes`, or GitHub sent no inline content.
     */
    getFileBytesAtCommit(commitSha: string, path: string, limits?: Partial<FileLimits>): Promise<FileBytesEvidence>;
    /**
     * Whether `commitSha` is the head or one of the commits of a pull request. Reads at most
     * `maxCommits` commits (GitHub lists at most 250); a commit beyond them is reported as not
     * belonging, so a caller that needs membership refuses it.
     */
    pullRequestContainsCommit(pullRequest: number, commitSha: string, options?: {
        maxCommits?: number;
    }): Promise<{
        belongs: boolean;
        isHead: boolean;
    }>;
}
export declare function createGitHubEvidence(options: {
    transport: GitHubTransport;
    repository: RepositoryRef;
    limits?: Partial<EvidenceLimits>;
}): GitHubEvidence;
