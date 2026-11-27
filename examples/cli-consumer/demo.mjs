// Drives the installed `comforge` executable (found on PATH through node_modules/.bin) in a
// throwaway repository. Prints {runtime, checks, failed} as JSON; exits 1 if a check failed.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const runtime = process.versions.bun ? `bun ${process.versions.bun}` : `node ${process.versions.node}`;
const work = mkdtempSync(path.join(tmpdir(), "comforge-example-"));
const home = path.join(work, "home");
mkdirSync(home);
writeFileSync(path.join(home, "gitconfig"), "[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n");
const env = {
  PATH: `${path.join(here, "node_modules", ".bin")}${path.delimiter}${process.env.PATH ?? ""}`,
  HOME: home,
  GIT_CONFIG_GLOBAL: path.join(home, "gitconfig"),
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Example",
  GIT_AUTHOR_EMAIL: "example@example.invalid",
  GIT_COMMITTER_NAME: "Example",
  GIT_COMMITTER_EMAIL: "example@example.invalid",
};
const checks = [];
const check = (id, pass, detail = null) => checks.push({ id, pass: Boolean(pass), ...(detail && !pass ? { detail } : {}) });
const sh = (cwd, cmd, ...args) => {
  const r = spawnSync(cmd, args, { cwd, env, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};
// The executable as a user runs it; under Bun, the same file through the Bun runtime.
const comforge = (cwd, ...args) => {
  const r = process.versions.bun
    ? spawnSync(process.execPath, [path.join(here, "node_modules", ".bin", "comforge"), ...args, "--json"], { cwd, env, encoding: "utf8" })
    : spawnSync("comforge", [...args, "--json"], { cwd, env, encoding: "utf8" });
  let json = null;
  try {
    json = JSON.parse(r.stdout || r.stderr);
  } catch {}
  return { code: r.status, json };
};

try {
  const remote = path.join(work, "remote.git");
  const repo = path.join(work, "gadget");
  sh(work, "git", "init", "--quiet", "--bare", remote);
  sh(work, "git", "clone", "--quiet", remote, repo);
  writeFileSync(path.join(repo, "Makefile"), "test:\n\tsh tests.sh\n");
  writeFileSync(path.join(repo, "tests.sh"), "#!/bin/sh\ntest \"$(cat VERSION)\" != broken\n");
  writeFileSync(path.join(repo, "VERSION"), "1\n");
  sh(repo, "git", "add", ".");
  sh(repo, "git", "commit", "--quiet", "-m", "initial");
  sh(repo, "git", "push", "--quiet", "origin", "main");

  const version = comforge(repo, "--version");
  check("executable-found", version.code === 0);

  const preview = comforge(repo, "init");
  check("init-previews", preview.code === 0 && preview.json.written === false && preview.json.state === "absent");
  check("init-detects-make", JSON.stringify(preview.json.content.validation.commands) === JSON.stringify([{ name: "test", run: ["make", "test"] }]));
  check("init-refuses-without-github-remote", comforge(repo, "init", "--write").code === 1);
  // A non-GitHub remote: the owner fills in the repository, as the preview's note says.
  const config = { ...preview.json.content, repository: { ...preview.json.content.repository, owner: "acme", name: "gadget" } };
  writeFileSync(path.join(repo, "comforge.config.json"), `${JSON.stringify(config, null, 2)}\n`);
  check("init-keeps-edited-config", comforge(repo, "init", "--write").json?.error === "would-overwrite");
  sh(repo, "git", "add", "comforge.config.json");
  sh(repo, "git", "commit", "--quiet", "-m", "chore: configure comforge");
  sh(repo, "git", "push", "--quiet", "origin", "main");

  const doctor = comforge(repo, "doctor");
  check("doctor-ok", doctor.code === 0 && doctor.json.ok === true);

  const started = comforge(repo, "start", "GADGET-1");
  check("start", started.code === 0 && started.json.branch === "agent/gadget-1", started.json);
  const checkout = started.json?.checkout;
  writeFileSync(path.join(checkout, "VERSION"), "2\n");
  sh(checkout, "git", "commit", "--quiet", "-am", "feat: version 2\n\nTicket: GADGET-1");
  const pass = comforge(repo, "verify", "GADGET-1");
  check("verify-pass", pass.code === 0 && pass.json.status === "PASS", pass.json);
  writeFileSync(path.join(checkout, "VERSION"), "broken\n");
  sh(checkout, "git", "commit", "--quiet", "-am", "test: break\n\nTicket: GADGET-1");
  const fail = comforge(repo, "verify", "GADGET-1");
  check("verify-fail", fail.code === 1 && fail.json.status === "FAIL");
  const status = comforge(repo, "status", "GADGET-1");
  check("status", status.code === 0 && status.json.validations.length === 2 && status.json.stage === "started");
  const capabilities = comforge(repo, "capabilities");
  check("capabilities", capabilities.code === 0 && capabilities.json.never.includes("merge"));
  check("publish-refuses-failed-head", comforge(repo, "publish", "GADGET-1", "--title", "x").json?.error === "validation-failed");
  check("state-outside-commits", sh(repo, "git", "status", "--porcelain") === "" && existsSync(path.join(repo, ".git", "comforge", "initiatives")));
} catch (error) {
  check("no-exception", false, String(error));
} finally {
  rmSync(work, { recursive: true, force: true });
}
const failed = checks.filter((c) => !c.pass).map((c) => c.id);
process.stdout.write(`${JSON.stringify({ runtime, checks, failed })}\n`);
process.exitCode = failed.length === 0 ? 0 : 1;
