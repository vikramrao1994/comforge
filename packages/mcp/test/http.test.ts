import { afterEach, describe, expect, test } from "bun:test";
import type { Principal } from "../src/contracts.ts";
import { createHttpHandler, type HttpOptions } from "../src/http.ts";
import { createWorld, principal, type World } from "./harness.ts";

// Streamable HTTP: every check happens before an MCP message is parsed, and a session is
// bound to the principal that initialized it.

let world: World;
afterEach(() => world?.dispose());

const HOST = "mcp.example.test";
const ORIGIN = "https://agent.example.test";
const TOKENS: Record<string, Principal> = {
  "token-reader": principal(["read-only"]),
  "token-other": { id: "other", profiles: ["read-only"], repositories: "*" },
  "token-publisher": { id: "pub", profiles: ["executor", "publisher"], repositories: "*" },
};

function handler(extra: Partial<HttpOptions> = {}) {
  return createHttpHandler({
    repositories: [world.binding],
    host: world.host(),
    authenticate: (req) =>
      TOKENS[(req.headers.get("authorization") ?? "").replace(/^Bearer /, "")] ?? null,
    allowedHosts: [HOST],
    allowedOrigins: [ORIGIN],
    challenge:
      'Bearer resource_metadata="https://mcp.example.test/.well-known/oauth-protected-resource"',
    ...extra,
  });
}

const rpc = (method: string, params: Record<string, unknown> = {}, id: number | null = 1) =>
  JSON.stringify({ jsonrpc: "2.0", ...(id === null ? {} : { id }), method, params });

function request(body: string | null, headers: Record<string, string> = {}, method = "POST") {
  return new Request(`https://${HOST}/mcp`, {
    method,
    headers: {
      host: HOST,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: "Bearer token-reader",
      ...headers,
    },
    ...(body === null ? {} : { body }),
  });
}

const INIT = rpc("initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "t", version: "0" },
});

async function session(h: ReturnType<typeof handler>, token = "token-reader") {
  const r = await h.handle(request(INIT, { authorization: `Bearer ${token}` }));
  expect(r.status).toBe(200);
  const id = r.headers.get("mcp-session-id") as string;
  expect(id).toMatch(/^[0-9a-f-]{36}$/);
  const headers = {
    authorization: `Bearer ${token}`,
    "mcp-session-id": id,
    "mcp-protocol-version": "2025-06-18",
  };
  await h.handle(request(rpc("notifications/initialized", {}, null), headers));
  return { id, headers };
}

describe("checks before any MCP message", () => {
  test("host, origin, method, size and authentication, in that order", async () => {
    world = createWorld();
    const h = handler();
    expect((await h.handle(request(INIT, { host: "evil.test" }))).status).toBe(421);
    expect((await h.handle(request(INIT, { origin: "https://evil.test" }))).status).toBe(403);
    expect((await h.handle(request(INIT, {}, "PUT"))).status).toBe(405);
    expect((await h.handle(request(INIT, { "content-length": "5000000" }))).status).toBe(413);
    const anonymous = await h.handle(request(INIT, { authorization: "" }));
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get("www-authenticate")).toContain("resource_metadata");
    expect((await h.handle(request(INIT, { authorization: "Bearer forged" }))).status).toBe(401);
    expect(h.sessions()).toBe(0);
  });

  test("a malformed principal from authentication is treated as no principal", async () => {
    world = createWorld();
    const h = handler({
      authenticate: () => ({ id: "", profiles: ["root"], repositories: "*" }) as never,
    });
    expect((await h.handle(request(INIT))).status).toBe(401);
  });

  test("a body that is not JSON-RPC is refused by the transport without a session", async () => {
    world = createWorld();
    const h = handler();
    const r = await h.handle(request("{not json"));
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(h.sessions()).toBe(0);
  });
});

