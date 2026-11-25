import {
  type AuthorizationDecision,
  createGitHubWriter,
  GitHubAdapterError,
  type OperationDescriptor,
  type OperationLedger,
  type OperationRecord,
} from "@comforge/github";

/**
 * The opt-in writer against a synthetic GitHub (a `fetch` over in-memory state) and an
 * in-memory ledger. A real consumer passes its own durable ledger (a database table with an
 * atomic insert and a version-checked update), its own policy as `authorize`, and its token.
 */

type Check = { id: string; pass: boolean };

const ROOT = "/repos/acme/widgets";
const HEAD = "1".repeat(40);
const BOT = "acme-bot[bot]";

/** Atomic within one process only: enough for an example, never for several processes. */
function memoryLedger(): OperationLedger {
  const records = new Map<string, OperationRecord>();
  return {
    async get(id) {
      const r = records.get(id);
      return r ? structuredClone(r) : null;
    },
    async create(record) {
      if (records.has(record.operationId)) return false;
      records.set(record.operationId, structuredClone(record));
      return true;
    },
    async replace(id, version, next) {
      if (records.get(id)?.version !== version) return false;
      records.set(id, structuredClone(next));
      return true;
    },
  };
}

function syntheticGitHub() {
  let next = 10;
  const stamp = "2026-01-01T00:00:00Z";
  const issues = new Map<number, Record<string, unknown>>();
  const comments = new Map<number, Record<string, unknown>>();
  const reviews = new Map<number, Record<string, unknown>>();
  const pulls = new Map<number, Record<string, unknown>>();
  const refs = new Map<string, string>([["feature", HEAD], ["sorting", HEAD], ["main", "b".repeat(40)]]);
  let dropNextAnswer = false;
  let writes = 0;
  const pull = (number: number, head: string, body: string, title = "Sorting") => ({
    number,
    title,
    body,
    state: "open",
    html_url: `https://github.com/acme/widgets/pull/${number}`,
    head: { ref: head, sha: refs.get(head), repo: { full_name: "acme/widgets" } },
    base: { ref: "main", sha: "b".repeat(40), repo: { full_name: "acme/widgets" } },
    user: { login: BOT },
  });
  const issue = (number: number, fields: Record<string, unknown>) => {
    const value = { number, title: "", body: "", state: "open", locked: false, labels: [], html_url: `https://github.com/acme/widgets/issues/${number}`, updated_at: stamp, user: { login: BOT }, ...fields };
    issues.set(number, value);
    return value;
  };
  issue(1, { title: "Existing", body: "Old text", user: { login: "owner" } });
  pulls.set(7, pull(7, "feature", ""));
  issue(7, { title: "Sorting", pull_request: {} });
  const comment = (id: number, n: number, body: string) => ({
    id,
    body,
    html_url: `https://github.com/acme/widgets/issues/${n}#issuecomment-${id}`,
    issue_url: `https://api.github.com${ROOT}/issues/${n}`,
    updated_at: stamp,
    user: { login: BOT },
  });
  comments.set(5, comment(5, 1, "First draft"));

  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const p = url.pathname;
    const method = init?.method ?? "GET";
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    let m: RegExpMatchArray | null;
    if (method === "GET") {
      if ((m = p.match(/\/git\/ref\/heads\/(.+)$/))) return json({ ref: m[1], object: { sha: refs.get(m[1] as string), type: "commit" } });
      if ((m = p.match(/\/issues\/comments\/(\d+)$/))) return json(comments.get(Number(m[1])));
      if ((m = p.match(/\/issues\/(\d+)\/comments$/))) return json([...comments.values()].filter((c) => String(c.issue_url).endsWith(`/issues/${m?.[1]}`)));
      if ((m = p.match(/\/issues\/(\d+)$/))) return json(issues.get(Number(m[1])));
      if (p === `${ROOT}/issues`) return json([...issues.values()]);
      if ((m = p.match(/\/pulls\/(\d+)\/reviews\/(\d+)$/))) return json(reviews.get(Number(m[2])));
      if ((m = p.match(/\/pulls\/(\d+)\/reviews$/))) return json([...reviews.values()]);
      if ((m = p.match(/\/pulls\/(\d+)$/))) return json(pulls.get(Number(m[1])));
      if (p === `${ROOT}/pulls`)
        return json([...pulls.values()].filter((x) => (x as { head: { ref: string } }).head.ref === url.searchParams.get("head")?.split(":")[1] && x.state === "open"));
      return json({ message: "Not Found" }, 404);
    }
    writes += 1;
    let answer: unknown;
    if (p === `${ROOT}/issues`) answer = issue(next++, { title: body.title, body: body.body, labels: (body.labels as string[] | undefined)?.map((name) => ({ name })) ?? [] });
    else if ((m = p.match(/\/issues\/(\d+)\/comments$/))) {
      const c = comment(next++, Number(m[1]), body.body as string);
      comments.set(c.id as number, c);
      answer = c;
    } else if ((m = p.match(/\/pulls\/(\d+)\/reviews$/))) {
      const r = { id: next++, commit_id: body.commit_id, state: { COMMENT: "COMMENTED", APPROVE: "APPROVED", REQUEST_CHANGES: "CHANGES_REQUESTED" }[body.event as "COMMENT"], body: body.body, user: { login: BOT } };
      reviews.set(r.id, r);
      answer = r;
    } else if (p === `${ROOT}/pulls`) {
      const created = pull(next++, body.head as string, body.body as string, body.title as string);
      pulls.set(created.number, created);
      answer = created;
    } else if ((m = p.match(/\/issues\/comments\/(\d+)$/))) {
      const c = comments.get(Number(m[1])) as Record<string, unknown>;
      Object.assign(c, { body: body.body, updated_at: "2026-01-02T00:00:00Z" });
      answer = c;
    } else if ((m = p.match(/\/issues\/(\d+)$/))) {
      const i = issues.get(Number(m[1])) as Record<string, unknown>;
      Object.assign(i, body, { updated_at: "2026-01-02T00:00:00Z" });
      answer = i;
    }
    if (dropNextAnswer) {
      dropNextAnswer = false;
      throw new TypeError("fetch failed"); // the write happened; its answer is lost
    }
    return json(answer, 201);
  }) as typeof fetch;
  return {
    fetchImpl,
    writes: () => writes,
    loseNextAnswer: () => {
      dropNextAnswer = true;
    },
  };
}

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "none";
  } catch (error) {
    return error instanceof GitHubAdapterError ? error.code : "unexpected";
  }
}

