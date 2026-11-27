import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import path from "node:path";
import type { Runtime } from "@comforge/cli";
import type { Principal } from "../src/contracts.ts";
import type { AuditEvent } from "../src/host.ts";
import { createHttpHandler, type HttpOptions } from "../src/http.ts";
import { createComforgeMcpServer } from "../src/server.ts";
import { baseConfig, createWorld, principal, TOKEN, type World } from "./harness.ts";

// Review M2/M3: authentication and session isolation under attack, and the remote
// execution boundary. Synthetic clients only; nothing is deployed.

let world: World;
afterEach(() => world?.dispose());

const HOST = "mcp.example.test";
const rpc = (method: string, params: Record<string, unknown> = {}, id: number | null = 1) =>
  JSON.stringify({ jsonrpc: "2.0", ...(id === null ? {} : { id }), method, params });
const INIT = rpc("initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "t", version: "0" },
});
const req = (body: BodyInit | null, headers: Record<string, string> = {}, method = "POST") =>
  new Request(`https://${HOST}/mcp`, {
    method,
    headers: {
      host: HOST,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: "Bearer t",
      ...headers,
    },
    ...(body === null ? {} : { body }),
    // biome-ignore lint/suspicious/noExplicitAny: Bun needs duplex for a streamed body
    ...(body instanceof ReadableStream ? ({ duplex: "half" } as any) : {}),
  });

function handler(
  who: () => Principal | null | Promise<Principal | null>,
  extra: Partial<HttpOptions> = {},
) {
  return createHttpHandler({
    repositories: [world.binding],
    host: world.host(),
    authenticate: () => who(),
    allowedHosts: [HOST],
    allowedOrigins: [],
    ...extra,
  });
}

async function open(h: ReturnType<typeof handler>) {
  const r = await h.handle(req(INIT));
  expect(r.status).toBe(200);
  const headers = {
    "mcp-session-id": r.headers.get("mcp-session-id") as string,
    "mcp-protocol-version": "2025-06-18",
  };
  await h.handle(req(rpc("notifications/initialized", {}, null), headers));
  return headers;
}

const call = async (
  h: ReturnType<typeof handler>,
  headers: Record<string, string>,
  name: string,
  args: Record<string, unknown>,
  id = 9,
) => {
  const r = await h.handle(req(rpc("tools/call", { name, arguments: args }, id), headers));
  const body = (await r.json()) as {
    result?: { content: { text: string }[]; isError?: boolean };
    error?: { message: string };
  };
  return {
    status: r.status,
    body,
    parsed: body.result ? JSON.parse(body.result.content[0]?.text ?? "{}") : null,
  };
};

