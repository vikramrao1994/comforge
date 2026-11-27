import { z } from "zod";
import { GitHubAdapterError } from "./errors.ts";
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

export const UNTRUSTED = "untrusted" as const;

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

export const DEFAULT_LIMITS: EvidenceLimits = { perPage: 100, maxPages: 10, maxTextChars: 65_536 };

const NAME = /^[A-Za-z0-9_.-]{1,100}$/;
const SHA = /^[0-9a-f]{40}$/;

const User = z.object({ login: z.string() }).nullable().optional();
const Label = z.union([z.string(), z.object({ name: z.string() })]);
const App = z.object({ slug: z.string() }).nullable().optional();
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
  author_association: z.string().optional(),
  performed_via_github_app: App,
  closed_at: z.string().nullable().optional(),
  comments: z.number().int().nonnegative().optional(),
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
  body: z.string().nullable().optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
  commits: z.number().int().nonnegative().optional(),
  changed_files: z.number().int().nonnegative().optional(),
});
const CommentSchema = z.object({
  id: z.number().int(),
  user: z.object({ login: z.string(), type: z.string().optional() }).nullable().optional(),
  author_association: z.string().optional(),
  created_at: z.string(),
  updated_at: z.string(),
  body: z.string().nullable().optional(),
  html_url: z.string().optional(),
  issue_url: z.string().optional(),
  performed_via_github_app: App,
});
const PullListSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  state: z.string(),
  draft: z.boolean().optional(),
  merged_at: z.string().nullable().optional(),
  user: User,
  head: z.object({ ref: z.string(), sha: z.string().regex(SHA) }),
  base: z.object({ ref: z.string(), sha: z.string().regex(SHA).optional() }),
  created_at: z.string(),
  updated_at: z.string(),
});
const EventSchema = z.object({
  id: z.number().int().optional(),
  event: z.string(),
  actor: User,
  created_at: z.string(),
  label: z.object({ name: z.string() }).nullable().optional(),
  performed_via_github_app: App,
});
const ReviewCommentSchema = z.object({
  id: z.number().int(),
  user: User,
  path: z.string(),
  line: z.number().int().nullable().optional(),
  commit_id: z.string(),
  created_at: z.string(),
  body: z.string().nullable().optional(),
});
const CommitRefSchema = z.object({ sha: z.string().regex(SHA) });
const ContentsSchema = z.object({
  type: z.string(),
  path: z.string(),
  sha: z.string().regex(SHA),
  size: z.number().int().nonnegative(),
  encoding: z.string().optional(),
  content: z.string().nullable().optional(),
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
  check_runs: z.array(
    z.object({
      id: z.number().int(),
      name: z.string(),
      head_sha: z.string(),
      status: z.string(),
      conclusion: z.string().nullable(),
      started_at: z.string().nullable().optional(),
      completed_at: z.string().nullable().optional(),
      app: z.object({ slug: z.string() }).nullable().optional(),
    }),
  ),
});

