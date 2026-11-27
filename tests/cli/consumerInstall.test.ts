import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createSpecificationProtocol } from "@comforge/core";
import { BOT, createFakeGitHub, TOKEN } from "../../packages/github/test/fakeGitHub";
import { packCandidates } from "../../tooling/release/candidates";
import { packDistribution } from "../../tooling/release/pack";

// COMFORGE-PORTABILITY-001.cli: @comforge/cli as a consumer installs it. The distribution
// tarball and its four published dependencies are installed with `npm install --offline`
// into a copy of the independent example; npm links the `comforge` executable. The example
// (a Makefile project, no TypeScript) and the full governed workflow then run through that
// installed executable, as separate processes, under each runtime in COMFORGE_TEST_RUNTIMES
// (default node,bun), against a local Git remote and a synthetic GitHub served over HTTP on
// 127.0.0.1. No real GitHub, no real credential.

const REPO = path.resolve(import.meta.dir, "../..");
const RUNTIMES = (process.env.COMFORGE_TEST_RUNTIMES ?? "node,bun").split(",").filter(Boolean);
let work: string;
let consumer: string;
let packed: { tarball: string; files: string[] };

beforeAll(() => {
  work = mkdtempSync(path.join(tmpdir(), "comforge-cli-consumer-"));
  packed = packDistribution(path.join(work, "pack"), path.join(REPO, "packages", "cli"));
  const deps = path.join(work, "deps");
  mkdirSync(deps);
  const tarballs: Record<string, string> = {};
  // The CLI candidate pins unreleased core and github candidates: they come from this
  // repository's candidate wiring, and every other dependency from the installed releases.
  const candidates = packCandidates("@comforge/cli", deps);
  Object.assign(tarballs, candidates);
  // Siblings are installed from their built distributions (what a release ships), never from
  // the workspace links (TypeScript source); zod from the installed release, offline.
  const declared = JSON.parse(readFileSync(path.join(REPO, "packages", "cli", "package.json"), "utf8")).dependencies as Record<string, string>;
  const released = Object.keys(declared).filter((d) => d.startsWith("@comforge/") && !(d in candidates));
  for (const dep of [...released, "zod"]) {
    if (dep.startsWith("@comforge/")) {
      tarballs[dep] = `file:${packDistribution(deps, path.join(REPO, "packages", dep.slice("@comforge/".length))).tarball}`;
      continue;
    }
    const r = spawnSync("npm", ["pack", "--silent", path.join(REPO, "node_modules", dep)], { cwd: deps, encoding: "utf8" });
    if (r.status !== 0) throw new Error(r.stderr);
    tarballs[dep] = `file:${path.join(deps, r.stdout.trim())}`;
  }
  consumer = path.join(work, "consumer");
  cpSync(path.join(REPO, "examples", "cli-consumer"), consumer, { recursive: true });
  const manifest = JSON.parse(readFileSync(path.join(consumer, "package.json"), "utf8"));
  manifest.dependencies = { "@comforge/cli": `file:${packed.tarball}`, ...tarballs };
  manifest.overrides = { ...candidates, ...Object.fromEntries(released.map((d) => [d, tarballs[d]])) };
  writeFileSync(path.join(consumer, "package.json"), JSON.stringify(manifest));
  const install = spawnSync("npm", ["install", "--offline", "--no-audit", "--no-fund", "--ignore-scripts"], { cwd: consumer, encoding: "utf8" });
  if (install.status !== 0) throw new Error(install.stderr);
}, 300_000);
afterAll(() => rmSync(work, { recursive: true, force: true }));