describe("M2: authentication and session isolation", () => {
  test("a revoked principal is refused at once; a changed role ends its session", async () => {
    world = createWorld();
    let who: Principal | null = principal(["read-only"]);
    const h = handler(() => who);
    const headers = await open(h);
    who = null;
    expect((await h.handle(req(rpc("tools/list", {}, 2), headers))).status).toBe(401);
    who = { ...principal(["read-only"]), profiles: ["executor", "publisher"] };
    expect((await h.handle(req(rpc("tools/list", {}, 3), headers))).status).toBe(403);
    // The session is gone: even the original role cannot continue it.
    who = principal(["read-only"]);
    expect((await h.handle(req(rpc("tools/list", {}, 4), headers))).status).toBe(404);
    who = { ...principal(["read-only"]), repositories: ["elsewhere"] };
    const second = await open(handler(() => principal(["read-only"])));
    expect(second["mcp-session-id"]).toBeTruthy();
  });

  test("an authenticator that throws, or returns a malformed principal, is a 401, never a guess", async () => {
    world = createWorld();
    expect(
      (
        await handler(() => {
          throw new Error("idp down");
        }).handle(req(INIT))
      ).status,
    ).toBe(401);
    expect(
      (
        await handler(() => ({ id: "x", profiles: [], repositories: "*" }) as never).handle(
          req(INIT),
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await handler(() => ({ id: "x", profiles: ["root"], repositories: "*" }) as never).handle(
          req(INIT),
        )
      ).status,
    ).toBe(401);
  });

  test("a streamed body over the limit without a Content-Length is refused before parsing", async () => {
    world = createWorld();
    const h = handler(() => principal(["read-only"]), { limits: { maxBodyBytes: 1_000 } });
    const chunk = new TextEncoder().encode("x".repeat(600));
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(chunk);
        c.enqueue(chunk);
        c.close();
      },
    });
    const r = await h.handle(req(stream));
    expect(r.status).toBe(413);
    expect(h.sessions()).toBe(0);
  });

  test("concurrent requests beyond the per-principal limit are refused while one is in flight", async () => {
    world = createWorld();
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const slowFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      await gate;
      return world.gh.fetchImpl(input as string, init);
    }) as typeof fetch;
    const h = createHttpHandler({
      repositories: [world.binding],
      host: { runtime: (b) => ({ ...world.rt(b.root), fetchImpl: slowFetch }) },
      authenticate: () => principal(["read-only"]),
      allowedHosts: [HOST],
      allowedOrigins: [],
      limits: { maxConcurrentPerPrincipal: 1 },
    });
    const headers = await open(h);
    const n = world.specIssue("ACME-1");
    const pending = call(h, headers, "comforge_issue", { repository: "widgets", number: n });
    await new Promise((r) => setTimeout(r, 20));
    expect((await h.handle(req(rpc("tools/list", {}, 3), headers))).status).toBe(429);
    release();
    expect((await pending).parsed.ok).toBe(true);
  });

  test("audit events carry no arguments, bodies or credentials", async () => {
    world = createWorld();
    const events: AuditEvent[] = [];
    const h = handler(() => principal(["read-only"]), {
      host: world.host({ audit: (e) => events.push(e) }),
    });
    const headers = await open(h);
    await call(h, headers, "comforge_context", {
      repository: "widgets",
      task: "SECRET-TASK-TEXT ghp_abcdefghijklmnopqrstuvwxyz0123456789",
    });
    await call(h, headers, "comforge_status", { repository: "nope" });
    expect(events.map((e) => [e.tool, e.outcome])).toEqual([
      ["comforge_context", expect.any(String)],
      ["comforge_status", "refused"],
    ]);
    const text = JSON.stringify(events);
    for (const leak of ["SECRET-TASK-TEXT", "ghp_", TOKEN, world.root])
      expect(text).not.toContain(leak);
  });
});