const WorkflowRunsSchema = z.object({
  total_count: z.number().int().nonnegative(),
  workflow_runs: z.array(
    z.object({
      id: z.number().int(),
      name: z.string().nullable(),
      head_sha: z.string(),
      status: z.string().nullable(),
      conclusion: z.string().nullable(),
      event: z.string(),
      created_at: z.string(),
    }),
  ),
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
  base: { ref: string; sha: string };
  head: { ref: string; sha: string; repository: string | null };
  body: UntrustedText;
  /** The fields below are null when GitHub did not send them. */
  createdAt: string | null;
  updatedAt: string | null;
  mergedAt: string | null;
  commits: number | null;
  changedFiles: number | null;
}

export type PatchStatus =
  | "included"
  | "truncated"
  | "omitted-budget"
  | "omitted-by-request"
  | "unavailable";

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

export const DEFAULT_PATCH_LIMITS: PatchLimits = {
  perFileMaxChars: 20_000,
  totalMaxChars: 100_000,
};

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
  required: { name: string; conclusion: string | null; satisfied: boolean }[];
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
export const DEFAULT_FILE_LIMITS: FileLimits = { maxBytes: 262_144 };

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
export type FileBytesEvidence =
  | {
      commitSha: string;
      path: string;
      blobSha: string;
      size: number;
      kind: "bytes";
      bytes: Uint8Array;
    }
  | { commitSha: string; path: string; blobSha: string; size: number; kind: "too-large" };

const SAFE_REF = /^[A-Za-z0-9._/-]{1,200}$/;

/** Refuses anything but a plain repository-relative path, before any request is made. */
function safePath(path: string): string[] {
  const bad = () => new GitHubAdapterError("invalid-input", "Invalid file path");
  if (typeof path !== "string" || path.length === 0 || path.length > 1024) throw bad();
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is refused
  if (path.startsWith("/") || path.includes("\\") || /[\u0000-\u001f\u007f]/.test(path))
    throw bad();
  const segments = path.split("/");
  if (segments.some((s) => s === "" || s === "." || s === ".." || s.includes(".."))) throw bad();
  return segments;
}

export interface GitHubEvidence {
  readonly repository: string;
  getIssue(number: number): Promise<IssueEvidence>;
  /** Issues only (pull requests excluded), oldest first; refuses `incomplete` beyond the page limit. */
  listIssues(options?: { state?: "open" | "closed" | "all" }): Promise<IssueEvidence[]>;
  getPullRequest(
    number: number,
    options?: { expectedHeadSha?: string },
  ): Promise<PullRequestEvidence>;
  /**
   * The changed files of a pull request whose head is exactly `headSha`, before and after the
   * read. With `patches`, each file's patch text within the per-file and total budgets.
   */
  listPullRequestFiles(
    number: number,
    headSha: string,
    options?: { patches?: Partial<PatchLimits> | true },
  ): Promise<PullRequestFilesEvidence>;
  /** Reviews; with `commitSha`, only those submitted on that exact commit. */
  listReviews(number: number, options?: { commitSha?: string }): Promise<ReviewEvidence[]>;
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
  listIssueComments(issue: number, options?: { since?: string }): Promise<IssueCommentEvidence[]>;
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
  getFileAtCommit(
    commitSha: string,
    path: string,
    limits?: Partial<FileLimits>,
  ): Promise<FileAtCommitEvidence>;
  /** How commit `head` relates to commit `base` (both full SHAs), as GitHub's compare reports it. */
  compareCommits(base: string, head: string): Promise<CommitComparison>;

  // Page windows (0.6.0): one page as GitHub returned it, for callers with their own paging.
  /** Issues of one page; pull requests are dropped from the page and counted. */
  listIssuesPage(
    options?: PageRequest & {
      state?: "open" | "closed" | "all";
      labels?: readonly string[];
      sort?: "created" | "updated" | "comments";
      direction?: "asc" | "desc";
    },
  ): Promise<PageWindow<IssueEvidence> & { excludedPullRequests: number }>;
  listPullRequestsPage(
    options?: PageRequest & {
      state?: "open" | "closed" | "all";
      sort?: "created" | "updated";
      direction?: "asc" | "desc";
    },
  ): Promise<PageWindow<PullRequestSummary>>;
  listIssueCommentsPage(
    issue: number,
    options?: PageRequest,
  ): Promise<PageWindow<IssueCommentEvidence>>;
  listIssueEventsPage(
    issue: number,
    options?: PageRequest,
  ): Promise<PageWindow<IssueEventEvidence>>;
  listReviewsPage(pullRequest: number, options?: PageRequest): Promise<PageWindow<ReviewEvidence>>;
  /** Inline review comments of a pull request (`pulls/{n}/comments`). */
  listReviewCommentsPage(
    pullRequest: number,
    options?: PageRequest,
  ): Promise<PageWindow<ReviewCommentEvidence>>;
  /** One issue or pull-request comment by id, with the issue number it belongs to. */
  getIssueComment(id: number): Promise<IssueCommentEvidence & { issueNumber: number }>;
  /**
   * The exact bytes of a file at a full 40-hex commit, under the same path and target checks as
   * `getFileAtCommit`. `too-large`: over `maxBytes`, or GitHub sent no inline content.
   */
  getFileBytesAtCommit(
    commitSha: string,
    path: string,
    limits?: Partial<FileLimits>,
  ): Promise<FileBytesEvidence>;
  /**
   * Whether `commitSha` is the head or one of the commits of a pull request. Reads at most
   * `maxCommits` commits (GitHub lists at most 250); a commit beyond them is reported as not
   * belonging, so a caller that needs membership refuses it.
   */
  pullRequestContainsCommit(
    pullRequest: number,
    commitSha: string,
    options?: { maxCommits?: number },
  ): Promise<{ belongs: boolean; isHead: boolean }>;
}

function positive(value: number, what: string): number {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new GitHubAdapterError("invalid-input", `Invalid ${what}`);
  return value;
}

function pageRequest(options: PageRequest | undefined): { page: number; perPage: number } {
  const page = options?.page ?? 1;
  const perPage = options?.perPage ?? 30;
  if (
    !Number.isSafeInteger(page) ||
    page < 1 ||
    !Number.isSafeInteger(perPage) ||
    perPage < 1 ||
    perPage > 100
  )
    throw new GitHubAdapterError("invalid-input", "Invalid page request");
  return { page, perPage };
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is refused
const LABEL = /^[^,\u0000-\u001f]{1,100}$/;

function sha(value: string, what = "commit SHA"): string {
  if (typeof value !== "string" || !SHA.test(value))
    throw new GitHubAdapterError(
      "invalid-input",
      `${what} must be a full 40-character lowercase SHA`,
    );
  return value;
}

function parse<T>(schema: z.ZodType<T>, body: unknown, what: string): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success)
    throw new GitHubAdapterError("malformed-response", `Unexpected GitHub response for ${what}`);
  return parsed.data;
}

