import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createReviewProtocol } from "@comforge/core";
import { BOT, createFakeGitHub, TOKEN } from "../../github/test/fakeGitHub.ts";
import type { Principal } from "../src/contracts.ts";
import type { RemoteHost, RemoteRepositoryBinding, TrustedConfigSnapshot } from "../src/host.ts";
import { createComforgeMcpServer } from "../src/server.ts";
import { REMOTE_READ_TOOLS } from "../src/tools.ts";
import { baseConfig, connect, principal } from "./harness.ts";

// 0.2.0: repositories served without a checkout. The host supplies the trusted configuration
// (revision + bytes + when it observed them) and a credential; the server checks the snapshot
// against GitHub's bytes at that revision, its pin, its age and its repository, and serves only
// GitHub evidence reads. No local Git, no runtime.

const REVISION = "d".repeat(40);
const HEAD = "a".repeat(40);
const NOW = 1_900_000_000_000;
const REVIEW = {
  reviewScheme: "acme-review/v1",
  markerNamespace: "acme-review",
  publisherName: "Acme Reviews",
  publishToolName: "acme_review",
  trustedAuthors: [BOT],
};
const configText = (extra: Record<string, unknown> = {}) =>
  `${JSON.stringify(baseConfig({ review: REVIEW, artifacts: { readable: ["docs/reports"] }, ...extra }), null, 2)}\n`;
const sha256 = (t: string) => createHash("sha256").update(t, "utf8").digest("hex");

function remoteWorld(
  options: {
    committed?: string;
    snapshot?: Partial<TrustedConfigSnapshot> | (() => never);
    binding?: Partial<RemoteRepositoryBinding>;
    token?: string | undefined;
  } = {},
) {
  const gh = createFakeGitHub();
  const committed = options.committed ?? configText();
  gh.files.set(`${REVISION}:comforge.config.json`, committed);
  const binding: RemoteRepositoryBinding = {
    id: "widgets",
    owner: "acme",
    name: "widgets",
    ...options.binding,
  };
  const remote: RemoteHost = {
    trustedConfig:
      typeof options.snapshot === "function"
        ? options.snapshot
        : () => ({
            revision: REVISION,
            text: committed,
            observedAt: NOW - 1_000,
            ...options.snapshot,
          }),
    credentials: () => ("token" in options ? options.token : TOKEN),
    fetchImpl: gh.fetchImpl,
    now: () => NOW,
  };
  const serve = (p: Principal = principal(["read-only"]), transport: "stdio" | "http" = "http") =>
    connect({
      repositories: [],
      remoteRepositories: [binding],
      remote,
      host: {
        runtime: () => {
          throw new Error("no runtime for a checkout-free repository");
        },
      },
      principal: p,
      transport,
    });
  return { gh, binding, serve };
}