describe("M3: the remote execution boundary", () => {
  test("an isolation provider that is not one is a configuration error; one that fails refuses the call", async () => {
    world = createWorld();
    for (const bad of [
      { id: "", runtime: () => world.rt() },
      { id: "vm", runtime: "no" },
      { id: "VM!", runtime: () => world.rt() },
    ])
      expect(() =>
        createComforgeMcpServer({
          repositories: [world.binding],
          host: world.host(),
          principal: principal(["executor"]),
          transport: "http",
          isolation: bad as never,
        }),
      ).toThrow("IsolationProvider");
    const h = handler(() => principal(["executor"]), {
      isolation: {
        id: "vm",
        runtime: () => {
          throw new Error("vm pool exhausted");
        },
      },
    });
    const headers = await open(h);
    const r = await call(h, headers, "comforge_start", {
      repository: "widgets",
      initiative: "ACME-1",
    });
    expect(r.parsed).toMatchObject({ code: "execution-unavailable", retryable: false });
    expect(JSON.stringify(r.body)).not.toContain("vm pool exhausted");
    const broken = handler(() => principal(["executor"]), {
      isolation: { id: "vm", runtime: () => ({}) as Runtime },
    });
    expect(
      (
        await call(broken, await open(broken), "comforge_start", {
          repository: "widgets",
          initiative: "ACME-1",
        })
      ).parsed.code,
    ).toBe("execution-unavailable");
    expect((await world.cli(["status"])).json.initiatives).toEqual([]);
  });

  test("every repository command over HTTP runs in the isolation's runtime, and a lost write is reconciled once", async () => {
    world = createWorld();
    const isolated: string[] = [];
    const hostRuntime: string[] = [];
    const h = createHttpHandler({
      repositories: [world.binding],
      host: {
        runtime: (b) => {
          const rt = world.rt(b.root);
          return { ...rt, run: (c, a, o) => (hostRuntime.push(c), rt.run(c, a, o)) };
        },
      },
      isolation: {
        id: "test-vm",
        runtime: (b) => {
          const rt = world.rt(b.root);
          return {
            ...rt,
            run: (c, a, o) => (isolated.push(`${c} ${a[0] ?? ""}`), rt.run(c, a, o)),
          };
        },
      },
      authenticate: () => principal(["executor", "publisher"]),
      allowedHosts: [HOST],
      allowedOrigins: [],
    });
    const headers = await open(h);
    const issue = world.specIssue("DEMO-001");
    const started = await call(h, headers, "comforge_start", {
      repository: "widgets",
      initiative: "DEMO-001",
      issue,
    });
    expect(started.parsed.ok).toBe(true);
    // The checkout path is the host's: the client learns only that one exists.
    const record = (await world.cli(["status", "DEMO-001"])).json as { checkout: string };
    world.commitFile(record.checkout, "a.txt", "a\n", "feat: a\n\nTicket: DEMO-001");
    expect(
      (
        await call(
          h,
          headers,
          "comforge_verify",
          { repository: "widgets", initiative: "DEMO-001" },
          10,
        )
      ).parsed.data.status,
    ).toBe("PASS");
    const head = world.sh(record.checkout, "git", "rev-parse", "HEAD");
    world.gh.faults.push("network-after");
    const delivered = await call(
      h,
      headers,
      "comforge_deliver",
      {
        repository: "widgets",
        initiative: "DEMO-001",
        title: "A",
        execute: true,
        result: {
          contract: "acme-completion/v1",
          issueType: "implementation",
          outcome: "completed",
          sourceRevision: head,
          execution: { runner: "test-agent", model: "m" },
          summary: "Done.",
          sections: { changed_behavior: "a." },
          findings: [],
          changedArtifacts: [],
          evidence: [],
          validation: [{ gate: "unit", command: "sh check.sh", status: "PASS" }],
          limitations: [],
          nextSteps: [],
        },
      },
      11,
    );
    expect(delivered.parsed.data.delivery).toBe("complete");
    expect(
      [...world.gh.pulls.values()].filter((p) => p.head.ref === "agent/demo-001"),
    ).toHaveLength(1);
    expect(isolated.some((c) => c.startsWith("git push"))).toBe(true);
    expect(isolated.some((c) => c.startsWith("sh check.sh"))).toBe(true);
    // The host runtime served reads only: no validation, push or clone ran in it.
    expect(hostRuntime.filter((c) => c !== "git")).toEqual([]);
  });

  test("forged nested authorization and a working-tree configuration change grant nothing", async () => {
    world = createWorld({
      config: baseConfig({ security: { credentials: { source: "env", variable: "ACME_TOKEN" } } }),
    });
    // A working-tree edit naming operator mode (and another repository) is not trusted.
    writeFileSync(
      path.join(world.primary, "comforge.config.json"),
      JSON.stringify(
        baseConfig({
          repository: { owner: "evil", name: "x", baseBranch: "main", remote: "origin" },
        }),
      ),
    );
    const s = createComforgeMcpServer({
      repositories: [world.binding],
      host: world.host(),
      principal: principal(["executor", "publisher"]),
      transport: "stdio",
    });
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const [a, b] = InMemoryTransport.createLinkedPair();
    await s.connect(a);
    const client = new Client({ name: "t", version: "0" });
    await client.connect(b);
    const text = async (name: string, args: Record<string, unknown>) => {
      const r = await client.callTool({ name, arguments: args });
      return JSON.parse((r.content as { text: string }[])[0]?.text ?? "{}");
    };
    const issue = world.specIssue("DEMO-001");
    expect((await text("comforge_issue", { repository: "widgets", number: issue })).ok).toBe(true);
    await text("comforge_start", { repository: "widgets", initiative: "DEMO-001", issue });
    const refused = await text("comforge_deliver", {
      repository: "widgets",
      initiative: "DEMO-001",
      title: "A",
      execute: true,
      result: {
        authorized: { mode: "operator" },
        security: { authorization: { mode: "operator" } },
      },
    });
    expect(refused.code).not.toBeUndefined();
    expect(world.gh.writes()).toHaveLength(0);
    await client.close();
  });
});
