import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { BOT, createFakeGitHub, TOKEN } from "../../github/test/fakeGitHub.ts";
import type { Principal } from "../src/contracts.ts";
import type { RemoteHost, RemoteRepositoryBinding } from "../src/host.ts";
import { createHttpHandler, type HttpOptions } from "../src/http.ts";
import { REMOTE_READ_TOOLS } from "../src/tools.ts";
import { baseConfig } from "./harness.ts";

// Checkout-free repositories through createHttpHandler: the HTTP checks, session binding and
// read-only restrictions still hold when the host forwards `remoteRepositories` and `remote`.

const HOST = "mcp.example.test";
const REVISION = "d".repeat(40);
const NOW = 1_900_000_000_000;
const configText = `${JSON.stringify(
  baseConfig({
    review: {
      reviewScheme: "acme-review/v1",
      markerNamespace: "acme-review",
      publisherName: "Acme Reviews",
      publishToolName: "acme_review",
      trustedAuthors: [BOT],
    },
  }),
  null,
  2,
)}\n`;

const PRINCIPALS: Record<string, Principal> = {
  reader: { id: "reader", profiles: ["read-only"], repositories: "*" },
  exec: { id: "exec", profiles: ["read-only", "executor"], repositories: "*" },
  elsewhere: { id: "elsewhere", profiles: ["read-only"], repositories: ["other"] },
};

function setup(
  options: {
    text?: string;
    binding?: Partial<RemoteRepositoryBinding>;
    extra?: Partial<HttpOptions>;
    principals?: Record<string, Principal>;
  } = {},
) {
  const gh = createFakeGitHub();
  gh.files.set(`${REVISION}:comforge.config.json`, configText);
  const binding: RemoteRepositoryBinding = {
    id: "widgets",
    owner: "acme",
    name: "widgets",
    ...options.binding,
  };
  const remote: RemoteHost = {
    trustedConfig: () => ({
      revision: REVISION,
      text: options.text ?? configText,
      observedAt: NOW - 1_000,
    }),
    credentials: () => TOKEN,
    fetchImpl: gh.fetchImpl,
    now: () => NOW,
  };
  const table = options.principals ?? PRINCIPALS;
  const h = createHttpHandler({
    repositories: [],
    remoteRepositories: [binding],
    remote,
    host: {
      runtime: () => {
        throw new Error("no runtime for a checkout-free repository");
      },
    },
    authenticate: (req) =>
      table[(req.headers.get("authorization") ?? "").replace(/^Bearer /, "")] ?? null,
    allowedHosts: [HOST],
    allowedOrigins: [],
    challenge: "Bearer",
    ...options.extra,
  });
  return { gh, h };
}

const rpc = (method: string, params: Record<string, unknown> = {}, id: number | null = 1) =>
  JSON.stringify({ jsonrpc: "2.0", ...(id === null ? {} : { id }), method, params });
const req = (body: string, headers: Record<string, string> = {}) =>
  new Request(`https://${HOST}/mcp`, {
    method: "POST",
    headers: {
      host: HOST,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: "Bearer reader",
      ...headers,
    },
    body,
  });
const INIT = rpc("initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "t", version: "0" },
});

async function open(h: ReturnType<typeof setup>["h"], token = "reader") {
  const r = await h.handle(req(INIT, { authorization: `Bearer ${token}` }));
  expect(r.status).toBe(200);
  const id = r.headers.get("mcp-session-id") as string;
  const headers = {
    authorization: `Bearer ${token}`,
    "mcp-session-id": id,
    "mcp-protocol-version": "2025-06-18",
  };
  await h.handle(req(rpc("notifications/initialized", {}, null), headers));
  const call = async (name: string, args: Record<string, unknown>) => {
    const res = await h.handle(req(rpc("tools/call", { name, arguments: args }, 7), headers));
    // biome-ignore lint/suspicious/noExplicitAny: tests read results by path
    return { status: res.status, json: (await res.json()) as any };
  };
  const list = async () => {
    const res = await h.handle(req(rpc("tools/list", {}, 6), headers));
    // biome-ignore lint/suspicious/noExplicitAny: tests read results by path
    return (((await res.json()) as any).result.tools as { name: string }[]).map((t) => t.name);
  };
  return { headers, call, list, initResponse: r };
}

