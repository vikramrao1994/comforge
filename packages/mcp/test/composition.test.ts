import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { idempotencyKeyDigest } from "@comforge/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { BOT, createFakeGitHub, createMemoryLedger, TOKEN } from "../../github/test/fakeGitHub.ts";
import type { Principal } from "../src/contracts.ts";
import type {
  RemoteGovernanceCommand,
  RemoteGovernanceHost,
  RemoteHost,
  RemoteRepositoryBinding,
} from "../src/host.ts";
import {
  type ComforgeMcpOptions,
  createComforgeMcpServer,
  registerComforgeTools,
} from "../src/server.ts";
import { REMOTE_READ_TOOLS } from "../src/tools.ts";
import { baseConfig, SPEC } from "./harness.ts";

// Composition (registerComforgeTools) and checkout-free governed publication (RemoteHost.governance).

const REVISION = "e".repeat(40);
const NOW = 1_900_000_000_000;
const WRITE_TOKEN = "ghs_WRITEfake01";
const OTHER_TOKEN = "ghs_OTHERfake01";
const REVIEWS = {
  reviewScheme: "acme-review/v1",
  markerNamespace: "acme-review",
  publisherName: "Acme Reviews",
  publishToolName: "acme_review",
  trustedAuthors: [BOT],
};
// An earlier publisher's discussion wire format, so a historical comment replays.
const DISCUSSION = {
  scheme: "acme-issue-comment/v1",
  markerNamespace: "acme-spec",
  publisherName: "Acme Specs",
  publishToolName: "acme_comment",
};
const governedConfig = (extra: Record<string, unknown> = {}, owner = "acme", name = "widgets") =>
  baseConfig({
    repository: { owner, name, baseBranch: "main", remote: "origin" },
    review: REVIEWS,
    discussion: DISCUSSION,
    security: {
      credentials: { source: "env", variable: "ACME_TOKEN" },
      authorization: { mode: "operator" },
      capabilities: ["issues:create", "issues:update", "issues:comment"],
    },
    ...extra,
  });
const text = (config: unknown) => `${JSON.stringify(config, null, 2)}\n`;

const principal = (
  profiles: Principal["profiles"],
  repositories: Principal["repositories"] = "*",
) => ({ id: "owner", profiles, repositories }) as Principal;

interface Repo {
  binding: RemoteRepositoryBinding;
  gh: ReturnType<typeof createFakeGitHub>;
  ledger: ReturnType<typeof createMemoryLedger>;
  read: string;
  write: string;
}

function repo(id: string, name: string, token: string, write: string, config?: unknown): Repo {
  const gh = createFakeGitHub({ repo: name, token: undefined, requireToken: false });
  gh.files.set(
    `${REVISION}:comforge.config.json`,
    text(config ?? governedConfig({}, "acme", name)),
  );
  gh.readOverrides.push((p) => (p === "/user" ? Response.json({ login: BOT }) : undefined));
  return {
    binding: { id, owner: "acme", name },
    gh,
    ledger: createMemoryLedger(),
    read: token,
    write,
  };
}

/** One fetch per repository, routed by path, refusing any token that is not that repository's. */
function routedFetch(repos: Repo[]): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const auth = ((init?.headers ?? {}) as Record<string, string>).Authorization ?? "";
    const target =
      repos.find((r) => url.pathname.startsWith(`/repos/acme/${r.binding.name}/`)) ??
      (url.pathname === "/user"
        ? repos.find((r) => auth.endsWith(r.write) || auth.endsWith(r.read))
        : undefined);
    if (!target) return Response.json({ message: "Not Found" }, { status: 404 });
    if (auth !== `Bearer ${target.read}` && auth !== `Bearer ${target.write}`)
      return Response.json({ message: "Bad credentials" }, { status: 401 });
    return target.gh.fetchImpl(input, init);
  }) as typeof fetch;
}

interface GovernanceSpy {
  requests: Parameters<RemoteGovernanceHost["authorize"]>[0][];
  allow: boolean;
  credentials: Partial<Record<RemoteGovernanceCommand, string | undefined>> | null;
}