export function createGitHubEvidence(options: {
  transport: GitHubTransport;
  repository: RepositoryRef;
  limits?: Partial<EvidenceLimits>;
}): GitHubEvidence {
  const { owner, name } = options.repository;
  if (!NAME.test(owner) || !NAME.test(name))
    throw new GitHubAdapterError("invalid-input", "Invalid repository owner or name");
  const limits: EvidenceLimits = { ...DEFAULT_LIMITS, ...options.limits };
  if (
    !(
      limits.perPage >= 1 &&
      limits.perPage <= 100 &&
      limits.maxPages >= 1 &&
      limits.maxTextChars >= 1
    )
  )
    throw new GitHubAdapterError("invalid-input", "Invalid evidence limits");
  const repository = `${owner}/${name}`;
  const root = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
  const get = (segments: readonly (string | number)[], query?: Record<string, string>) =>
    options.transport.get(
      `${root}/${segments.map((s) => encodeURIComponent(String(s))).join("/")}`,
      query,
    );

  const untrusted = (value: string | null | undefined): UntrustedText => {
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
  async function pages<T>(
    segments: readonly (string | number)[],
    query: Record<string, string>,
    read: (body: unknown) => { items: T[]; total?: number },
  ): Promise<T[]> {
    const all: T[] = [];
    for (let page = 1; page <= limits.maxPages; page++) {
      const { items, total } = read(
        await get(segments, { ...query, per_page: String(limits.perPage), page: String(page) }),
      );
      all.push(...items);
      if (items.length < limits.perPage || (total !== undefined && all.length >= total)) {
        if (total !== undefined && all.length < total)
          throw new GitHubAdapterError(
            "incomplete",
            `GitHub listed ${all.length} of ${total} items`,
          );
        return all;
      }
    }
    throw new GitHubAdapterError(
      "incomplete",
      `More than ${limits.maxPages * limits.perPage} items; refusing a partial listing`,
    );
  }

  const issueEvidence = (i: z.infer<typeof IssueSchema>): IssueEvidence => ({
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
    authorAssociation: i.author_association ?? "",
    performedViaGitHubApp: i.performed_via_github_app?.slug ?? null,
    closedAt: i.closed_at ?? null,
    commentCount: i.comments ?? null,
  });

  const commentEvidence = (c: z.infer<typeof CommentSchema>): IssueCommentEvidence => ({
    id: c.id,
    author: c.user?.login ?? null,
    authorType: c.user?.type ?? null,
    authorAssociation: c.author_association ?? "",
    createdAt: c.created_at,
    updatedAt: c.updated_at,
    body: untrusted(c.body),
    url: c.html_url ?? null,
    performedViaGitHubApp: c.performed_via_github_app?.slug ?? null,
  });

  const pullSummary = (p: z.infer<typeof PullListSchema>): PullRequestSummary => ({
    number: p.number,
    state: p.state,
    draft: p.draft ?? false,
    merged: p.merged_at !== null && p.merged_at !== undefined,
    title: untrusted(p.title),
    author: p.user?.login ?? null,
    headRef: p.head.ref,
    headSha: p.head.sha,
    baseRef: p.base.ref,
    baseSha: p.base.sha ?? null,
    createdAt: p.created_at,
    updatedAt: p.updated_at,
  });

  const reviewEvidence = (r: z.infer<typeof ReviewSchema>): ReviewEvidence => ({
    id: r.id,
    author: r.user?.login ?? null,
    state: r.state,
    commitSha: r.commit_id ?? null,
    submittedAt: r.submitted_at ?? null,
    body: untrusted(r.body),
  });

  /** One page, as GitHub windowed it. */
  async function windowOf<R, T>(
    segments: readonly (string | number)[],
    query: Record<string, string>,
    request: PageRequest | undefined,
    schema: z.ZodType<R[]>,
    what: string,
    map: (r: R) => T,
  ): Promise<PageWindow<T> & { raw: R[] }> {
    const { page, perPage } = pageRequest(request);
    const raw = parse(
      schema,
      await get(segments, { ...query, per_page: String(perPage), page: String(page) }),
      what,
    );
    if (raw.length > perPage)
      throw new GitHubAdapterError(
        "malformed-response",
        `GitHub returned more ${what} than requested`,
      );
    return { items: raw.map(map), page, perPage, hasMore: raw.length === perPage, raw };
  }

  async function fileContents(commitSha: string, path: string, fileLimits: Partial<FileLimits>) {
    sha(commitSha);
    const segments = safePath(path);
    const maxBytes = fileLimits.maxBytes ?? DEFAULT_FILE_LIMITS.maxBytes;
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
      throw new GitHubAdapterError("invalid-input", "Invalid file limits");
    const body = await get(["contents", ...segments], { ref: commitSha });
    if (Array.isArray(body))
      throw new GitHubAdapterError("wrong-target", "The path is a directory, not a file", {
        reason: "not-a-file",
      });
    const f = parse(ContentsSchema, body, "file contents");
    if (f.type !== "file")
      throw new GitHubAdapterError("wrong-target", `The path is a ${f.type}, not a file`, {
        reason: "not-a-file",
      });
    // A symlinked directory on the way would make GitHub answer for a different path.
    if (f.path !== path)
      throw new GitHubAdapterError("wrong-target", "GitHub answered for another path", {
        reason: "other-path",
      });
    const base = { commitSha, path, blobSha: f.sha, size: f.size };
    if (f.size > maxBytes || f.encoding !== "base64" || !f.content)
      return { base, bytes: null, tooLarge: true as const };
    const bytes = Buffer.from(f.content.replace(/\s/g, ""), "base64");
    if (bytes.length !== f.size)
      throw new GitHubAdapterError("malformed-response", "File content does not match its size");
    return { base, bytes, tooLarge: false as const };
  }

  async function getPullRequest(
    number: number,
    opts: { expectedHeadSha?: string } = {},
  ): Promise<PullRequestEvidence> {
    if (opts.expectedHeadSha !== undefined) sha(opts.expectedHeadSha, "expectedHeadSha");
    const p = parse(
      PullSchema,
      await get(["pulls", positive(number, "pull request number")]),
      "a pull request",
    );
    const evidence: PullRequestEvidence = {
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
      body: untrusted(p.body),
      createdAt: p.created_at ?? null,
      updatedAt: p.updated_at ?? null,
      mergedAt: p.merged_at ?? null,
      commits: p.commits ?? null,
      changedFiles: p.changed_files ?? null,
    };
    if (opts.expectedHeadSha !== undefined && evidence.head.sha !== opts.expectedHeadSha)
      throw new GitHubAdapterError(
        "stale",
        `The pull request head is ${evidence.head.sha}, not ${opts.expectedHeadSha}`,
        {
          expected: opts.expectedHeadSha,
          actual: evidence.head.sha,
        },
      );
    return evidence;
  }

  return Object.freeze({
    repository,

    async getIssue(number: number) {
      return issueEvidence(
        parse(IssueSchema, await get(["issues", positive(number, "issue number")]), "an issue"),
      );
    },

    async listIssues(opts: { state?: "open" | "closed" | "all" } = {}) {
      const all = await pages(
        ["issues"],
        { state: opts.state ?? "all", sort: "created", direction: "asc" },
        (body) => ({ items: parse(z.array(IssueSchema), body, "an issue listing") }),
      );
      return all.map(issueEvidence).filter((i) => !i.isPullRequest);
    },

    getPullRequest,

    async listPullRequestFiles(
      number: number,
      headSha: string,
      opts: { patches?: Partial<PatchLimits> | true } = {},
    ) {
      sha(headSha, "headSha");
      const patchLimits =
        opts.patches === undefined
          ? null
          : { ...DEFAULT_PATCH_LIMITS, ...(opts.patches === true ? {} : opts.patches) };
      if (
        patchLimits &&
        !(
          Number.isSafeInteger(patchLimits.perFileMaxChars) &&
          Number.isSafeInteger(patchLimits.totalMaxChars) &&
          patchLimits.perFileMaxChars >= 1 &&
          patchLimits.totalMaxChars >= 1
        )
      )
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
        files: files.map((f): ChangedFile => {
          let patchStatus: PatchStatus = "unavailable";
          let patch: UntrustedText | null = null;
          if (f.patch !== undefined) {
            if (!patchLimits) patchStatus = "omitted-by-request";
            else if (budget <= 0) patchStatus = "omitted-budget";
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

    async listReviews(number: number, opts: { commitSha?: string } = {}) {
      if (opts.commitSha !== undefined) sha(opts.commitSha, "commitSha");
      const reviews = await pages(
        ["pulls", positive(number, "pull request number"), "reviews"],
        {},
        (body) => ({ items: parse(z.array(ReviewSchema), body, "reviews") }),
      );
      return reviews
        .map(reviewEvidence)
        .filter((r) => opts.commitSha === undefined || r.commitSha === opts.commitSha);
    },

    async getChecks(commit: string, required: readonly string[] = []) {
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
        const success = matching.find(
          (c) => c.status === "completed" && c.conclusion === "success",
        );
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

    async listWorkflowRuns(commit: string) {
      sha(commit);
      const runs = await pages(["actions", "runs"], { head_sha: commit }, (body) => {
        const page = parse(WorkflowRunsSchema, body, "workflow runs");
        return { items: page.workflow_runs, total: page.total_count };
      });
      if (runs.some((r) => r.head_sha !== commit))
        throw new GitHubAdapterError(
          "malformed-response",
          "A workflow run belongs to another commit",
        );
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

    async listIssueComments(number: number, opts: { since?: string } = {}) {
      if (opts.since !== undefined && Number.isNaN(Date.parse(opts.since)))
        throw new GitHubAdapterError("invalid-input", "since must be an ISO 8601 timestamp");
      const comments = await pages(
        ["issues", positive(number, "issue number"), "comments"],
        opts.since === undefined ? {} : { since: opts.since },
        (body) => ({ items: parse(z.array(CommentSchema), body, "issue comments") }),
      );
      return comments.map(commentEvidence);
    },

    async listPullRequests(opts: { state?: "open" | "closed" | "all"; base?: string } = {}) {
      const state = opts.state ?? "open";
      if (state !== "open" && state !== "closed" && state !== "all")
        throw new GitHubAdapterError("invalid-input", "Invalid pull request state");
      if (
        opts.base !== undefined &&
        (!SAFE_REF.test(opts.base) ||
          opts.base.includes("..") ||
          opts.base.includes("//") ||
          /^[-/]|[/.]$/.test(opts.base))
      )
        throw new GitHubAdapterError("invalid-input", "Invalid base ref name");
      const pulls = await pages(
        ["pulls"],
        {
          state,
          sort: "created",
          direction: "desc",
          ...(opts.base === undefined ? {} : { base: opts.base }),
        },
        (body) => ({ items: parse(z.array(PullListSchema), body, "a pull request listing") }),
      );
      return pulls.map(pullSummary);
    },

    async getFileAtCommit(commitSha: string, path: string, fileLimits: Partial<FileLimits> = {}) {
      const { base, bytes, tooLarge } = await fileContents(commitSha, path, fileLimits);
      if (tooLarge) return { ...base, kind: "too-large" as const };
      if (bytes.includes(0)) return { ...base, kind: "binary" as const };
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        return { ...base, kind: "binary" as const };
      }
      return { ...base, kind: "text" as const, text: untrusted(text) };
    },

    async compareCommits(baseSha: string, headSha: string) {
      sha(baseSha, "base");
      sha(headSha, "head");
      const c = parse(
        CompareSchema,
        await get(["compare", `${baseSha}...${headSha}`]),
        "a commit comparison",
      );
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

    async listIssuesPage(
      opts: PageRequest & {
        state?: "open" | "closed" | "all";
        labels?: readonly string[];
        sort?: "created" | "updated" | "comments";
        direction?: "asc" | "desc";
      } = {},
    ) {
      const state = opts.state ?? "open";
      if (!["open", "closed", "all"].includes(state))
        throw new GitHubAdapterError("invalid-input", "Invalid issue state");
      if (opts.sort !== undefined && !["created", "updated", "comments"].includes(opts.sort))
        throw new GitHubAdapterError("invalid-input", "Invalid sort");
      if (opts.direction !== undefined && !["asc", "desc"].includes(opts.direction))
        throw new GitHubAdapterError("invalid-input", "Invalid direction");
      if (opts.labels && (opts.labels.length > 20 || opts.labels.some((l) => !LABEL.test(l))))
        throw new GitHubAdapterError("invalid-input", "Invalid labels");
      const query: Record<string, string> = {
        state,
        sort: opts.sort ?? "created",
        direction: opts.direction ?? "desc",
      };
      if (opts.labels?.length) query.labels = opts.labels.join(",");
      const w = await windowOf(
        ["issues"],
        query,
        opts,
        z.array(IssueSchema),
        "issues",
        issueEvidence,
      );
      const items = w.items.filter((i) => !i.isPullRequest);
      return {
        items,
        page: w.page,
        perPage: w.perPage,
        hasMore: w.hasMore,
        excludedPullRequests: w.items.length - items.length,
      };
    },

    async listPullRequestsPage(
      opts: PageRequest & {
        state?: "open" | "closed" | "all";
        sort?: "created" | "updated";
        direction?: "asc" | "desc";
      } = {},
    ) {
      const state = opts.state ?? "open";
      if (!["open", "closed", "all"].includes(state))
        throw new GitHubAdapterError("invalid-input", "Invalid pull request state");
      if (opts.sort !== undefined && !["created", "updated"].includes(opts.sort))
        throw new GitHubAdapterError("invalid-input", "Invalid sort");
      if (opts.direction !== undefined && !["asc", "desc"].includes(opts.direction))
        throw new GitHubAdapterError("invalid-input", "Invalid direction");
      const { raw: _raw, ...w } = await windowOf(
        ["pulls"],
        { state, sort: opts.sort ?? "created", direction: opts.direction ?? "desc" },
        opts,
        z.array(PullListSchema),
        "pull requests",
        pullSummary,
      );
      return w;
    },

    async listIssueCommentsPage(number: number, opts: PageRequest = {}) {
      const { raw: _raw, ...w } = await windowOf(
        ["issues", positive(number, "issue number"), "comments"],
        {},
        opts,
        z.array(CommentSchema),
        "issue comments",
        commentEvidence,
      );
      return w;
    },

    async listIssueEventsPage(number: number, opts: PageRequest = {}) {
      const { raw: _raw, ...w } = await windowOf(
        ["issues", positive(number, "issue number"), "events"],
        {},
        opts,
        z.array(EventSchema),
        "issue events",
        (e): IssueEventEvidence => ({
          event: e.event,
          actor: e.actor?.login ?? null,
          label: e.label?.name ?? null,
          performedViaGitHubApp: e.performed_via_github_app?.slug ?? null,
          createdAt: e.created_at,
        }),
      );
      return w;
    },

    async listReviewsPage(number: number, opts: PageRequest = {}) {
      const { raw: _raw, ...w } = await windowOf(
        ["pulls", positive(number, "pull request number"), "reviews"],
        {},
        opts,
        z.array(ReviewSchema),
        "reviews",
        reviewEvidence,
      );
      return w;
    },

    async listReviewCommentsPage(number: number, opts: PageRequest = {}) {
      const { raw: _raw, ...w } = await windowOf(
        ["pulls", positive(number, "pull request number"), "comments"],
        {},
        opts,
        z.array(ReviewCommentSchema),
        "review comments",
        (c): ReviewCommentEvidence => ({
          id: c.id,
          author: c.user?.login ?? null,
          path: c.path,
          line: c.line ?? null,
          commitSha: c.commit_id,
          createdAt: c.created_at,
          body: untrusted(c.body),
        }),
      );
      return w;
    },

    async getIssueComment(id: number) {
      const c = parse(
        CommentSchema,
        await get(["issues", "comments", positive(id, "comment id")]),
        "an issue comment",
      );
      // The comment's own issue URL must be under this repository; anything else is not its comment.
      const m = /\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)$/.exec(c.issue_url ?? "");
      if (!m || `${m[1]}/${m[2]}`.toLowerCase() !== repository.toLowerCase())
        throw new GitHubAdapterError(
          "wrong-target",
          "The comment does not belong to this repository",
        );
      return { ...commentEvidence(c), issueNumber: Number(m[3]) };
    },

    async getFileBytesAtCommit(
      commitSha: string,
      path: string,
      fileLimits: Partial<FileLimits> = {},
    ) {
      const { base, bytes, tooLarge } = await fileContents(commitSha, path, fileLimits);
      if (tooLarge) return { ...base, kind: "too-large" as const };
      return { ...base, kind: "bytes" as const, bytes: new Uint8Array(bytes) };
    },

    async pullRequestContainsCommit(
      number: number,
      commitSha: string,
      opts: { maxCommits?: number } = {},
    ) {
      sha(commitSha);
      const maxCommits = opts.maxCommits ?? 250;
      if (!Number.isSafeInteger(maxCommits) || maxCommits < 1)
        throw new GitHubAdapterError("invalid-input", "Invalid maxCommits");
      const pr = await getPullRequest(number);
      if (pr.head.sha === commitSha) return { belongs: true, isHead: true };
      const pageCount = Math.ceil(maxCommits / 100);
      for (let page = 1; page <= pageCount; page++) {
        const commits = parse(
          z.array(CommitRefSchema),
          await get(["pulls", number, "commits"], { per_page: "100", page: String(page) }),
          "pull request commits",
        );
        if (commits.some((c) => c.sha === commitSha)) return { belongs: true, isHead: false };
        if (commits.length < 100) return { belongs: false, isHead: false };
      }
      return { belongs: false, isHead: false };
    },
  });
}
