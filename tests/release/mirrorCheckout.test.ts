import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// the release candidate job prepares its mirror checkout through
// git, not an anonymous REST call (which shares the runner address's unauthenticated limit and
// failed once with HTTP 403). No credential is involved either way.

const REPO = path.resolve(import.meta.dir, "../..");
const SCRIPT = path.join(REPO, "tooling/release/prepareMirrorCheckout.sh");
const work = mkdtempSync(path.join(tmpdir(), "mirror-checkout-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

const home = path.join(work, "gitconfig");
writeFileSync(home, "[init]\n\tdefaultBranch = main\n");
const env = {
  PATH: process.env.PATH ?? "",
  HOME: work,
  GIT_CONFIG_GLOBAL: home,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "T",
  GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "T",
  GIT_COMMITTER_EMAIL: "t@example.invalid",
} as unknown as NodeJS.ProcessEnv;
const run = (cmd: string, args: string[], cwd = work) => spawnSync(cmd, args, { cwd, env, encoding: "utf8" });
const prepare = (url: string, dest: string) => run("bash", [SCRIPT, url, path.join(work, dest)]);

test("the candidate job makes no anonymous REST call to read the mirror", () => {
  const text = readFileSync(path.join(REPO, ".github/workflows/release.yml"), "utf8");
  const candidate = text.slice(text.indexOf("Prepare repository checkout (anonymous)"), text.indexOf("Build, plan and show the candidate"));
  expect(candidate).toContain("tooling/release/prepareMirrorCheckout.sh");
  expect(candidate).not.toContain("api.github.com");
  const script = readFileSync(SCRIPT, "utf8")
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n");
  expect(script).not.toMatch(/api\.github\.com\/repos|curl|TOKEN|Authorization/);
});

test("an existing repository is cloned, an empty one too", () => {
  const bare = path.join(work, "full.git");
  run("git", ["init", "-q", "--bare", bare]);
  const seed = path.join(work, "seed");
  run("git", ["clone", "-q", bare, seed]);
  writeFileSync(path.join(seed, "a"), "a");
  run("git", ["add", "a"], seed);
  run("git", ["commit", "-qm", "a"], seed);
  run("git", ["push", "-q", "origin", "main"], seed);
  expect(prepare(bare, "out-full").status).toBe(0);
  expect(existsSync(path.join(work, "out-full", "a"))).toBe(true);
  const empty = path.join(work, "empty.git");
  run("git", ["init", "-q", "--bare", empty]);
  expect(prepare(empty, "out-empty").status).toBe(0);
  expect(existsSync(path.join(work, "out-empty", ".git"))).toBe(true);
});

test("a missing repository becomes an empty local repository on main", () => {
  const r = prepare(path.join(work, "missing.git"), "out-missing");
  expect(r.status).toBe(0);
  expect(run("git", ["symbolic-ref", "HEAD"], path.join(work, "out-missing")).stdout.trim()).toBe("refs/heads/main");
});

test("an unreachable server fails with an error instead of guessing", () => {
  const r = prepare("http://127.0.0.1:9/nothing.git", "out-unreachable");
  expect(r.status).toBe(1);
  expect(r.stdout).toContain("::error::mirror http://127.0.0.1:9/nothing.git: unreachable");
  expect(existsSync(path.join(work, "out-unreachable"))).toBe(false);
});

// Review L1: each failure class gets its own annotation, and nothing secret is printed.
test.each([
  [401, "access refused"],
  [403, "access refused"],
  [429, "rate limited"],
])("an HTTP %i from the server is reported as %s, with the credential in the URL masked", async (status, label) => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("no", { status }) });
  try {
    const url = `http://someone:ghp_${"x".repeat(36)}@127.0.0.1:${server.port}/acme/mirror.git`;
    const proc = Bun.spawn(["bash", SCRIPT, url, path.join(work, `out-${status}`)], { env, stdout: "pipe", stderr: "pipe" });
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    expect(code).toBe(1);
    expect(out).toContain(`::error::mirror http://***@127.0.0.1:${server.port}/acme/mirror.git: ${label}`);
    expect(out).not.toContain("ghp_");
    expect(out).not.toContain("someone");
    expect(existsSync(path.join(work, `out-${status}`))).toBe(false);
  } finally {
    server.stop(true);
  }
});

test("an empty and a missing mirror are announced as notices, not silently", () => {
  const empty = path.join(work, "notice-empty.git");
  run("git", ["init", "-q", "--bare", empty]);
  expect(prepare(empty, "notice-out-empty").stdout).toContain("::notice::mirror");
  expect(prepare(path.join(work, "notice-missing.git"), "notice-out-missing").stdout).toContain("does not exist");
});