function remoteHost(repos: Repo[], spy: GovernanceSpy | null): RemoteHost {
  return {
    trustedConfig: (binding) => {
      const r = repos.find((x) => x.binding.id === binding.id) as Repo;
      return {
        revision: REVISION,
        text: r.gh.files.get(`${REVISION}:comforge.config.json`) as string,
        observedAt: NOW - 1_000,
      };
    },
    credentials: (binding) => repos.find((x) => x.binding.id === binding.id)?.read,
    fetchImpl: routedFetch(repos),
    now: () => NOW,
    ...(spy
      ? {
          governance: (binding: RemoteRepositoryBinding) => {
            const r = repos.find((x) => x.binding.id === binding.id) as Repo;
            return {
              credentials: (command: RemoteGovernanceCommand) =>
                spy.credentials ? spy.credentials[command] : r.write,
              operations: r.ledger,
              authorize: (request) => {
                spy.requests.push(request);
                return spy.allow
                  ? { allow: true as const, authority: "test-host:oauth" }
                  : { allow: false as const, reason: "scope missing" };
              },
            };
          },
        }
      : {}),
  };
}

function options(
  repos: Repo[],
  p: Principal,
  spy: GovernanceSpy | null,
  extra: Partial<ComforgeMcpOptions> = {},
): ComforgeMcpOptions {
  return {
    repositories: [],
    remoteRepositories: repos.map((r) => r.binding),
    remote: remoteHost(repos, spy),
    host: {
      runtime: () => {
        throw new Error("no runtime without a checkout");
      },
    },
    principal: p,
    transport: "http",
    ...extra,
  };
}

async function open(server: McpServer) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(b);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args });
    const t = (r.content as { type: string; text: string }[])[0]?.text ?? "null";
    // biome-ignore lint/suspicious/noExplicitAny: tests read results by path
    return JSON.parse(t) as any;
  };
  const names = async () => (await client.listTools()).tools.map((t) => t.name).sort();
  return { client, call, names, close: () => client.close() };
}

const spyOf = (allow = true): GovernanceSpy => ({ requests: [], allow, credentials: null });

function applicationServer() {
  const server = new McpServer({ name: "app", version: "1.0.0" });
  server.registerTool(
    "app_echo",
    { description: "echo", inputSchema: { text: z.string() } },
    async ({ text }) => ({ content: [{ type: "text", text }] }),
  );
  return server;
}

function specificationIssue(r: Repo, ticket = "ACME-1") {
  // A published specification, composed with the configured protocol.
  const body = "## Objective\nShip it.";
  const canonical = JSON.stringify([ticket, "Ship it", body]);
  const digest = createHash("sha256").update(`${SPEC.digestScheme}\n${canonical}`).digest("hex");
  return r.gh.seedIssue({
    title: "Ship it",
    body: [
      `<!-- ${SPEC.markerNamespace}:spec-begin -->`,
      body,
      `<!-- ${SPEC.markerNamespace}:spec-end -->`,
      `<!-- ${SPEC.markerNamespace}:engineering-spec v1 ticket=${ticket} digest=${digest} key=${"a".repeat(32)} -->`,
    ].join("\n"),
  });
}

describe("registerComforgeTools composes native tools into an application's server", () => {
  test("the application's tools and the native tools coexist, each callable", async () => {
    const r = repo("widgets", "widgets", TOKEN, WRITE_TOKEN);
    const server = applicationServer();
    const registered = registerComforgeTools(server, options([r], principal(["read-only"]), null));
    expect([...registered.tools].sort()).toEqual([...REMOTE_READ_TOOLS].sort());
    const s = await open(server);
    expect(await s.names()).toEqual(["app_echo", ...REMOTE_READ_TOOLS].sort());
    const echo = await s.client.callTool({ name: "app_echo", arguments: { text: "hi" } });
    expect((echo.content as { text: string }[])[0]?.text).toBe("hi");
    const caps = await s.call("comforge_capabilities");
    expect(caps.ok).toBe(true);
    // Capability discovery describes the native tools only; the host owns its own.
    expect(caps.data.tools.map((t: { name: string }) => t.name)).not.toContain("app_echo");
    await s.close();
  });

  test("a name collision is refused before anything is registered", async () => {
    const r = repo("widgets", "widgets", TOKEN, WRITE_TOKEN);
    const server = applicationServer();
    server.registerTool("comforge_issue", { description: "impostor" }, async () => ({
      content: [{ type: "text", text: "impostor" }],
    }));
    expect(() =>
      registerComforgeTools(server, options([r], principal(["read-only"]), null)),
    ).toThrow(/already registered on this server: comforge_issue/);
    const s = await open(server);
    expect(await s.names()).toEqual(["app_echo", "comforge_issue"]);
    await s.close();
  });

  test("createComforgeMcpServer is the same registration on a new server", async () => {
    const r = repo("widgets", "widgets", TOKEN, WRITE_TOKEN);
    const o = options([r], principal(["publisher", "reviewer"]), spyOf());
    const alone = await open(createComforgeMcpServer(o));
    const composed = new McpServer({ name: "app", version: "1" });
    registerComforgeTools(composed, o);
    const together = await open(composed);
    expect(await together.names()).toEqual(await alone.names());
    await alone.close();
    await together.close();
  });
});

