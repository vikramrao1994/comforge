/**
 * `bun tooling/dogfood.ts [--out FILE] [--runtime node|bun]`
 *
 * Governed operations of the PUBLISHED harness (harness/: the exact `@comforge/cli` release
 * pinned there, never the workspace candidates) against a SYNTHETIC GitHub: the fake HTTP
 * server the package tests use, on 127.0.0.1, with a fake token. Nothing reaches github.com
 * and no real credential is read; this is not evidence of a live operation.
 *
 * In a throwaway repository with a local bare origin it runs: init → start (specification
 * verified) → verify → publish whose answer is lost after GitHub created the pull request →
 * recover (reconciles from the target, no second pull request) → deliver (publication,
 * completion record, read back) → advisory review published by a separate reviewer identity →
 * review list (integrity verified, trusted provenance) → and checks that the token appears in
 * no output and no file of the local state.
 *
 * Exit 0 only when every step passes.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createSpecificationProtocol } from "@comforge/core";
import { BOT, createFakeGitHub, TOKEN } from "../packages/github/test/fakeGitHub";

const REPO = path.resolve(import.meta.dir, "..");
export const DOGFOOD_SCHEMA = "comforge-dogfood-governed/v1";
const HARNESS_CLI = path.join(REPO, "harness/node_modules/@comforge/cli/dist/cli.js");
const SPEC = {
  digestScheme: "acme-spec/v1",
  markerNamespace: "acme-spec",
  publisherName: "Acme Specs",
  publishToolName: "acme_create_issue",
};
const REVIEWER = "acme-reviewer[bot]";
const TICKET = "DEMO-001";

type Step = { step: string; pass: boolean; detail: string };

export async function dogfood(
  runtime: string,
): Promise<{ pass: boolean; harness: string; steps: Step[] }> {
  const harnessVersion = (
    JSON.parse(
      readFileSync(path.join(REPO, "harness/node_modules/@comforge/cli/package.json"), "utf8"),
    ) as {
      version: string;
    }
  ).version;
  const root = mkdtempSync(path.join(tmpdir(), "comforge-dogfood-"));
  const steps: Step[] = [];
  const record = (step: string, pass: boolean, detail: string) =>
    steps.push({ step, pass, detail });
  const remote = path.join(root, "remote.git");
  const home = path.join(root, "home");
  spawnSync("mkdir", ["-p", home]);
  writeFileSync(
    path.join(home, "gitconfig"),
    `[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n[url "${remote}"]\n\tinsteadOf = https://github.com/acme/widgets.git\n`,
  );
  const env = {
    PATH: process.env.PATH ?? "",
    HOME: home,
    GIT_CONFIG_GLOBAL: path.join(home, "gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Dogfood",
    GIT_AUTHOR_EMAIL: "dogfood@example.invalid",
    GIT_COMMITTER_NAME: "Dogfood",
    GIT_COMMITTER_EMAIL: "dogfood@example.invalid",
    ACME_TOKEN: TOKEN,
  } as unknown as NodeJS.ProcessEnv;
  const sh = (cwd: string, ...args: string[]) => {
    const r = spawnSync(args[0] as string, args.slice(1), { cwd, env, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const transcript: string[] = [];
  const comforge = async (cwd: string, ...args: string[]) => {
    const proc = Bun.spawn([runtime, HARNESS_CLI, ...args, "--json"], {
      cwd,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    transcript.push(out, err);
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(out || err);
    } catch {
      json = { unparsed: (out || err).slice(0, 200) };
    }
    return { code, json };
  };

  const gh = createFakeGitHub();
  let login = BOT;
  gh.readOverrides.push((p) => {
    if (p === "/user") return new Response(JSON.stringify({ login }), { status: 200 });
    const m = p.match(/^\/repos\/acme\/widgets\/git\/ref\/heads\/(.+)$/);
    if (m) {
      const r = spawnSync("git", ["rev-parse", "--verify", `refs/heads/${m[1]}`], {
        cwd: remote,
        env,
        encoding: "utf8",
      });
      if (r.status === 0) gh.refs.set(m[1] as string, r.stdout.trim());
    }
    return undefined;
  });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const body = req.method === "GET" ? undefined : await req.text();
      try {
        return await gh.fetchImpl(`https://api.github.com${url.pathname}${url.search}`, {
          method: req.method,
          headers: Object.fromEntries(req.headers),
          body,
        });
      } catch {
        // A fault after the write was applied: the client sees a failed answer.
        return new Response("upstream connection reset", { status: 502 });
      }
    },
  });
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
    record("init writes a configuration", init.code === 0, `exit ${init.code}`);
    const configFile = path.join(repo, "comforge.config.json");
    const config = JSON.parse(readFileSync(configFile, "utf8"));
    config.repository.apiOrigin = `http://127.0.0.1:${server.port}`;
    config.specification = { required: true, ...SPEC };
    config.completion = {
      scheme: "acme-completion/v1",
      markerNamespace: "acme-lifecycle",
      runner: { id: "dogfood", label: "dogfood" },
    };
    config.review = {
      reviewScheme: "acme-review/v1",
      markerNamespace: "acme-review",
      publisherName: "Acme Review",
      publishToolName: "acme_review",
      trustedAuthors: [BOT],
    };
    config.security = {
      ...(config.security ?? {}),
      credentials: { source: "env", variable: "ACME_TOKEN" },
      authorization: { mode: "operator" },
    };
    writeFileSync(configFile, JSON.stringify(config, null, 2));
    sh(repo, "git", "add", "comforge.config.json");
    sh(repo, "git", "commit", "--quiet", "-m", "chore: configure comforge");
    sh(repo, "git", "push", "--quiet", "origin", "main");
    const doctor = await comforge(repo, "doctor");
    record("doctor", doctor.json.ok === true, `ok=${doctor.json.ok}`);

    const spec = createSpecificationProtocol(SPEC);
    const title = `${TICKET} — gadget`;
    const text = "Build the gadget.";
    const digest = spec.specificationDigest({ ticketId: TICKET, title, body: text });
    const issue = gh.seedIssue({
      title,
      body: spec.composeIssueBody({
        ticketId: TICKET,
        body: text,
        digest,
        keyDigest: "0".repeat(32),
      }),
    }).number;
    const started = await comforge(repo, "start", TICKET, "--issue", String(issue));
    record(
      "start verifies the published specification and provisions a checkout",
      started.code === 0,
      `exit ${started.code}`,
    );
    const checkout = started.json.checkout as string;
    writeFileSync(path.join(checkout, "gadget.txt"), "gadget\n");
    sh(checkout, "git", "add", "gadget.txt");
    sh(checkout, "git", "commit", "--quiet", "-m", `feat: gadget\n\nTicket: ${TICKET}`);
    const verified = await comforge(repo, "verify", TICKET);
    record(
      "verify passes on the exact commit",
      verified.json.status === "PASS",
      String(verified.json.status),
    );
    const head = sh(checkout, "git", "rev-parse", "HEAD");

    // The pull request is created, then the answer is lost.
    gh.faults.push("network-after");
    const lost = await comforge(repo, "publish", TICKET, "--title", "Gadget", "--execute");
    const pullPosts = gh
      .writes()
      .filter((w) => w.method === "POST" && w.path.endsWith("/pulls")).length;
    record(
      "publish whose answer is lost after the pull request was created: reconciled, one POST, one pull request",
      gh.faults.length === 0 && pullPosts === 1 && gh.pulls.size === 1,
      `exit ${lost.code} ${String(lost.json.error ?? lost.json.action ?? "")}; POST /pulls ${pullPosts}; pull requests ${gh.pulls.size}`,
    );
    const recovered = await comforge(repo, "recover", TICKET, "--execute");
    record("recover reconciles from the target", recovered.code === 0, `exit ${recovered.code}`);

    const result = path.join(root, "result.json");
    writeFileSync(
      result,
      JSON.stringify({
        contract: "acme-completion/v1",
        issueNumber: issue,
        ticketId: TICKET,
        specificationDigest: digest,
        issueType: "implementation",
        outcome: "completed",
        sourceRevision: head,
        execution: { runner: "dogfood", model: "none" },
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
    const delivered = await comforge(
      repo,
      "deliver",
      TICKET,
      "--title",
      "Gadget",
      "--result",
      result,
      "--execute",
    );
    const pr = delivered.json.pullRequest as number;
    const completions = [...gh.comments.values()].filter((c) => c.issue === issue).length;
    record(
      "deliver: the same pull request, one completion record, read back",
      delivered.code === 0 &&
        delivered.json.delivery === "complete" &&
        gh.pulls.size === 1 &&
        completions === 1,
      `delivery=${delivered.json.delivery} pullRequests=${gh.pulls.size} completionComments=${completions}`,
    );

    // A separate reviewer identity publishes an advisory review of that pull request.
    login = REVIEWER;
    const reviewFile = path.join(root, "review.json");
    writeFileSync(
      reviewFile,
      JSON.stringify({
        prNumber: pr,
        expectedHeadSha: head,
        ticketId: TICKET,
        verdict: "revision_recommended",
        summary: "One thing to fix.",
        findings: [{ id: "H1", severity: "high", title: "A defect", evidence: "See gadget.txt." }],
        idempotencyKey: "dogfood-review-0123456789",
      }),
    );
    const reviewed = await comforge(
      repo,
      "review",
      "publish",
      "--review-file",
      reviewFile,
      "--execute",
    );
    login = BOT;
    record(
      "advisory review published as one PR comment (never a native review)",
      reviewed.code === 0 && gh.reviews.size === 0,
      `exit ${reviewed.code} ${String(reviewed.json.error ?? reviewed.json.action ?? "")}`,
    );
    const listed = await comforge(repo, "review", "list", String(pr));
    const first = (
      listed.json.reviews as { integrity?: string; provenance?: string }[] | undefined
    )?.[0];
    record(
      "review list reads it back with verified integrity",
      first?.integrity === "verified",
      `integrity=${first?.integrity} provenance=${first?.provenance}`,
    );

    const state = path.join(repo, ".git", "comforge");
    const leaked =
      transcript.join("\n").includes(TOKEN) ||
      readdirSync(state, { recursive: true })
        .map(String)
        .some(
          (f) =>
            statSync(path.join(state, f)).isFile() &&
            readFileSync(path.join(state, f), "utf8").includes(TOKEN),
        );
    record(
      "the token appears in no output and no state file",
      !leaked,
      leaked ? "leaked" : "absent",
    );
  } catch (error) {
    record("unexpected failure", false, String((error as Error).message).slice(0, 300));
  } finally {
    server.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
  return { pass: steps.every((s) => s.pass), harness: `@comforge/cli@${harnessVersion}`, steps };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const i = argv.indexOf("--runtime");
  const runtime = i >= 0 ? (argv[i + 1] as string) : "node";
  const r = await dogfood(runtime);
  const report = {
    schema: DOGFOOD_SCHEMA,
    mode: "synthetic",
    note: "Published harness against a fake GitHub on 127.0.0.1 with a fake token: not a live operation.",
    runtime,
    ...r,
  };
  for (const s of r.steps) console.log(`${s.pass ? "ok  " : "FAIL"} ${s.step} — ${s.detail}`);
  console.log(`dogfood ${r.pass ? "PASS" : "FAIL"} (${r.harness}, synthetic GitHub)`);
  const o = argv.indexOf("--out");
  if (o >= 0) writeFileSync(argv[o + 1] as string, `${JSON.stringify(report, null, 2)}\n`);
  process.exit(r.pass ? 0 : 1);
}
