import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { main, type Runtime, spawnRun } from "@comforge/cli";
import { createSpecificationProtocol } from "@comforge/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { BOT, createFakeGitHub, TOKEN } from "../../github/test/fakeGitHub.ts";
import type { Principal } from "../src/contracts.ts";
import type { HostServices, RepositoryBinding } from "../src/host.ts";
import { type ComforgeMcpOptions, createComforgeMcpServer } from "../src/server.ts";

/**
 * A synthetic world: a bare Git remote, a primary clone with a committed configuration, the
 * @comforge/github test fake for every GitHub request, and the PUBLISHED @comforge/cli (the
 * package under test consumes nothing else). No network, no real credential.
 */

export const SPEC = {
  digestScheme: "acme-spec/v1",
  markerNamespace: "acme-spec",
  publisherName: "Acme Specs",
  publishToolName: "acme_create_issue",
} as const;

export const baseConfig = (extra: Record<string, unknown> = {}) => ({
  schema: "comforge-config/v1",
  repository: { owner: "acme", name: "widgets", baseBranch: "main", remote: "origin" },
  validation: { commands: [{ name: "check", run: ["sh", "check.sh"] }] },
  evidence: { reportDir: "docs/comforge" },
  specification: { required: true, ...SPEC },
  completion: {
    scheme: "acme-completion/v1",
    markerNamespace: "acme-lifecycle",
    runner: { id: "test-agent", label: "test agent" },
  },
  security: {
    credentials: { source: "env", variable: "ACME_TOKEN" },
    authorization: { mode: "operator" },
  },
  ...extra,
});

export function gitEnv(home: string): Record<string, string> {
  const globalConfig = path.join(home, "gitconfig");
  writeFileSync(globalConfig, "[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n");
  return {
    PATH: process.env.PATH ?? "",
    HOME: home,
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.invalid",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.invalid",
  };
}

export function createWorld(options: { config?: Record<string, unknown> } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "comforge-mcp-"));
  const home = path.join(root, "home");
  mkdirSync(home);
  const env = gitEnv(home);
  const sh = (cwd: string, ...args: string[]) => {
    const r = spawnRun(args[0] as string, args.slice(1), { cwd, env });
    if (r.status !== 0) throw new Error(`${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const remote = path.join(root, "remote.git");
  const primary = path.join(root, "widgets");
  sh(root, "git", "init", "--quiet", "--bare", remote);
  sh(root, "git", "clone", "--quiet", remote, primary);
  const commitFile = (cwd: string, file: string, content: string, message: string) => {
    mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
    writeFileSync(path.join(cwd, file), content);
    sh(cwd, "git", "add", file);
    sh(cwd, "git", "commit", "--quiet", "-m", message);
    return sh(cwd, "git", "rev-parse", "HEAD");
  };
  commitFile(primary, "check.sh", "#!/bin/sh\nexit 0\n", "initial");
  commitFile(
    primary,
    "comforge.config.json",
    `${JSON.stringify(options.config ?? baseConfig(), null, 2)}\n`,
    "configure comforge",
  );
  sh(primary, "git", "push", "--quiet", "origin", "main");

  const gh = createFakeGitHub();
  const checkRuns = new Map<
    string,
    { name: string; status: string; conclusion: string | null }[]
  >();
  const files = new Map<
    number,
    {
      filename: string;
      status: string;
      additions: number;
      deletions: number;
      changes: number;
      patch?: string;
    }[]
  >();
  const ok = (body: unknown) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  gh.readOverrides.push((p) => {
    if (p === "/user") return ok({ login: BOT });
    let m = p.match(/^\/repos\/acme\/widgets\/git\/ref\/heads\/(.+)$/);
    if (m) {
      const r = spawnRun("git", ["rev-parse", "--verify", `refs/heads/${m[1]}`], {
        cwd: remote,
        env,
      });
      if (r.status === 0) gh.refs.set(m[1] as string, r.stdout.trim());
      return undefined;
    }
    m = p.match(/^\/repos\/acme\/widgets\/commits\/([0-9a-f]{40})\/check-runs$/);
    if (m) {
      const runs = checkRuns.get(m[1] as string) ?? [];
      return ok({
        total_count: runs.length,
        check_runs: runs.map((r, i) => ({
          id: i + 1,
          head_sha: m?.[1],
          app: { slug: "ci" },
          ...r,
        })),
      });
    }
    m = p.match(/^\/repos\/acme\/widgets\/pulls\/(\d+)\/files$/);
    if (m) return ok(files.get(Number(m[1])) ?? []);
    return undefined;
  });

  const clock = { now: 1_900_000_000_000 };
  const rt = (cwd = primary, extra: Record<string, string | undefined> = {}): Runtime => ({
    cwd,
    env: { ...env, ACME_TOKEN: TOKEN, ...extra },
    now: () => clock.now,
    fetchImpl: gh.fetchImpl,
    run: spawnRun,
  });
  const spec = createSpecificationProtocol(SPEC);
  const specIssue = (ticket: string, body = `Build ${ticket}.`) => {
    const title = `${ticket} — specification`;
    const digest = spec.specificationDigest({ ticketId: ticket, title, body });
    return gh.seedIssue({
      title,
      body: spec.composeIssueBody({ ticketId: ticket, body, digest, keyDigest: "0".repeat(32) }),
    }).number;
  };
  const binding: RepositoryBinding = {
    id: "widgets",
    root: primary,
    owner: "acme",
    name: "widgets",
  };
  const host = (extra: Partial<HostServices> = {}): HostServices => ({
    runtime: (b) => rt(b.root),
    ...extra,
  });

  /** The published CLI on the same repository: what a human running `comforge` sees. */
  const cli = async (args: string[], cwd = primary) => {
    let out = "";
    const code = await main([...args, "--json"], rt(cwd), {
      out: (t) => {
        out += t;
      },
      err: (t) => {
        out += t;
      },
    });
    return { code, json: JSON.parse(out) as Record<string, unknown> };
  };

  return {
    root,
    remote,
    primary,
    gh,
    env,
    clock,
    rt,
    sh,
    commitFile,
    specIssue,
    binding,
    host,
    cli,
    checkRuns,
    files,
    dispose: () => rmSync(root, { recursive: true, force: true }),
  };
}

export type World = ReturnType<typeof createWorld>;

export const principal = (
  profiles: Principal["profiles"],
  repositories: Principal["repositories"] = "*",
): Principal => ({
  id: `test:${profiles.join("+")}`,
  profiles,
  repositories,
});

/** An MCP client connected in-process to a server built from `options`. */
export async function connect(options: ComforgeMcpOptions) {
  const server = createComforgeMcpServer(options);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(b);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args });
    const text = (r.content as { type: string; text: string }[])[0]?.text ?? "null";
    // biome-ignore lint/suspicious/noExplicitAny: tests read results by path
    let body: any = text;
    try {
      body = JSON.parse(text);
    } catch {
      body = { raw: text };
    }
    return { isError: r.isError === true, body, structured: r.structuredContent, text };
  };
  return { client, server, call, close: () => client.close() };
}

export { BOT, TOKEN };