describe("checkout-free governed publication", () => {
  test("without host governance a checkout-free repository stays read-only", async () => {
    const r = repo("widgets", "widgets", TOKEN, WRITE_TOKEN);
    const s = await open(
      createComforgeMcpServer(options([r], principal(["publisher", "reviewer"]), null)),
    );
    expect(await s.names()).toEqual([...REMOTE_READ_TOOLS].sort());
    await s.close();
  });

  test("with governance each profile discovers only its publications; executing tools stay absent", async () => {
    const r = repo("widgets", "widgets", TOKEN, WRITE_TOKEN);
    const list = async (profiles: Principal["profiles"]) => {
      const s = await open(createComforgeMcpServer(options([r], principal(profiles), spyOf())));
      const n = await s.names();
      await s.close();
      return n;
    };
    expect(await list(["read-only"])).toEqual([...REMOTE_READ_TOOLS].sort());
    expect(await list(["reviewer"])).toEqual(
      [...REMOTE_READ_TOOLS, "comforge_publish_review"].sort(),
    );
    expect(await list(["publisher"])).toEqual(
      [...REMOTE_READ_TOOLS, "comforge_publish_specification", "comforge_publish_comment"].sort(),
    );
  });

  test("a specification is planned, authorized by the host, published once, and replayed", async () => {
    const r = repo("widgets", "widgets", TOKEN, WRITE_TOKEN);
    const spy = spyOf();
    const s = await open(createComforgeMcpServer(options([r], principal(["publisher"]), spy)));
    const args = {
      repository: "widgets",
      ticket: "ACME-7",
      title: "Add widgets",
      body: "## Objective\nWidgets.",
    };
    const plan = await s.call("comforge_publish_specification", { ...args, execute: false });
    expect(plan.ok).toBe(true);
    expect(plan.data.executed).toBe(false);
    expect(r.gh.writes()).toHaveLength(0);
    expect(spy.requests).toHaveLength(0);

    const first = await s.call("comforge_publish_specification", { ...args, execute: true });
    expect(first.ok).toBe(true);
    expect(first.data.action).toBe("created");
    expect(first.data.authorization).toEqual({
      mode: "host",
      authority: "test-host:oauth",
      principal: "owner",
    });
    expect(spy.requests).toEqual([
      expect.objectContaining({
        command: "publish-specification",
        repository: "acme/widgets",
        principal: "owner",
      }),
    ]);
    // The write went out with the write credential, never the read one.
    const posts = r.gh.writes();
    expect(posts).toHaveLength(1);
    expect(posts[0]?.auth).toBe(`Bearer ${WRITE_TOKEN}`);
    expect(JSON.stringify(first)).not.toContain(WRITE_TOKEN);

    const again = await s.call("comforge_publish_specification", { ...args, execute: true });
    expect(again.data.action).toBe("replayed");
    expect(again.data.issueNumber).toBe(first.data.issueNumber);
    expect(r.gh.writes()).toHaveLength(1);
    await s.close();
  });

  test("a lost response is reconciled: the retry adopts the issue instead of creating a second", async () => {
    const r = repo("widgets", "widgets", TOKEN, WRITE_TOKEN);
    const s = await open(createComforgeMcpServer(options([r], principal(["publisher"]), spyOf())));
    const args = {
      repository: "widgets",
      ticket: "ACME-8",
      title: "Lost",
      body: "## Objective\nLost.",
      execute: true,
    };
    r.gh.faults.push("network-after");
    // The writer reconciles within the call: the create landed, its answer was lost.
    const first = await s.call("comforge_publish_specification", args);
    expect(first.ok).toBe(true);
    const retry = await s.call("comforge_publish_specification", args);
    expect(retry.data.action).toBe("replayed");
    const created = [...r.gh.issues.values()].filter((i) => i.title === "Lost");
    expect(created).toHaveLength(1);
    expect(first.data.issueNumber).toBe(created[0]?.number);
    expect(retry.data.issueNumber).toBe(created[0]?.number);
    await s.close();
  });

  test("a host refusal, owner-grant mode, no authorization and a supplied grant all write nothing", async () => {
    const args = {
      repository: "widgets",
      ticket: "ACME-9",
      title: "No",
      body: "## Objective\nNo.",
      execute: true,
    };
    const refused = repo("widgets", "widgets", TOKEN, WRITE_TOKEN);
    let s = await open(
      createComforgeMcpServer(options([refused], principal(["publisher"]), spyOf(false))),
    );
    let out = await s.call("comforge_publish_specification", args);
    expect(out.code).toBe("unauthorized");
    expect(refused.gh.writes()).toHaveLength(0);
    out = await s.call("comforge_publish_specification", {
      ...args,
      grant: { grant: {}, keyId: "0123456789abcdef", signature: "AAAAAAAAAAAAAAAAAAAA" },
    });
    expect(out.code).toBe("usage");
    await s.close();

    const ownerGrant = governedConfig({
      security: {
        credentials: { source: "env", variable: "ACME_TOKEN" },
        capabilities: ["issues:create", "issues:comment"],
        authorization: {
          mode: "owner-grant",
          grantScheme: "acme-grant/v1",
          trustedKeys: [
            {
              keyId: "0123456789abcdef",
              publicKeyPem:
                "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAGb9ECWmEzf6FQbrBZ9w7lshQhqowtrbLDFw4rXAxZuE=\n-----END PUBLIC KEY-----\n",
              label: "owner",
            },
          ],
        },
      },
    });
    const og = repo("widgets", "widgets", TOKEN, WRITE_TOKEN, ownerGrant);
    s = await open(createComforgeMcpServer(options([og], principal(["publisher"]), spyOf())));
    out = await s.call("comforge_publish_specification", args);
    expect(out.code).toBe("authorization-required");
    expect(og.gh.writes()).toHaveLength(0);
    await s.close();

    const unset = governedConfig({
      security: {
        credentials: { source: "env", variable: "ACME_TOKEN" },
        capabilities: ["issues:create"],
      },
    });
    const none = repo("widgets", "widgets", TOKEN, WRITE_TOKEN, unset);
    s = await open(createComforgeMcpServer(options([none], principal(["publisher"]), spyOf())));
    out = await s.call("comforge_publish_specification", args);
    expect(out.code).toBe("authorization-required");
    expect(none.gh.writes()).toHaveLength(0);
    await s.close();
  });

  test("a missing write credential for one command refuses only that command", async () => {
    const r = repo("widgets", "widgets", TOKEN, WRITE_TOKEN);
    const spy = spyOf();
    spy.credentials = { "publish-specification": undefined, "publish-comment": WRITE_TOKEN };
    const s = await open(createComforgeMcpServer(options([r], principal(["publisher"]), spy)));
    const out = await s.call("comforge_publish_specification", {
      repository: "widgets",
      ticket: "ACME-10",
      title: "T",
      body: "## Objective\nT.",
      execute: true,
    });
    expect(out.code).toBe("credential-missing");
    expect(r.gh.writes()).toHaveLength(0);
    await s.close();
  });

  test("repositories are isolated: each write uses its own credential and a principal cannot reach another's", async () => {
    const a = repo("widgets", "widgets", TOKEN, WRITE_TOKEN);
    const b = repo("gadgets", "gadgets", "ghs_READfake01", OTHER_TOKEN);
    const both = await open(
      createComforgeMcpServer(options([a, b], principal(["publisher"]), spyOf())),
    );
    const args = { ticket: "ACME-11", title: "Iso", body: "## Objective\nIso.", execute: true };
    const ra = await both.call("comforge_publish_specification", {
      ...args,
      repository: "widgets",
    });
    const rb = await both.call("comforge_publish_specification", {
      ...args,
      repository: "gadgets",
    });
    expect(ra.ok && rb.ok).toBe(true);
    expect(a.gh.writes().map((w) => w.auth)).toEqual([`Bearer ${WRITE_TOKEN}`]);
    expect(b.gh.writes().map((w) => w.auth)).toEqual([`Bearer ${OTHER_TOKEN}`]);
    // Separate ledgers: each holds exactly its own repository's operation.
    expect([...a.ledger.records.values()].map((x) => x.repository)).toEqual(["acme/widgets"]);
    expect([...b.ledger.records.values()].map((x) => x.repository)).toEqual(["acme/gadgets"]);
    await both.close();

    const onlyA = await open(
      createComforgeMcpServer(options([a, b], principal(["publisher"], ["widgets"]), spyOf())),
    );
    const out = await onlyA.call("comforge_publish_specification", {
      ...args,
      repository: "gadgets",
    });
    expect(out.ok).not.toBe(true);
    expect(b.gh.writes()).toHaveLength(1);
    await onlyA.close();
  });

  test("a credential swap is refused by GitHub, never retried with another repository's token", async () => {
    const a = repo("widgets", "widgets", TOKEN, WRITE_TOKEN);
    const b = repo("gadgets", "gadgets", "ghs_READfake01", OTHER_TOKEN);
    const spy = spyOf();
    // The host wrongly answers widgets' write credential for gadgets.
    spy.credentials = { "publish-specification": WRITE_TOKEN };
    const s = await open(createComforgeMcpServer(options([a, b], principal(["publisher"]), spy)));
    const out = await s.call("comforge_publish_specification", {
      repository: "gadgets",
      ticket: "ACME-12",
      title: "Swap",
      body: "## Objective\nSwap.",
      execute: true,
    });
    expect(out.ok).not.toBe(true);
    expect(b.gh.writes()).toHaveLength(0);
    expect(a.gh.writes()).toHaveLength(0);
    await s.close();
  });
});

