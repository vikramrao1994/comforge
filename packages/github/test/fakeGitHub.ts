/** biome-ignore-all lint/suspicious/noAssignInExpressions: a regex routing table reads clearest as match-and-bind conditions */
import type { OperationLedger, OperationRecord } from "../src/index.ts";

/**
 * A stateful, synthetic GitHub for writer tests: issues, comments, pull requests, reviews and
 * branch refs of one repository, behind a `fetch` implementation. Faults are queued per write
 * and say whether the write is applied before the failure, which is what makes an outcome
 * indeterminate on the real service.
 */

export const ORIGIN = "https://api.github.com";
export const OWNER = "acme";
export const REPO = "widgets";
export const ROOT = `/repos/${OWNER}/${REPO}`;
export const TOKEN = "ghs_FAKEtokenFAKEtokenFAKEtoken0123";
export const BOT = "acme-writer[bot]";

export type Fault =
  | "network-before" // nothing applied, no answer
  | "network-after" // applied, answer lost
  | "500-after" // applied, then a 502
  | "malformed-after" // applied, 2xx non-JSON
  | "429" // refused with retry-after
  | "403" // refused
  | "422"; // refused

interface Issue {
  number: number;
  title: string;
  body: string | null;
  state: string;
  state_reason: string | null;
  locked: boolean;
  labels: { name: string }[];
  assignees: { login: string }[];
  pull_request?: { url: string };
  user: { login: string };
  html_url: string;
  updated_at: string;
}
interface Comment {
  id: number;
  issue: number;
  body: string;
  user: { login: string };
  updated_at: string;
}
interface Pull {
  number: number;
  title: string;
  body: string;
  state: string;
  merged_at: string | null;
  updated_at: string;
  head: { ref: string; sha: string; repo: { full_name: string } };
  base: { ref: string; sha: string; repo: { full_name: string } };
  /** Created as a draft (pull.create with draft: true); tests may clear it. */
  draft?: boolean;
  /** The login that opened the pull request; defaults to the writer's own identity. */
  author?: string;
}
interface Review {
  id: number;
  pull: number;
  commit_id: string;
  state: string;
  body: string;
  user: { login: string };
}

export interface FakeOptions {
  /** Labels/assignees are silently dropped, as GitHub does for callers without push access. */
  dropLabels?: boolean;
  /** The created pull request reports another head SHA (the branch moved during the create). */
  pullHeadOverride?: string;
  /** Repository identity served; defaults to the exported OWNER/REPO. */
  owner?: string;
  repo?: string;
  /** The bearer token this repository accepts when `requireToken` is set; defaults to TOKEN. */
  token?: string;
  /** Refuse a request with another bearer (401) and a path under another repository (404). */
  requireToken?: boolean;
}

