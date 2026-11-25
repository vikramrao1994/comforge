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
});
const FileSchema = z.object({
  filename: z.string(),
  previous_filename: z.string().optional(),
  status: z.string(),
  additions: z.number().int(),
  deletions: z.number().int(),
  changes: z.number().int(),
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
      completed_at: z.string().nullable().optional(),
      app: z.object({ slug: z.string() }).nullable().optional(),
    }),
  ),
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
  required: { name: string; conclusion: string | null; satisfied: boolean }[];
  /** Every required check has a successful run on exactly `sha`. False when nothing is required. */
  ok: boolean;
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
  /** The changed files of a pull request whose head is exactly `headSha`, before and after the read. */
  listPullRequestFiles(number: number, headSha: string): Promise<PullRequestFilesEvidence>;
  /** Reviews; with `commitSha`, only those submitted on that exact commit. */
  listReviews(number: number, options?: { commitSha?: string }): Promise<ReviewEvidence[]>;
  /** Check runs GitHub recorded for exactly `sha`, judged against `required` check names. */
  getChecks(sha: string, required?: readonly string[]): Promise<CheckEvidence>;
}

function positive(value: number, what: string): number {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new GitHubAdapterError("invalid-input", `Invalid ${what}`);
  return value;
}

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
  });

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

    async listPullRequestFiles(number: number, headSha: string) {
      sha(headSha, "headSha");
      await getPullRequest(number, { expectedHeadSha: headSha });
      const files = await pages(["pulls", number, "files"], {}, (body) => ({
        items: parse(z.array(FileSchema), body, "pull request files"),
      }));
      // The listing is of whatever the head was while it was read; prove it did not move.
      await getPullRequest(number, { expectedHeadSha: headSha });
      return {
        repository,
        number,
        headSha,
        files: files.map((f) => ({
          path: f.filename,
          previousPath: f.previous_filename ?? null,
          status: f.status,
          additions: f.additions,
          deletions: f.deletions,
          changes: f.changes,
        })),
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
        .map((r) => ({
          id: r.id,
          author: r.user?.login ?? null,
          state: r.state,
          commitSha: r.commit_id ?? null,
          submittedAt: r.submitted_at ?? null,
          body: untrusted(r.body),
        }))
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
  });
}