describe("discussion comments", () => {
  const key = "discussion-key-0001";
  test("published once on a specification issue, replayed by key, conflicting by content", async () => {
    const r = repo("widgets", "widgets", TOKEN, WRITE_TOKEN);
    const issue = specificationIssue(r);
    const spy = spyOf();
    const s = await open(createComforgeMcpServer(options([r], principal(["publisher"]), spy)));
    const args = {
      repository: "widgets",
      issue: issue.number,
      body: "Looks right.",
      idempotencyKey: key,
    };
    const plan = await s.call("comforge_publish_comment", { ...args, execute: false });
    expect(plan.data.action).toBe("create");
    expect(r.gh.writes()).toHaveLength(0);

    const first = await s.call("comforge_publish_comment", { ...args, execute: true });
    expect(first.ok).toBe(true);
    expect(first.data.action).toBe("created");
    expect(first.data.ticket).toBe("ACME-1");
    expect(spy.requests.map((q) => q.command)).toEqual(["publish-comment"]);
    const posted = [...r.gh.comments.values()].filter((c) => c.issue === issue.number);
    expect(posted).toHaveLength(1);
    expect(posted[0]?.body).toContain(`<!-- acme-spec:issue-comment v1 issue=${issue.number} key=`);

    const replay = await s.call("comforge_publish_comment", { ...args, execute: true });
    expect(replay.data.action).toBe("replayed");
    expect(replay.data.commentId).toBe(first.data.commentId);
    const conflict = await s.call("comforge_publish_comment", {
      ...args,
      body: "Other text.",
      execute: true,
    });
    expect(conflict.code).toBe("conflict");
    expect([...r.gh.comments.values()].filter((c) => c.issue === issue.number)).toHaveLength(1);
    await s.close();
  });

  test("a comment in the earlier publisher's format is recognised, so a retry never duplicates it", async () => {
    const r = repo("widgets", "widgets", TOKEN, WRITE_TOKEN);
    const issue = specificationIssue(r);
    const body = "Earlier comment.";
    // The digest exactly as the earlier gateway computed it.
    const digest = createHash("sha256")
      .update(
        JSON.stringify({
          scheme: DISCUSSION.scheme,
          issueNumber: issue.number,
          body,
          relatedReview: null,
        }),
      )
      .digest("hex");
    r.gh.seedComment(
      issue.number,
      `${body}\n\n---\n<sub>old footer</sub>\n<!-- acme-spec:issue-comment v1 issue=${issue.number} key=${idempotencyKeyDigest(key)} digest=${digest} -->`,
    );
    const s = await open(createComforgeMcpServer(options([r], principal(["publisher"]), spyOf())));
    const out = await s.call("comforge_publish_comment", {
      repository: "widgets",
      issue: issue.number,
      body,
      idempotencyKey: key,
      execute: true,
    });
    expect(out.data.action).toBe("replayed");
    expect(r.gh.writes()).toHaveLength(0);
    await s.close();
  });

  test("never on a plain issue, a pull request or a closed issue", async () => {
    const r = repo("widgets", "widgets", TOKEN, WRITE_TOKEN);
    const plain = r.gh.seedIssue({ title: "Plain", body: "no marker" });
    const pr = r.gh.seedPull("feature", "f".repeat(40));
    const closed = specificationIssue(r, "ACME-2");
    r.gh.issues.set(closed.number, { ...closed, state: "closed" });
    const s = await open(createComforgeMcpServer(options([r], principal(["publisher"]), spyOf())));
    const call = (issue: number) =>
      s.call("comforge_publish_comment", {
        repository: "widgets",
        issue,
        body: "x",
        idempotencyKey: key,
        execute: true,
      });
    expect((await call(plain.number)).code).toBe("policy-denied");
    expect((await call(pr.number)).code).toBe("usage");
    expect((await call(closed.number)).code).toBe("conflict");
    expect(r.gh.writes()).toHaveLength(0);
    await s.close();
  });

  test("text carrying a reserved marker or a credential is refused", async () => {
    const r = repo("widgets", "widgets", TOKEN, WRITE_TOKEN);
    const issue = specificationIssue(r);
    const s = await open(createComforgeMcpServer(options([r], principal(["publisher"]), spyOf())));
    const call = (body: string) =>
      s.call("comforge_publish_comment", {
        repository: "widgets",
        issue: issue.number,
        body,
        idempotencyKey: key,
        execute: true,
      });
    expect((await call("see <!-- acme-spec:issue-comment v1 -->")).code).toBe("policy-denied");
    expect((await call(`token ${TOKEN}`)).code).toBe("policy-denied");
    expect(r.gh.writes()).toHaveLength(0);
    await s.close();
  });
});