describe("remote repositories over HTTP", () => {
  test("serves the evidence reads, reports the package version, and nothing else", async () => {
    const { gh, h } = setup();
    const issue = gh.seedIssue({ title: "Plain issue", body: "hello" });
    const s = await open(h);
    expect((await s.list()).sort()).toEqual([...REMOTE_READ_TOOLS].sort());
    const r = await s.call("comforge_issue", { repository: "widgets", number: issue.number });
    expect(r.status).toBe(200);
    expect(r.json.result.isError).not.toBe(true);
    expect(JSON.stringify(r.json)).not.toContain(TOKEN);
    // biome-ignore lint/suspicious/noExplicitAny: tests read results by path
    const init = (await (await h.handle(req(INIT))).json()) as any;
    expect(init.result.serverInfo.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  test("unauthenticated requests are 401 with the challenge", async () => {
    const { h } = setup();
    const r = await h.handle(req(INIT, { authorization: "" }));
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toBe("Bearer");
    expect(h.sessions()).toBe(0);
  });

  test("a principal with no profile is refused, and a profile that is not executor cannot call executing tools", async () => {
    const { h } = setup({
      principals: { ...PRINCIPALS, none: { id: "none", profiles: [], repositories: "*" } },
    });
    expect((await h.handle(req(INIT, { authorization: "Bearer none" }))).status).toBe(401);
    const s = await open(h);
    const r = await s.call("comforge_start", { repository: "widgets", initiative: "ACME-001" });
    expect(r.json.error ?? r.json.result?.isError).toBeTruthy();
  });

  test("a principal not allowed the repository gets the unknown-repository refusal", async () => {
    const { h } = setup();
    const s = await open(h, "elsewhere");
    const r = await s.call("comforge_issue", { repository: "widgets", number: 1 });
    expect(r.json.result.isError).toBe(true);
    expect(JSON.stringify(r.json)).toContain("unknown-repository");
  });

  test("executing tools are not listed and are refused, even with an isolation provider", async () => {
    const { h } = setup({
      extra: {
        isolation: {
          id: "test-isolation",
          runtime: () => {
            throw new Error("must not run");
          },
        },
      },
    });
    const s = await open(h, "exec");
    const names = await s.list();
    expect(names).not.toContain("comforge_start");
    expect(names).not.toContain("comforge_status");
    const r = await s.call("comforge_start", { repository: "widgets", initiative: "ACME-001" });
    expect(r.json.error ?? r.json.result?.isError).toBeTruthy();
  });

  test("a changed principal fingerprint ends the session", async () => {
    let profiles: Principal["profiles"] = ["read-only"];
    const { h } = setup({
      extra: { authenticate: () => ({ id: "p", profiles, repositories: "*" }) },
    });
    const s = await open(h);
    expect((await s.list()).length).toBeGreaterThan(0);
    profiles = ["read-only", "executor"];
    const res = await h.handle(req(rpc("tools/list", {}, 9), s.headers));
    expect(res.status).toBe(403);
    expect(h.sessions()).toBe(0);
  });

  test("a forged, pinned-mismatch or stale configuration is refused over HTTP", async () => {
    const forged = setup({
      text: `${JSON.stringify(baseConfig({ artifacts: { readable: ["src"] } }), null, 2)}\n`,
    });
    const f = await open(forged.h);
    const fr = await f.call("comforge_issue", { repository: "widgets", number: 1 });
    expect(fr.json.result.isError).toBe(true);
    expect(JSON.stringify(fr.json)).toContain("config-mismatch");

    const pinned = setup({
      binding: { configSha256: createHash("sha256").update("other", "utf8").digest("hex") },
    });
    const p = await open(pinned.h);
    const pr = await p.call("comforge_issue", { repository: "widgets", number: 1 });
    expect(JSON.stringify(pr.json)).toContain("config-mismatch");
  });

  test("remote bindings without a remote host are a construction error", () => {
    expect(() =>
      createHttpHandler({
        repositories: [],
        remoteRepositories: [{ id: "widgets", owner: "acme", name: "widgets" }],
        host: {
          runtime: () => {
            throw new Error("x");
          },
        },
        authenticate: () => null,
        allowedHosts: [HOST],
        allowedOrigins: [],
      }),
    ).toThrow(/remote host/);
  });
});