describe("sessions", () => {
  test("bound to the principal that initialized them; unknown ids are 404; DELETE ends them", async () => {
    world = createWorld();
    const h = handler();
    const { id, headers } = await session(h);
    const listed = await h.handle(request(rpc("tools/list", {}, 2), headers));
    expect(listed.status).toBe(200);
    const tools = (
      (await listed.json()) as { result: { tools: { name: string }[] } }
    ).result.tools.map((t) => t.name);
    expect(tools).toContain("comforge_status");
    expect(tools).not.toContain("comforge_start");

    const hijack = await h.handle(
      request(rpc("tools/list", {}, 3), { ...headers, authorization: "Bearer token-other" }),
    );
    expect(hijack.status).toBe(403);
    expect(
      (
        await h.handle(
          request(rpc("tools/list", {}, 4), { ...headers, "mcp-session-id": crypto.randomUUID() }),
        )
      ).status,
    ).toBe(404);

    expect((await h.handle(request(null, headers, "DELETE"))).status).toBe(200);
    expect(h.sessions()).toBe(0);
    expect((await h.handle(request(rpc("tools/list", {}, 5), headers))).status).toBe(404);
    expect(id).toBeTruthy();
  });

  test("an idle session expires", async () => {
    world = createWorld();
    let now = 0;
    const h = handler({ now: () => now, limits: { sessionIdleMs: 1_000 } });
    const { headers } = await session(h);
    now = 5_000;
    expect((await h.handle(request(rpc("tools/list", {}, 2), headers))).status).toBe(404);
  });

  test("the session limit refuses new sessions, not existing ones", async () => {
    world = createWorld();
    const h = handler({ limits: { maxSessions: 1 } });
    const { headers } = await session(h);
    expect((await h.handle(request(INIT))).status).toBe(503);
    expect((await h.handle(request(rpc("tools/list", {}, 2), headers))).status).toBe(200);
  });
});

describe("limits and remote execution", () => {
  test("per-principal rate limit", async () => {
    world = createWorld();
    const h = handler({ limits: { requestsPerMinute: 3 } });
    const { headers } = await session(h);
    // initialize + initialized used two of three.
    expect((await h.handle(request(rpc("tools/list", {}, 2), headers))).status).toBe(200);
    expect((await h.handle(request(rpc("tools/list", {}, 3), headers))).status).toBe(429);
    // Another principal has its own window.
    expect((await h.handle(request(INIT, { authorization: "Bearer token-other" }))).status).toBe(
      200,
    );
  });

  test("without host isolation, an executor-publisher discovers no executing tool and cannot call one", async () => {
    world = createWorld();
    const h = handler();
    const { headers } = await session(h, "token-publisher");
    const listed = (await (await h.handle(request(rpc("tools/list", {}, 2), headers))).json()) as {
      result: { tools: { name: string }[] };
    };
    const names = listed.result.tools.map((t) => t.name);
    for (const n of [
      "comforge_start",
      "comforge_verify",
      "comforge_deliver",
      "comforge_recover",
      "comforge_cleanup",
    ])
      expect(names).not.toContain(n);
    const called = (await (
      await h.handle(
        request(
          rpc(
            "tools/call",
            { name: "comforge_start", arguments: { repository: "widgets", initiative: "ACME-1" } },
            3,
          ),
          headers,
        ),
      )
    ).json()) as { result?: { isError?: boolean }; error?: unknown };
    expect(called.error ?? called.result?.isError).toBeTruthy();
    expect((await world.cli(["status"])).json.initiatives).toEqual([]);
  });

  test("a tool result over HTTP never shows the host's paths", async () => {
    world = createWorld();
    const h = handler({ isolation: { id: "test-vm", runtime: (b) => world.rt(b.root) } });
    const { headers } = await session(h, "token-publisher");
    const issue = world.specIssue("ACME-1");
    const started = (await (
      await h.handle(
        request(
          rpc(
            "tools/call",
            {
              name: "comforge_start",
              arguments: { repository: "widgets", initiative: "ACME-1", issue },
            },
            2,
          ),
          headers,
        ),
      )
    ).json()) as { result: { content: { text: string }[]; isError?: boolean } };
    const text = started.result.content[0]?.text ?? "";
    expect(started.result.isError).toBeUndefined();
    expect(text).toContain("<host>");
    expect(text).not.toContain(world.root);
  });
});