describe("checkout-free advisory reviews", () => {
  const HEAD = "c".repeat(40);
  const REVIEW_TOKEN = "ghs_REVIEWfake1";
  const input = (prNumber: number, over: Record<string, unknown> = {}) => ({
    prNumber,
    expectedHeadSha: HEAD,
    ticketId: "ACME-1",
    verdict: "revision_recommended",
    summary: "One thing to fix.",
    findings: [{ id: "H1", severity: "high", title: "A defect", evidence: "See file a.txt." }],
    idempotencyKey: "review-key-0123456789",
    ...over,
  });

  test("published with the review credential, bound to the head, replayed, and refused when stale", async () => {
    const r = repo("widgets", "widgets", TOKEN, WRITE_TOKEN);
    const pr = r.gh.seedPull("feature/x", HEAD, { author: "alice" });
    const spy = spyOf();
    spy.credentials = { "publish-review": REVIEW_TOKEN };
    const fetchImpl = routedFetch([{ ...r, write: REVIEW_TOKEN }]);
    const o = options([r], principal(["reviewer"]), spy);
    const s = await open(
      createComforgeMcpServer({ ...o, remote: { ...(o.remote as RemoteHost), fetchImpl } }),
    );
    const first = await s.call("comforge_publish_review", {
      repository: "widgets",
      review: input(pr.number),
      execute: true,
    });
    expect(first.ok).toBe(true);
    expect(first.data.kind).toBe("advisory");
    expect(first.data.action).toBe("created");
    expect(r.gh.writes().map((w) => w.auth)).toEqual([`Bearer ${REVIEW_TOKEN}`]);
    expect(spy.requests.map((q) => q.command)).toEqual(["publish-review"]);
    // Advisory only: a marked issue comment, never a native review or approval.
    expect(r.gh.reviews.size).toBe(0);

    const replay = await s.call("comforge_publish_review", {
      repository: "widgets",
      review: input(pr.number),
      execute: true,
    });
    expect(replay.data.action).toBe("replayed");

    const stale = await s.call("comforge_publish_review", {
      repository: "widgets",
      review: input(pr.number, {
        expectedHeadSha: "d".repeat(40),
        idempotencyKey: "review-key-stale-0001",
      }),
      execute: true,
    });
    expect(stale.code).toBe("stale");
    expect(r.gh.writes()).toHaveLength(1);
    await s.close();
  });
});

