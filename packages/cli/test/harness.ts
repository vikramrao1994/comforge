import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createSpecificationProtocol } from "@comforge/core";
import { BOT, createFakeGitHub, TOKEN } from "../../github/test/fakeGitHub.ts";
import { main } from "../src/cli.ts";
import { type Runtime, spawnRun } from "../src/runtime.ts";

/**
 * A synthetic world for the CLI: a bare Git remote, a primary clone with a committed
 * configuration, and the @comforge/github test fake answering every GitHub request. Branch
 * refs are read from the real remote, so a push is what GitHub sees. Nothing leaves the
 * machine and no real credential exists.
 */

export const SPEC = {
  digestScheme: "acme-spec/v1",
  markerNamespace: "acme-spec",
  publisherName: "Acme Specs",
  publishToolName: "acme_create_issue",
} as const;

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

export interface World {
  root: string;
  remote: string;
  primary: string;
  gh: ReturnType<typeof createFakeGitHub>;
  env: Record<string, string>;
  clock: { now: number };
  rt(cwd?: string, env?: Record<string, string | undefined>): Runtime;
  sh(cwd: string, ...args: string[]): string;
  // biome-ignore lint/suspicious/noExplicitAny: tests read command JSON by path
  cli(args: string[], cwd?: string): Promise<{ code: number; out: string; err: string; json: any }>;
  commitFile(cwd: string, file: string, content: string, message: string): string;
  specIssue(ticket: string, body?: string): number;
  dispose(): void;
}

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

export function createWorld(options: { config?: Record<string, unknown> | null } = {}): World {
  const root = mkdtempSync(path.join(tmpdir(), "comforge-cli-"));
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
  if (options.config !== null)
    commitFile(
      primary,
      "comforge.config.json",
      `${JSON.stringify(options.config ?? baseConfig(), null, 2)}\n`,
      "configure comforge",
    );
  sh(primary, "git", "push", "--quiet", "origin", "main");

  const gh = createFakeGitHub();
  gh.readOverrides.push((p) => {
    if (p === "/user")
      return new Response(JSON.stringify({ login: BOT }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    const m = p.match(/^\/repos\/acme\/widgets\/git\/ref\/heads\/(.+)$/);
    if (m) {
      const r = spawnRun("git", ["rev-parse", "--verify", `refs/heads/${m[1]}`], {
        cwd: remote,
        env,
      });
      if (r.status === 0) gh.refs.set(m[1] as string, r.stdout.trim());
    }
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
  const cli = async (args: string[], cwd = primary) => {
    let out = "";
    let err = "";
    const code = await main([...args, "--json"], rt(cwd), {
      out: (t) => {
        out += t;
      },
      err: (t) => {
        err += t;
      },
    });
    let json: unknown = null;
    try {
      json = JSON.parse(out || err);
    } catch {
      json = null;
    }
    return { code, out, err, json };
  };
  const spec = createSpecificationProtocol(SPEC);
  const specIssue = (ticket: string, body = `Build ${ticket}.`) => {
    const title = `${ticket} — specification`;
    const digest = spec.specificationDigest({ ticketId: ticket, title, body });
    const issue = gh.seedIssue({
      title,
      body: spec.composeIssueBody({ ticketId: ticket, body, digest, keyDigest: "0".repeat(32) }),
    });
    return issue.number;
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
    cli,
    commitFile,
    specIssue,
    dispose: () => rmSync(root, { recursive: true, force: true }),
  };
}

export { BOT, TOKEN };