describe("discovery", () => {
  test("a checkout-free server lists only the evidence reads its principal may call", async () => {
    const { serve } = remoteWorld();
    const s = await serve(principal(["read-only", "executor", "publisher", "reviewer"]));
    const names = (await s.client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual([...REMOTE_READ_TOOLS].sort());
    await s.close();
  });

  test("capabilities name the checkout-free repositories and their tools, and no execution", async () => {
    const { serve } = remoteWorld();
    const s = await serve();
    const r = await s.call("comforge_capabilities");
    expect(r.isError).toBe(false);
    expect(r.body.data.repositories).toEqual(["widgets"]);
    expect(r.body.data.withoutCheckout.tools).toEqual(REMOTE_READ_TOOLS);
    expect(r.body.data.execution.available).toBe(false);
    await s.close();
  });
});

describe("reads under a verified trusted configuration", () => {
  test("issue, pull requests, comments, reviews and artifacts read through the server credential", async () => {
    const { gh, serve } = remoteWorld();
    const issue = gh.seedIssue({ title: "Plain issue", body: "hello" });
    gh.seedComment(issue.number, "a comment");
    const pull = gh.seedPull("feature", HEAD);
    const protocol = createReviewProtocol({
      reviewScheme: REVIEW.reviewScheme,
      repository: "acme/widgets",
      markerNamespace: REVIEW.markerNamespace,
      publisherName: REVIEW.publisherName,
      publishToolName: REVIEW.publishToolName,
      ticketPattern: /^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+$/,
      limits: {
        summaryMaxChars: 4000,
        findingsMax: 50,
        findingTitleMaxChars: 200,
        findingTextMaxChars: 4000,
        notesMax: 20,
        noteMaxChars: 1000,
      },
    });
    const payload = protocol.buildReviewPayload(
      protocol.inputSchema.parse({
        prNumber: pull.number,
        expectedHeadSha: HEAD,
        ticketId: "ACME-001",
        verdict: "no_blocking_findings",
        summary: "fine",
        findings: [],
        idempotencyKey: "key-0123456789abcdef",
      }),
      null,
    );
    gh.seedComment(pull.number, protocol.composeReviewComment(payload, "e".repeat(32)));
    gh.files.set(`${HEAD}:docs/reports/r.md`, "# Report\n");
    const s = await serve();

    const i = await s.call("comforge_issue", { repository: "widgets", number: issue.number });
    expect(i.isError).toBe(false);
    expect(i.body.data.issue.number).toBe(issue.number);
    const prs = await s.call("comforge_prs", { repository: "widgets", state: "open" });
    expect(prs.body.data.pullRequests.map((p: { number: number }) => p.number)).toEqual([
      pull.number,
    ]);
    const comments = await s.call("comforge_comments", {
      repository: "widgets",
      number: issue.number,
    });
    expect(comments.body.data.comments).toHaveLength(1);
    const reviews = await s.call("comforge_reviews", { repository: "widgets", pr: pull.number });
    expect(reviews.isError).toBe(false);
    expect(reviews.body.data.reviews[0]).toMatchObject({
      integrity: "verified",
      provenance: "trusted_author",
      stale: false,
      authorAssociation: "NONE",
      commentUrl: expect.stringContaining("#issuecomment-"),
      updatedAt: expect.any(String),
    });
    const a = await s.call("comforge_artifact", {
      repository: "widgets",
      commit: HEAD,
      path: "docs/reports/r.md",
    });
    expect(a.body.data.artifact.kind).toBe("text");
    const outside = await s.call("comforge_artifact", {
      repository: "widgets",
      commit: HEAD,
      path: "src/secret.ts",
    });
    expect([outside.isError, outside.body.code]).toEqual([true, "policy-denied"]);
    // The credential never reaches a caller.
    for (const r of [i, prs, comments, reviews, a]) expect(r.text).not.toContain(TOKEN);
    // Every GitHub request carried the server's credential, and only to this repository.
    expect(gh.requests.every((q) => q.path.startsWith("/repos/acme/widgets/"))).toBe(true);
    await s.close();
  });
});

describe("the trusted configuration fails closed", () => {
  const issueCall = async (world: ReturnType<typeof remoteWorld>) => {
    const s = await world.serve();
    const n = world.gh.seedIssue({}).number;
    const r = await s.call("comforge_issue", { repository: "widgets", number: n });
    await s.close();
    return r;
  };

  test("text that is not what GitHub holds at the revision (forged) is refused", async () => {
    const r = await issueCall(
      remoteWorld({ snapshot: { text: configText({ artifacts: { readable: ["src"] } }) } }),
    );
    expect([r.isError, r.body.code]).toEqual([true, "config-mismatch"]);
  });

  test("a revision without the file is refused", async () => {
    const r = await issueCall(remoteWorld({ snapshot: { revision: "e".repeat(40) } }));
    expect(r.body.code).toBe("config-mismatch");
  });

  test("a stale or future snapshot is refused, and marked retryable", async () => {
    const old = await issueCall(remoteWorld({ snapshot: { observedAt: NOW - 11 * 60_000 } }));
    expect([old.body.code, old.body.retryable]).toEqual(["config-stale", true]);
    const future = await issueCall(remoteWorld({ snapshot: { observedAt: NOW + 5 * 60_000 } }));
    expect(future.body.code).toBe("config-stale");
  });

  test("a pin the snapshot does not match is refused; a matching pin passes", async () => {
    const pinned = await issueCall(remoteWorld({ binding: { configSha256: "0".repeat(64) } }));
    expect(pinned.body.code).toBe("config-mismatch");
    const ok = await issueCall(remoteWorld({ binding: { configSha256: sha256(configText()) } }));
    expect(ok.isError).toBe(false);
  });

  test("a configuration naming another repository is refused", async () => {
    const other = `${JSON.stringify(baseConfig({ repository: { owner: "evil", name: "widgets", baseBranch: "main", remote: "origin" } }), null, 2)}\n`;
    const r = await issueCall(remoteWorld({ committed: other }));
    expect(r.body.code).toBe("repository-mismatch");
  });

  test("a malformed revision, an invalid configuration and a failing source are refused", async () => {
    expect((await issueCall(remoteWorld({ snapshot: { revision: "main" } }))).body.code).toBe(
      "config-invalid",
    );
    expect((await issueCall(remoteWorld({ committed: "{}" }))).body.code).toBe("config-invalid");
    const failing = remoteWorld({
      snapshot: () => {
        throw new Error("source down");
      },
    });
    expect((await issueCall(failing)).body.code).toBe("config-missing");
  });

  test("no server credential is refused before any GitHub request", async () => {
    const world = remoteWorld({ token: undefined });
    const r = await issueCall(world);
    expect(r.body.code).toBe("credential-missing");
    expect(world.gh.requests).toHaveLength(0);
  });
});

describe("boundaries", () => {
  test("lifecycle, state and executing tools are refused for a checkout-free repository", async () => {
    const world = remoteWorld();
    const isolation = {
      id: "test-isolation",
      runtime: () => {
        throw new Error("must not run");
      },
    };
    const server = createComforgeMcpServer({
      repositories: [],
      remoteRepositories: [world.binding],
      remote: {
        trustedConfig: () => ({ revision: REVISION, text: configText(), observedAt: NOW }),
        credentials: () => TOKEN,
        now: () => NOW,
      },
      host: {
        runtime: () => {
          throw new Error("no runtime");
        },
      },
      principal: principal(["read-only", "executor"]),
      transport: "http",
      isolation,
    });
    expect(server).toBeDefined();
    // Even with isolation, nothing beyond the reads is discovered for a checkout-free server.
    const s = await connect({
      repositories: [],
      remoteRepositories: [world.binding],
      remote: {
        trustedConfig: () => ({ revision: REVISION, text: configText(), observedAt: NOW }),
        credentials: () => TOKEN,
        now: () => NOW,
      },
      host: {
        runtime: () => {
          throw new Error("no runtime");
        },
      },
      principal: principal(["read-only", "executor"]),
      transport: "http",
      isolation,
    });
    const names = (await s.client.listTools()).tools.map((t) => t.name);
    expect(names).not.toContain("comforge_start");
    expect(names).not.toContain("comforge_status");
    const start = await s.call("comforge_start", { repository: "widgets", initiative: "ACME-001" });
    expect(start.isError).toBe(true);
    await s.close();
  });

  test("another principal's repository is the same refusal as an unknown one", async () => {
    const { serve } = remoteWorld();
    const s = await serve(principal(["read-only"], ["elsewhere"]));
    const r = await s.call("comforge_issue", { repository: "widgets", number: 1 });
    expect(r.body.code).toBe("unknown-repository");
    await s.close();
  });

  test("a read-only principal cannot reach a publishing tool", async () => {
    const { serve } = remoteWorld();
    const s = await serve();
    const r = await s.call("comforge_publish_review", {
      repository: "widgets",
      review: {},
      execute: false,
    });
    expect(r.isError).toBe(true);
    await s.close();
  });

  test("mixed servers refuse checkout tools only for the checkout-free repository", async () => {
    const world = remoteWorld();
    const s = await connect({
      repositories: [{ id: "local", root: "/nonexistent/repo", owner: "acme", name: "local" }],
      remoteRepositories: [world.binding],
      remote: {
        trustedConfig: () => ({ revision: REVISION, text: configText(), observedAt: NOW }),
        credentials: () => TOKEN,
        fetchImpl: world.gh.fetchImpl,
        now: () => NOW,
      },
      host: {
        runtime: () => {
          throw new Error("not reached");
        },
      },
      principal: principal(["read-only"]),
      transport: "stdio",
    });
    const r = await s.call("comforge_status", { repository: "widgets" });
    expect([r.isError, r.body.code]).toEqual([true, "checkout-required"]);
    await s.close();
  });

  test("construction refuses a shared id, a malformed pin, or remote bindings without a host", () => {
    const base = {
      host: {
        runtime: () => {
          throw new Error("x");
        },
      },
      principal: principal(["read-only"]),
      transport: "http" as const,
    };
    const remote = {
      trustedConfig: () => ({ revision: REVISION, text: "", observedAt: NOW }),
      credentials: () => TOKEN,
    };
    expect(() =>
      createComforgeMcpServer({
        ...base,
        repositories: [{ id: "widgets", root: "/r", owner: "acme", name: "widgets" }],
        remoteRepositories: [{ id: "widgets", owner: "acme", name: "widgets" }],
        remote,
      }),
    ).toThrow(/listed twice/);
    expect(() =>
      createComforgeMcpServer({
        ...base,
        repositories: [],
        remoteRepositories: [{ id: "w", owner: "acme", name: "w", configSha256: "x" }],
        remote,
      }),
    ).toThrow(/configSha256/);
    expect(() =>
      createComforgeMcpServer({
        ...base,
        repositories: [],
        remoteRepositories: [{ id: "w", owner: "acme", name: "w" }],
      }),
    ).toThrow(/remote host/);
  });
});