describe("a GitHub App write credential", () => {
  const HEAD = "c".repeat(40);
  const APP = "acme-reviewer[bot]";
  const input = (prNumber: number) => ({
    prNumber,
    expectedHeadSha: HEAD,
    ticketId: "ACME-1",
    verdict: "revision_recommended",
    summary: "One thing to fix.",
    findings: [{ id: "H1", severity: "high", title: "A defect", evidence: "See file a.txt." }],
    idempotencyKey: "review-key-app-000001",
  });
  // An installation token cannot read GET /user.
  const appRepo = () => {
    const r = repo("widgets", "widgets", TOKEN, WRITE_TOKEN);
    r.gh.readOverrides.length = 0;
    r.gh.readOverrides.push((p) =>
      p === "/user"
        ? Response.json({ message: "Resource not accessible by integration" }, { status: 403 })
        : undefined,
    );
    return r;
  };
  const server = (r: Repo, identity?: string) => {
    const o = options([r], principal(["reviewer"]), spyOf());
    const remote = o.remote as RemoteHost;
    return createComforgeMcpServer({
      ...o,
      remote: {
        ...remote,
        governance: (binding, p) => {
          const g = remote.governance?.(binding, p) as RemoteGovernanceHost;
          return { ...g, ...(identity ? { identity: () => identity } : {}) };
        },
      },
    });
  };

  test("without the host's identity the write is refused before anything is sent", async () => {
    const r = appRepo();
    const pr = r.gh.seedPull("feature/app", HEAD, { author: "alice" });
    const s = await open(server(r));
    const out = await s.call("comforge_publish_review", {
      repository: "widgets",
      review: input(pr.number),
      execute: true,
    });
    expect(out.ok).not.toBe(true);
    expect(r.gh.writes()).toHaveLength(0);
    await s.close();
  });

  test("with it the review is published as the App, replays, and its own pull request is refused", async () => {
    const r = appRepo();
    const pr = r.gh.seedPull("feature/app", HEAD, { author: "alice" });
    const s = await open(server(r, APP));
    const first = await s.call("comforge_publish_review", {
      repository: "widgets",
      review: input(pr.number),
      execute: true,
    });
    expect(first.ok).toBe(true);
    expect(first.data.action).toBe("created");
    expect(r.gh.writes()).toHaveLength(1);
    const again = await s.call("comforge_publish_review", {
      repository: "widgets",
      review: input(pr.number),
      execute: true,
    });
    expect(again.data.action).toBe("replayed");
    const own = r.gh.seedPull("feature/own", HEAD, { author: APP });
    const refused = await s.call("comforge_publish_review", {
      repository: "widgets",
      review: { ...input(own.number), idempotencyKey: "review-key-app-000002" },
      execute: true,
    });
    expect(refused.code).toBe("policy-denied");
    await s.close();
  });

  test("a malformed identity is refused", async () => {
    const r = appRepo();
    const pr = r.gh.seedPull("feature/app", HEAD, { author: "alice" });
    const s = await open(server(r, "not a login"));
    const out = await s.call("comforge_publish_review", {
      repository: "widgets",
      review: input(pr.number),
      execute: true,
    });
    expect(out.code).toBe("config-invalid");
    expect(r.gh.writes()).toHaveLength(0);
    await s.close();
  });
});