export async function runWriterExample(): Promise<Check[]> {
  const github = syntheticGitHub();
  let time = 1_800_000_000_000;
  // The consumer's policy. Here: allow what a (synthetic) owner approved by descriptor digest.
  const approved = new Set<string>();
  const authorize = (d: OperationDescriptor): AuthorizationDecision =>
    approved.has(d.digest) ? { allow: true, descriptorDigest: d.digest, expiresAt: time + 60_000, reference: "owner-approval" } : { allow: false, reason: "not approved" };
  const writer = createGitHubWriter({
    repository: { owner: "acme", name: "widgets" },
    token: "synthetic-token",
    capabilities: ["issues:create", "issues:comment", "issues:update", "issues:comment:update", "pulls:create", "pulls:review"],
    authorize,
    ledger: memoryLedger(),
    clock: () => time,
    expectedAuthor: BOT,
    fetchImpl: github.fetchImpl,
  });
  const run = async (op: Parameters<typeof writer.execute>[0]) => {
    approved.add((await writer.prepare(op)).digest);
    return writer.execute(op);
  };

  const unapproved = await code(writer.execute({ kind: "issue.create", operationId: "acme-op-0000", title: "x", body: "y" }));
  const created = await run({ kind: "issue.create", operationId: "acme-op-0001", title: "Sort widgets", body: "Proposal.", labels: ["enhancement"] });
  const replay = await writer.execute({ kind: "issue.create", operationId: "acme-op-0001", title: "Sort widgets", body: "Proposal.", labels: ["enhancement"] });
  const commented = await run({ kind: "issue.comment", operationId: "acme-op-0002", issueNumber: 1, body: "Thanks." });
  const reviewed = await run({ kind: "pull.review", operationId: "acme-op-0003", pullNumber: 7, expectedHeadSha: HEAD, event: "COMMENT", body: "Advisory notes." });
  const stale = await code(run({ kind: "pull.review", operationId: "acme-op-0004", pullNumber: 7, expectedHeadSha: "2".repeat(40), event: "COMMENT", body: "x" }));
  const approve = await code(run({ kind: "pull.review", operationId: "acme-op-0005", pullNumber: 7, expectedHeadSha: HEAD, event: "APPROVE", body: "" }));
  const pulled = await run({ kind: "pull.create", operationId: "acme-op-0006", title: "Sorting v2", body: "Second.", head: "sorting", base: "main", expectedHeadSha: HEAD }).catch(() => null);
  const updated = await run({ kind: "issue.update", operationId: "acme-op-0007", issueNumber: 1, expected: { updatedAt: "2026-01-01T00:00:00Z" }, changes: { body: "New text" } });
  const staleEdit = await code(run({ kind: "comment.update", operationId: "acme-op-0008", commentId: 5, expected: { issueNumber: 1, updatedAt: "2025-01-01T00:00:00Z" }, body: "x" }));
  const edited = await run({ kind: "comment.update", operationId: "acme-op-0009", commentId: 5, expected: { issueNumber: 1, updatedAt: "2026-01-01T00:00:00Z" }, body: "Final" });
  github.loseNextAnswer();
  const before = github.writes();
  const recovered = await run({ kind: "issue.comment", operationId: "acme-op-0010", issueNumber: 1, body: "Lost answer." });
  time += 1;

  return [
    { id: "write.unapproved-never-sent", pass: unapproved === "authorization-denied" },
    { id: "write.issue-created-and-verified", pass: created.status === "verified" && created.resource?.type === "issue" },
    { id: "write.same-operation-is-a-replay", pass: replay.replayed && replay.resource?.type === "issue" },
    { id: "write.comment-verified", pass: commented.status === "verified" },
    { id: "write.review-bound-to-head", pass: reviewed.status === "verified" && reviewed.resource?.type === "review" && reviewed.resource.commitSha === HEAD },
    { id: "write.stale-head-refused", pass: stale === "stale" },
    { id: "write.approve-needs-its-own-capability", pass: approve === "capability-denied" },
    { id: "write.pull-request-created", pass: pulled?.status === "verified" },
    { id: "write.issue-update-with-expected-state", pass: updated.status === "verified" },
    { id: "write.stale-comment-edit-refused", pass: staleEdit === "stale" },
    { id: "write.comment-update-verified", pass: edited.status === "verified" },
    { id: "write.lost-answer-recovered-not-duplicated", pass: recovered.recovered && github.writes() === before + 1 },
  ];
}