describe("@comforge/cli installed from its distribution tarball", () => {
  test("the tarball ships the manifest, compiled dist with declarations, README and llms.txt only", () => {
    const files = packed.files.map((f) => f.replace(/^package\//, ""));
    expect(files.filter((f) => !f.startsWith("dist/")).sort()).toEqual(["README.md", "llms.txt", "package.json"]);
    for (const m of ["cli", "index", "config", "routing", "commands/lifecycle", "commands/delivery"])
      for (const ext of [".js", ".d.ts"]) expect(files).toContain(`dist/${m}${ext}`);
    expect(files.some((f) => f.startsWith("src/"))).toBe(false);
  });

  test("manifest: an executable, typed exports and exact published Comforge dependencies", () => {
    const manifest = JSON.parse(readFileSync(path.join(consumer, "node_modules", "@comforge", "cli", "package.json"), "utf8"));
    expect(manifest.bin).toEqual({ comforge: "./dist/cli.js" });
    expect(manifest.exports["."]).toEqual({ types: "./dist/index.d.ts", default: "./dist/index.js" });
    // Exactly the source manifest's dependencies; every Comforge sibling is an exact version.
    const source = JSON.parse(readFileSync(path.join(REPO, "packages", "cli", "package.json"), "utf8"));
    expect(manifest.dependencies).toEqual(source.dependencies);
    for (const [name, version] of Object.entries(manifest.dependencies as Record<string, string>))
      if (name.startsWith("@comforge/")) expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    const bin = path.join(consumer, "node_modules", ".bin", "comforge");
    expect(lstatSync(bin).isSymbolicLink()).toBe(true);
    expect(readFileSync(bin, "utf8").startsWith("#!/usr/bin/env node\n")).toBe(true);
    expect(statSync(bin).mode & 0o111).not.toBe(0);
  });

  test("nothing private ships: no portfolio identifiers, application imports, paths or credentials", () => {
    const root = path.join(consumer, "node_modules", "@comforge", "cli");
    const text = packed.files.map((f) => readFileSync(path.join(root, f.replace(/^package\//, "")), "utf8")).join("\n");
    for (const pattern of [
      /vikramrao1994\/portfolio/,
      /@\/lib\//,
      /engineering-gateway/,
      /\/Users\//,
      /gh[pousr]_[A-Za-z0-9]{30,}/,
      /portfolio-lifecycle|portfolio-mcp/,
    ])
      expect(pattern.test(text)).toBe(false);
  });

  test.each(RUNTIMES)("the example (a Makefile project) passes under %s", (runtime) => {
    const r = spawnSync(runtime, ["demo.mjs"], {
      cwd: consumer,
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" } as unknown as NodeJS.ProcessEnv,
    });
    const out = JSON.parse(r.stdout) as { runtime: string; checks: unknown[]; failed: string[] };
    expect(out.failed).toEqual([]);
    expect(out.checks).toHaveLength(13);
    expect(r.status).toBe(0);
  }, 120_000);

  test.each(RUNTIMES)("the installed package exports the service API (R10) under %s", (runtime) => {
    // Services built from an injected runtime and repository: no process cwd, environment or gh.
    const script = [
      'import { createLifecycleServices, migrate, stateStoreOn, PROVISION_RESULT_SCHEMA } from "@comforge/cli";',
      "const c = new AbortController(); c.abort('test');",
      "const s = createLifecycleServices({ runtime: { cwd: '/', env: {}, now: Date.now, run: () => ({ status: 0, stdout: '', stderr: '', timedOut: false }) }, repository: { root: '/nonexistent', commonDir: '/nonexistent/.git' }, signal: c.signal });",
      "const r = await s.status({});",
      "console.log(JSON.stringify({ services: Object.keys(s).sort(), migrate: typeof migrate, store: typeof stateStoreOn, schema: PROVISION_RESULT_SCHEMA, status: r.ok }));",
    ].join("\n");
    writeFileSync(path.join(consumer, "services.mjs"), script);
    const r = spawnSync(runtime, ["services.mjs"], {
      cwd: consumer,
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" } as unknown as NodeJS.ProcessEnv,
    });
    expect(r.stderr).toBe("");
    expect(JSON.parse(r.stdout)).toEqual({
      services: [
        "advisoryReviews",
        "artifact",
        "cleanup",
        "complete",
        "deliver",
        "issueComments",
        "migrate",
        "publish",
        "publishReview",
        "publishSpecification",
        "pullRequests",
        "recover",
        "revise",
        "start",
        "status",
        "verify",
      ],
      migrate: "function",
      store: "function",
      schema: "comforge-provision-result/v1",
      status: true,
    });
  }, 120_000);
});

// --- the full governed workflow through the installed executable ---------------------------

const SPEC = { digestScheme: "acme-spec/v1", markerNamespace: "acme-spec", publisherName: "Acme Specs", publishToolName: "acme_create_issue" };

const hang = { next: false, seen: null as null | (() => void) };
function serveGitHub(gh: ReturnType<typeof createFakeGitHub>) {
  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "PATCH" && hang.next) {
        // Arrived, never applied, never answered: the sending process is killed while waiting.
        hang.next = false;
        hang.seen?.();
        return new Promise<Response>(() => {});
      }
      const body = req.method === "GET" ? undefined : await req.text();
      return gh.fetchImpl(`https://api.github.com${url.pathname}${url.search}`, { method: req.method, headers: Object.fromEntries(req.headers), body });
    },
  });
}

describe.each(RUNTIMES)("the governed workflow through the installed executable under %s", (runtime) => {
  test("init, start, verify, deliver, cleanup: one PR, one completion record, no credential at rest", async () => {
    const root = mkdtempSync(path.join(work, `flow-${path.basename(runtime)}-`));
    const home = path.join(root, "home");
    mkdirSync(home);
    const remote = path.join(root, "remote.git");
    writeFileSync(
      path.join(home, "gitconfig"),
      `[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n[url "${remote}"]\n\tinsteadOf = https://github.com/acme/widgets.git\n`,
    );
    const env = {
      PATH: process.env.PATH ?? "",
      HOME: home,
      GIT_CONFIG_GLOBAL: path.join(home, "gitconfig"),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "T",
      GIT_AUTHOR_EMAIL: "t@example.invalid",
      GIT_COMMITTER_NAME: "T",
      GIT_COMMITTER_EMAIL: "t@example.invalid",
      ACME_TOKEN: TOKEN,
    } as unknown as NodeJS.ProcessEnv;
    const sh = (cwd: string, ...args: string[]) => {
      const r = spawnSync(args[0] as string, args.slice(1), { cwd, env, encoding: "utf8" });
      if (r.status !== 0) throw new Error(`${args.join(" ")}: ${r.stderr}`);
      return r.stdout.trim();
    };
    const bin = path.join(consumer, "node_modules", ".bin", "comforge");
    const transcript: string[] = [];
    const comforge = async (cwd: string, ...args: string[]) => {
      const proc = Bun.spawn([runtime, bin, ...args, "--json"], { cwd, env, stdout: "pipe", stderr: "pipe" });
      const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      transcript.push(out, err);
      return { code, json: JSON.parse(out || err) };
    };
    const gh = createFakeGitHub();
    gh.readOverrides.push((p) => {
      if (p === "/user") return new Response(JSON.stringify({ login: BOT }), { status: 200 });
      const m = p.match(/^\/repos\/acme\/widgets\/git\/ref\/heads\/(.+)$/);
      if (m) {
        const r = spawnSync("git", ["rev-parse", "--verify", `refs/heads/${m[1]}`], { cwd: remote, env, encoding: "utf8" });
        if (r.status === 0) gh.refs.set(m[1] as string, r.stdout.trim());
      }
      return undefined;
    });
    const server = serveGitHub(gh);
    try {
      sh(root, "git", "init", "--quiet", "--bare", remote);
      const repo = path.join(root, "widgets");
      sh(root, "git", "clone", "--quiet", "https://github.com/acme/widgets.git", repo);
      writeFileSync(path.join(repo, "Makefile"), "test:\n\tsh tests.sh\n");
      writeFileSync(path.join(repo, "tests.sh"), "#!/bin/sh\nexit 0\n");
      sh(repo, "git", "add", ".");
      sh(repo, "git", "commit", "--quiet", "-m", "initial");
      sh(repo, "git", "push", "--quiet", "origin", "main");

      const init = await comforge(repo, "init", "--write");
      expect([init.code, init.json.content.repository]).toEqual([0, { owner: "acme", name: "widgets", baseBranch: "main", remote: "origin" }]);
      const configFile = path.join(repo, "comforge.config.json");
      const config = JSON.parse(readFileSync(configFile, "utf8"));
      config.repository.apiOrigin = `http://127.0.0.1:${server.port}`;
      config.specification = { required: true, ...SPEC };
      config.completion = { scheme: "acme-completion/v1", markerNamespace: "acme-lifecycle", runner: { id: "test-agent", label: "test agent" } };
      config.security = { credentials: { source: "env", variable: "ACME_TOKEN" }, authorization: { mode: "operator" } };
      writeFileSync(configFile, JSON.stringify(config, null, 2));
      sh(repo, "git", "add", "comforge.config.json");
      sh(repo, "git", "commit", "--quiet", "-m", "chore: configure comforge");
      sh(repo, "git", "push", "--quiet", "origin", "main");
      expect((await comforge(repo, "doctor")).json.ok).toBe(true);

      const spec = createSpecificationProtocol(SPEC);
      const title = "DEMO-001 — gadget";
      const text = "Build the gadget.";
      const digest = spec.specificationDigest({ ticketId: "DEMO-001", title, body: text });
      const issue = gh.seedIssue({ title, body: spec.composeIssueBody({ ticketId: "DEMO-001", body: text, digest, keyDigest: "0".repeat(32) }) }).number;

      const started = await comforge(repo, "start", "DEMO-001", "--issue", String(issue));
      expect(started.code).toBe(0);
      const checkout = started.json.checkout as string;
      writeFileSync(path.join(checkout, "gadget.txt"), "gadget\n");
      sh(checkout, "git", "add", "gadget.txt");
      sh(checkout, "git", "commit", "--quiet", "-m", "feat: gadget\n\nTicket: DEMO-001");
      expect((await comforge(repo, "verify", "DEMO-001")).json.status).toBe("PASS");
      const head = sh(checkout, "git", "rev-parse", "HEAD");
      const result = path.join(root, "result.json");
      writeFileSync(
        result,
        JSON.stringify({
          contract: "acme-completion/v1",
          issueNumber: issue,
          ticketId: "DEMO-001",
          specificationDigest: digest,
          issueType: "implementation",
          outcome: "completed",
          sourceRevision: head,
          execution: { runner: "test-agent", model: "m" },
          summary: "Built the gadget.",
          sections: { changed_behavior: "A gadget exists." },
          findings: [],
          changedArtifacts: [],
          evidence: [],
          validation: [{ gate: "make", command: "make test", status: "PASS" }],
          limitations: [],
          nextSteps: [],
        }),
      );
      const delivered = await comforge(repo, "deliver", "DEMO-001", "--title", "Gadget", "--result", result, "--execute");
      expect([delivered.code, delivered.json.delivery]).toEqual([0, "complete"]);
      const pr = delivered.json.pullRequest as number;
      expect(gh.pulls.size).toBe(1);
      expect([...gh.comments.values()].filter((c) => c.issue === issue)).toHaveLength(1);
      expect(gh.pulls.get(pr)?.body).toContain(`issuecomment-`);

      // Review M13, as independent processes of the installed executable.
      const patches = () => gh.writes().filter((w) => w.method === "PATCH").length;
      const undo = () => {
        const p = gh.pulls.get(pr);
        if (p) Object.assign(p, { body: "someone else's edit", updated_at: "2026-01-01T00:00:00Z" });
      };
      undo();
      const before = patches();
      const racers = await Promise.all([
        comforge(repo, "publish", "DEMO-001", "--title", "Gadget", "--execute"),
        comforge(repo, "publish", "DEMO-001", "--title", "Gadget", "--execute"),
      ]);
      expect(racers.map((r) => r.code)).toContain(0);
      expect(patches()).toBe(before + 1);
      undo();
      const seen = new Promise<void>((resolve) => {
        hang.seen = resolve;
      });
      hang.next = true;
      const dying = Bun.spawn([runtime, bin, "publish", "DEMO-001", "--title", "Gadget", "--execute", "--json"], {
        cwd: repo,
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      await Promise.race([seen, dying.exited.then(() => Promise.reject(new Error("the publisher exited before its PATCH")))]);
      dying.kill("SIGKILL");
      await dying.exited;
      const afterKill = patches();
      const inLease = await comforge(repo, "publish", "DEMO-001", "--title", "Gadget", "--execute");
      expect([inLease.code, inLease.json.error]).toEqual([1, "conflict"]);
      expect(patches()).toBe(afterKill);
      const pull = gh.pulls.get(pr);
      if (pull) Object.assign(pull, { body: "x", state: "closed", merged: true, merged_at: "2026-01-02T00:00:00Z" });
      sh(remote, "git", "update-ref", "refs/heads/main", head); // the merge reaches main
      // The killed writer's PATCH is unresolved: cleanup refuses rather than retire the initiative
      // whose recover would settle it (0.2.0 candidate, review R8), and keeps the checkout.
      const cleanup = await comforge(repo, "cleanup", String(pr), "--execute");
      expect([cleanup.code, cleanup.json.error]).toEqual([3, "ambiguous"]);
      expect(existsSync(checkout)).toBe(true);
      expect(transcript.join("\n")).not.toContain(TOKEN);
      const state = path.join(repo, ".git", "comforge");
      for (const f of readdirSync(state, { recursive: true }).map(String))
        if (statSync(path.join(state, f)).isFile()) expect(readFileSync(path.join(state, f), "utf8")).not.toContain(TOKEN);
    } finally {
      server.stop(true);
    }
  }, 180_000);
});