describe("pull request checks and read denials (0.6.0)", () => {
  const HEAD = "a".repeat(40);
  type Run = { name: string; status: string; conclusion: string | null };
  const withRuns = (r: Repo, runs: Run[]) =>
    r.gh.readOverrides.push((p) =>
      p.endsWith(`/commits/${HEAD}/check-runs`)
        ? Response.json({
            total_count: runs.length,
            check_runs: runs.map((x, i) => ({
              id: i + 1,
              ...x,
              head_sha: HEAD,
              app: { slug: "ci" },
            })),
          })
        : undefined,
    );
  const checksOf = async (runs: Run[]) => {
    const r = repo("widgets", "widgets", TOKEN, WRITE_TOKEN);
    const pr = r.gh.seedPull("feature/checks", HEAD);
    withRuns(r, runs);
    const s = await open(createComforgeMcpServer(options([r], principal(["read-only"]), null)));
    const out = await s.call("comforge_pr", {
      repository: "widgets",
      number: pr.number,
      include: ["checks"],
    });
    await s.close();
    return out.data.checks;
  };
  const run = (name: string, conclusion: string | null, status = "completed"): Run => ({
    name,
    status,
    conclusion,
  });

  test("all runs passed is ok; skipped and neutral runs never block", async () => {
    const checks = await checksOf([
      run("build", "success"),
      run("docs", "skipped"),
      run("lint", "neutral"),
    ]);
    expect(checks).toMatchObject({
      ok: true,
      state: "passing",
      total: 3,
      counts: { passed: 1, skipped: 1, neutral: 1, failing: 0, pending: 0 },
      failing: [],
      pending: [],
      sources: ["check-runs"],
      required: { evaluated: false },
    });
  });

  test("no failing and no pending entry is never silently not ok: the state says why", async () => {
    expect(await checksOf([])).toMatchObject({
      ok: false,
      state: "none",
      total: 0,
      failing: [],
      pending: [],
    });
    expect(await checksOf([run("docs", "skipped"), run("lint", "neutral")])).toMatchObject({
      ok: false,
      state: "neutral",
      failing: [],
      pending: [],
    });
  });

  test("a failing run outranks a pending one; every blocking conclusion counts as failing", async () => {
    const blocking = [
      "failure",
      "cancelled",
      "timed_out",
      "action_required",
      "stale",
      "startup_failure",
      "surprising",
    ];
    const checks = await checksOf([
      run("build", "success"),
      run("wait", null, "in_progress"),
      ...blocking.map((c) => run(c, c)),
    ]);
    expect(checks).toMatchObject({
      ok: false,
      state: "failing",
      failing: blocking,
      pending: ["wait"],
    });
    expect(await checksOf([run("build", "success"), run("queued", null, "queued")])).toMatchObject({
      ok: false,
      state: "pending",
      pending: ["queued"],
    });
  });

  test("a read refused for the server's own credential is a credential code, never a grant refusal", async () => {
    const r = repo("widgets", "widgets", TOKEN, WRITE_TOKEN);
    const pr = r.gh.seedPull("feature/denied", HEAD);
    r.gh.readOverrides.push((p) =>
      p.endsWith(`/commits/${HEAD}/check-runs`)
        ? Response.json(
            { message: "Resource not accessible by personal access token" },
            { status: 403 },
          )
        : undefined,
    );
    const s = await open(createComforgeMcpServer(options([r], principal(["read-only"]), null)));
    const out = await s.call("comforge_pr", {
      repository: "widgets",
      number: pr.number,
      include: ["checks"],
    });
    expect(out).toMatchObject({
      code: "credential-forbidden",
      exit: 1,
      retryable: false,
      detail: { github: "forbidden", status: 403 },
    });
    expect(out.hint).toMatch(/read permissions/);
    expect(out.hint).not.toMatch(/owner grant for this initiative/);
    // The same pull request without checks still reads: only the denied read fails.
    expect((await s.call("comforge_pr", { repository: "widgets", number: pr.number })).ok).toBe(
      true,
    );
    await s.close();
  });
});