export function createFakeGitHub(opts: FakeOptions = {}) {
  const owner = opts.owner ?? OWNER;
  const repo = opts.repo ?? REPO;
  const root = `/repos/${owner}/${repo}`;
  const rootRe = root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const token = opts.token ?? TOKEN;
  /** Requests refused by `requireToken`; never counted among `requests` or `writes`. */
  const refused: { method: string; path: string; status: number }[] = [];
  let next = 100;
  let tick = 0;
  const stamp = () => `2026-01-01T00:00:${String(tick++ % 60).padStart(2, "0")}Z`;
  const issues = new Map<number, Issue>();
  const comments = new Map<number, Comment>();
  const pulls = new Map<number, Pull>();
  const reviews = new Map<number, Review>();
  const refs = new Map<string, string>();
  /** File contents served by the contents endpoint, keyed `<ref>:<path>`. */
  const files = new Map<string, string>();
  const faults: Fault[] = [];
  const requests: {
    method: string;
    path: string;
    auth: string | null;
    redirect?: string;
    body?: unknown;
  }[] = [];
  const beforeWrite: (() => void)[] = [];
  const afterWrite: (() => void)[] = [];
  /** Consulted before every GET; the first Response returned replaces GitHub's answer. */
  const readOverrides: ((path: string) => Response | Promise<Response> | undefined)[] = [];
  const author = { login: BOT };

  const issueJson = (i: Issue) => ({ ...i, created_at: "2026-01-01T00:00:00Z" });
  const commentJson = (c: Comment) => ({
    id: c.id,
    body: c.body,
    user: c.user,
    updated_at: c.updated_at,
    created_at: "2026-01-01T00:00:00Z",
    author_association: "NONE",
    html_url: `https://github.com/${owner}/${repo}/issues/${c.issue}#issuecomment-${c.id}`,
    issue_url: `${ORIGIN}${root}/issues/${c.issue}`,
  });
  const pullJson = (p: Pull) => ({
    ...p,
    html_url: `https://github.com/${owner}/${repo}/pull/${p.number}`,
    user: p.author ? { login: p.author } : author,
    draft: p.draft === true,
    created_at: "2026-01-01T00:00:00Z",
  });

  function seedIssue(partial: Partial<Issue> = {}): Issue {
    const number = partial.number ?? next++;
    const issue: Issue = {
      number,
      title: "Seed",
      body: "seed body",
      state: "open",
      state_reason: null,
      locked: false,
      labels: [],
      assignees: [],
      user: { login: "owner" },
      html_url: `https://github.com/${owner}/${repo}/issues/${number}`,
      updated_at: "2025-12-31T00:00:00Z",
      ...partial,
    };
    issues.set(number, issue);
    return issue;
  }
  function seedPull(head: string, sha: string, partial: Partial<Pull> = {}): Pull {
    const number = partial.number ?? next++;
    refs.set(head, sha);
    const pull: Pull = {
      number,
      title: "Seed PR",
      body: "",
      state: "open",
      merged_at: null,
      updated_at: "2025-12-31T00:00:00Z",
      head: { ref: head, sha, repo: { full_name: `${owner}/${repo}` } },
      base: { ref: "main", sha: "b".repeat(40), repo: { full_name: `${owner}/${repo}` } },
      ...partial,
    };
    pulls.set(number, pull);
    seedIssue({ number, pull_request: { url: "x" }, title: pull.title });
    return pull;
  }
  function seedComment(issue: number, body: string, login = BOT): Comment {
    const c: Comment = {
      id: next++,
      issue,
      body,
      user: { login },
      updated_at: "2025-12-31T00:00:00Z",
    };
    comments.set(c.id, c);
    return c;
  }

  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...headers },
    });
  const page = <T>(items: T[], q: URLSearchParams) => {
    const per = Number(q.get("per_page") ?? 30);
    const p = Number(q.get("page") ?? 1);
    return items.slice((p - 1) * per, p * per);
  };

  function applyWrite(
    method: string,
    path: string,
    body: Record<string, unknown>,
  ): { status: number; json: unknown } {
    let m: RegExpMatchArray | null;
    if (method === "POST" && path === `${root}/issues`) {
      const drop = opts.dropLabels === true;
      const issue = seedIssue({
        title: body.title as string,
        body: body.body as string,
        labels: drop ? [] : ((body.labels as string[] | undefined) ?? []).map((name) => ({ name })),
        assignees: drop
          ? []
          : ((body.assignees as string[] | undefined) ?? []).map((login) => ({ login })),
        user: author,
        updated_at: stamp(),
      });
      return { status: 201, json: issueJson(issue) };
    }
    if (method === "POST" && (m = path.match(/\/issues\/(\d+)\/comments$/))) {
      const c = seedComment(Number(m[1]), body.body as string);
      return { status: 201, json: commentJson(c) };
    }
    if (method === "POST" && (m = path.match(/\/pulls\/(\d+)\/reviews$/))) {
      const states = {
        COMMENT: "COMMENTED",
        APPROVE: "APPROVED",
        REQUEST_CHANGES: "CHANGES_REQUESTED",
      } as const;
      const r: Review = {
        id: next++,
        pull: Number(m[1]),
        commit_id: (body.commit_id as string) ?? pulls.get(Number(m[1]))?.head.sha ?? "",
        state: states[body.event as keyof typeof states],
        body: body.body as string,
        user: author,
      };
      reviews.set(r.id, r);
      return { status: 200, json: { ...r, html_url: "https://github.com/r" } };
    }
    if (method === "POST" && path === `${root}/pulls`) {
      const head = body.head as string;
      const sha = opts.pullHeadOverride ?? refs.get(head) ?? "0".repeat(40);
      const pull = seedPull(head, sha, {
        title: body.title as string,
        body: body.body as string,
        draft: body.draft === true,
      });
      pull.base.ref = body.base as string;
      return { status: 201, json: pullJson(pull) };
    }
    if (method === "PATCH" && (m = path.match(/\/pulls\/(\d+)$/))) {
      const pull = pulls.get(Number(m[1]));
      if (!pull) return { status: 404, json: { message: "Not Found" } };
      if (body.body !== undefined) pull.body = body.body as string;
      pull.updated_at = stamp();
      return { status: 200, json: pullJson(pull) };
    }
    if (method === "PATCH" && (m = path.match(/\/issues\/(\d+)$/))) {
      const issue = issues.get(Number(m[1]));
      if (!issue) return { status: 404, json: { message: "Not Found" } };
      if (body.title !== undefined) issue.title = body.title as string;
      if (body.body !== undefined) issue.body = body.body as string;
      if (body.state !== undefined) issue.state = body.state as string;
      if (body.state_reason !== undefined) issue.state_reason = body.state_reason as string;
      if (body.labels !== undefined)
        issue.labels = (body.labels as string[]).map((name) => ({ name }));
      issue.updated_at = stamp();
      return { status: 200, json: issueJson(issue) };
    }
    if (method === "PATCH" && (m = path.match(/\/issues\/comments\/(\d+)$/))) {
      const c = comments.get(Number(m[1]));
      if (!c) return { status: 404, json: { message: "Not Found" } };
      c.body = body.body as string;
      c.updated_at = stamp();
      return { status: 200, json: commentJson(c) };
    }
    return { status: 404, json: { message: "no write route" } };
  }

  const under = (path: string, re: RegExp) => path.match(new RegExp(`^${rootRe}${re.source}`));

  function read(path: string, q: URLSearchParams): Response {
    let m: RegExpMatchArray | null;
    if ((m = under(path, /\/issues\/comments\/(\d+)$/))) {
      const c = comments.get(Number(m[1]));
      return c ? json(commentJson(c)) : json({ message: "Not Found" }, 404);
    }
    if ((m = under(path, /\/issues\/(\d+)\/comments$/))) {
      const since = q.get("since");
      const all = [...comments.values()].filter(
        (c) => c.issue === Number(m?.[1]) && (!since || c.updated_at >= since || true),
      );
      return json(page(all.map(commentJson), q));
    }
    if ((m = under(path, /\/issues\/(\d+)$/))) {
      const i = issues.get(Number(m[1]));
      return i ? json(issueJson(i)) : json({ message: "Not Found" }, 404);
    }
    if (path === `${root}/issues`) {
      const all = [...issues.values()].sort((a, b) => b.number - a.number);
      return json(page(all.map(issueJson), q));
    }
    if ((m = under(path, /\/pulls\/(\d+)\/reviews\/(\d+)$/))) {
      const r = reviews.get(Number(m[2]));
      return r && r.pull === Number(m[1]) ? json(r) : json({ message: "Not Found" }, 404);
    }
    if ((m = under(path, /\/pulls\/(\d+)\/reviews$/)))
      return json(
        page(
          [...reviews.values()].filter((r) => r.pull === Number(m?.[1])),
          q,
        ),
      );
    if ((m = under(path, /\/pulls\/(\d+)$/))) {
      const p = pulls.get(Number(m[1]));
      return p ? json(pullJson(p)) : json({ message: "Not Found" }, 404);
    }
    if (path === `${root}/pulls`) {
      const head = q.get("head")?.split(":")[1];
      const state = q.get("state") ?? "open";
      const all = [...pulls.values()].filter(
        (p) =>
          (!head || p.head.ref === head) &&
          (!q.get("base") || p.base.ref === q.get("base")) &&
          (state === "all" || p.state === state),
      );
      return json(page(all.map(pullJson), q));
    }
    if ((m = under(path, /\/contents\/(.+)$/))) {
      const file = decodeURIComponent(m[1] as string);
      const content = files.get(`${q.get("ref")}:${file}`);
      if (content === undefined) return json({ message: "Not Found" }, 404);
      const bytes = Buffer.from(content);
      return json({
        type: "file",
        path: file,
        sha: "c".repeat(40),
        size: bytes.length,
        encoding: "base64",
        content: bytes.toString("base64"),
      });
    }
    if ((m = under(path, /\/git\/ref\/heads\/(.+)$/))) {
      const sha = refs.get(m[1] as string);
      return sha
        ? json({ ref: `refs/heads/${m[1]}`, object: { sha, type: "commit" } })
        : json({ message: "Not Found" }, 404);
    }
    return json({ message: `no route ${path}` }, 404);
  }

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = init?.body
      ? (JSON.parse(String(init.body)) as Record<string, unknown>)
      : undefined;
    if (opts.requireToken) {
      const bearer = headers.Authorization ?? headers.authorization ?? "";
      const foreign = url.pathname.startsWith("/repos/") && !url.pathname.startsWith(`${root}/`);
      if (url.pathname !== "/user" && foreign) {
        refused.push({ method, path: url.pathname, status: 404 });
        return json({ message: "Not Found" }, 404);
      }
      if (bearer !== `Bearer ${token}`) {
        refused.push({ method, path: url.pathname, status: 401 });
        return json({ message: "Bad credentials" }, 401);
      }
    }
    requests.push({
      method,
      path: url.pathname,
      auth: headers.Authorization ?? null,
      redirect: init?.redirect,
      body,
    });
    if (url.origin !== ORIGIN) throw new Error("unexpected origin");
    if (method === "GET") {
      for (const override of readOverrides) {
        const replaced = override(url.pathname);
        if (replaced) return replaced;
      }
      return read(url.pathname, url.searchParams);
    }
    for (const hook of beforeWrite.splice(0)) hook();
    const fault = faults.shift();
    if (fault === "network-before") throw new TypeError("fetch failed");
    if (fault === "429")
      return json({ message: "secondary rate limit" }, 429, { "retry-after": "30" });
    if (fault === "403") return json({ message: "Resource not accessible by integration" }, 403);
    if (fault === "422") return json({ message: "Validation Failed" }, 422);
    const applied = applyWrite(method, url.pathname, body ?? {});
    for (const hook of afterWrite.splice(0)) hook();
    if (fault === "network-after") throw new TypeError("fetch failed");
    if (fault === "500-after") return json({ message: "Bad gateway" }, 502);
    if (fault === "malformed-after") return new Response("<html>ok</html>", { status: 201 });
    return json(applied.json, applied.status);
  }) as typeof fetch;

  return {
    fetchImpl,
    issues,
    comments,
    pulls,
    reviews,
    refs,
    files,
    faults,
    requests,
    refused,
    beforeWrite,
    afterWrite,
    readOverrides,
    seedIssue,
    seedPull,
    seedComment,
    writes: () => requests.filter((r) => r.method !== "GET"),
  };
}

/**
 * An atomic in-memory ledger: what a durable consumer store must provide, within one process.
 * Two writers sharing one instance model two processes sharing one database.
 */
export function createMemoryLedger() {
  const records = new Map<string, OperationRecord>();
  let failNext: "get" | "create" | "replace" | null = null;
  const ledger: OperationLedger & {
    records: typeof records;
    failOn(op: "get" | "create" | "replace"): void;
  } = {
    records,
    failOn(op) {
      failNext = op;
    },
    async get(id) {
      if (failNext === "get") {
        failNext = null;
        throw new Error("disk unavailable");
      }
      const r = records.get(id);
      return r ? structuredClone(r) : null;
    },
    async create(record) {
      if (failNext === "create") {
        failNext = null;
        throw new Error("disk unavailable");
      }
      if (records.has(record.operationId)) return false;
      records.set(record.operationId, structuredClone(record));
      return true;
    },
    async replace(id, expectedVersion, next) {
      if (failNext === "replace") {
        failNext = null;
        throw new Error("disk unavailable");
      }
      const current = records.get(id);
      if (!current || current.version !== expectedVersion) return false;
      records.set(id, structuredClone(next));
      return true;
    },
  };
  return ledger;
}