describe("per-repository governed commands (0.6.0)", () => {
  const onlyReviews = (r: Repo, spy: GovernanceSpy) => {
    const o = options([r], principal(["publisher", "reviewer"]), spy);
    const remote = o.remote as RemoteHost;
    return createComforgeMcpServer({
      ...o,
      remote: {
        ...remote,
        governance: (binding, p) => ({
          ...(remote.governance?.(binding, p) as RemoteGovernanceHost),
          commands: ["publish-review"],
        }),
      },
    });
  };

  test("capabilities list only the commands the host serves for that repository", async () => {
    const r = repo("widgets", "widgets", TOKEN, WRITE_TOKEN);
    const s = await open(onlyReviews(r, spyOf()));
    const caps = await s.call("comforge_capabilities");
    expect(caps.data.withoutCheckout.governance).toEqual([
      { repository: "widgets", tools: ["comforge_publish_review"] },
    ]);
    await s.close();
  });

  test("a command the host does not serve is refused before any read, authorization or write", async () => {
    const r = repo("widgets", "widgets", TOKEN, WRITE_TOKEN);
    const spy = spyOf();
    const s = await open(onlyReviews(r, spy));
    const before = r.gh.requests.length;
    const out = await s.call("comforge_publish_specification", {
      repository: "widgets",
      ticket: "ACME-9",
      title: "Not served",
      body: "## Objective\nNo.",
      execute: true,
    });
    expect(out).toMatchObject({
      code: "operation-not-served",
      detail: { repository: "widgets", command: "publish-specification" },
    });
    expect(spy.requests).toHaveLength(0);
    expect(r.gh.requests.length).toBe(before);
    expect(r.gh.writes()).toHaveLength(0);
    await s.close();
  });
});
