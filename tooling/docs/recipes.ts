/**
 * `bun tooling/docs/recipes.ts [--recipe NAME] [--runtime node|bun] [--json]` — executes the
 * recipes in `docs/recipes/` exactly as written.
 *
 * A recipe is a Markdown page. Its first line after the title may declare a world:
 *
 *   <!-- recipe: {"world": "github"} -->   a throwaway repository with a local bare origin and a
 *                                           SYNTHETIC GitHub on 127.0.0.1 (the fake server the
 *                                           package tests use); nothing reaches github.com
 *   <!-- recipe: {"world": "repository"} --> this repository's own checkout (read-only steps)
 *
 * Every fenced block whose info string is `sh recipe` runs in order in one bash state (variables
 * and the working directory carry over), with `comforge` and `comforge-mcp` resolving to the
 * PUBLISHED harness (`harness/`, the exact releases pinned there), never the workspace
 * candidates. A block may be preceded by `<!-- recipe-before: {...} -->` (a fixture action:
 * `fault` or `faults` — the next GitHub writes' failures — and `login`) and followed by `<!-- recipe-expect: {...} -->`, checked after it ran:
 * `exit` (of the block's last command), `json` (dotted path → value, of the last JSON document
 * printed on stdout, else stderr), `stdout` / `stderr` (substrings). A block without an
 * expectation must exit 0.
 *
 * No real credential is read; the synthetic token never appears in a recipe.
 */
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { BOT, createFakeGitHub, TOKEN } from "../../packages/github/test/fakeGitHub";

const REPO_ROOT = path.resolve(import.meta.dir, "../..");
export const RECIPES_DIR = path.join(REPO_ROOT, "docs/recipes");
export const RECIPES_SCHEMA = "comforge-recipes/v1";
const HARNESS = path.join(REPO_ROOT, "harness/node_modules");

export type Block = {
  index: number;
  line: number;
  code: string;
  before?: { fault?: string; faults?: string[]; login?: string };
  expect?: { exit?: number; json?: Record<string, unknown>; stdout?: string; stderr?: string };
};
export type Recipe = {
  name: string;
  title: string;
  world: "github" | "repository";
  blocks: Block[];
};
export type StepResult = { block: number; line: number; pass: boolean; detail: string };
export type RecipeResult = {
  recipe: string;
  title: string;
  world: string;
  pass: boolean;
  steps: StepResult[];
};

const JSON_COMMENT = (tag: string) => new RegExp(`^<!--\\s*${tag}:\\s*(\\{.*\\})\\s*-->\\s*$`);

export function parseRecipe(name: string, text: string): Recipe {
  const lines = text.split("\n");
  const title = (lines.find((l) => l.startsWith("# ")) ?? name).replace(/^#\s*/, "");
  let world: Recipe["world"] = "github";
  const blocks: Block[] = [];
  let pendingBefore: Block["before"];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const header = line.match(JSON_COMMENT("recipe"));
    if (header) world = (JSON.parse(header[1] as string) as { world: Recipe["world"] }).world;
    const before = line.match(JSON_COMMENT("recipe-before"));
    if (before) pendingBefore = JSON.parse(before[1] as string);
    const expect = line.match(JSON_COMMENT("recipe-expect"));
    if (expect) {
      const last = blocks.at(-1);
      if (!last) throw new Error(`${name}:${i + 1}: recipe-expect before any block`);
      last.expect = JSON.parse(expect[1] as string);
    }
    if (/^```sh recipe\s*$/.test(line)) {
      const start = i + 1;
      const body: string[] = [];
      for (i = i + 1; i < lines.length && !(lines[i] as string).startsWith("```"); i++)
        body.push(lines[i] as string);
      blocks.push({
        index: blocks.length,
        line: start,
        code: body.join("\n"),
        before: pendingBefore,
      });
      pendingBefore = undefined;
    }
  }
  return { name, title, world, blocks };
}

export function listRecipes(): string[] {
  return readdirSync(RECIPES_DIR)
    .filter((f) => /^\d{2}-.+\.md$/.test(f))
    .sort();
}

function lastJson(text: string): unknown {
  const t = text.trim();
  if (!t) return undefined;
  try {
    return JSON.parse(t);
  } catch {}
  // The last top-level JSON document: from the last line that starts one.
  const lines = t.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!/^[{[]/.test(lines[i] as string)) continue;
    try {
      return JSON.parse(lines.slice(i).join("\n"));
    } catch {}
  }
  return undefined;
}

function at(value: unknown, dotted: string): unknown {
  let v: unknown = value;
  for (const key of dotted.split(".")) {
    if (v === null || typeof v !== "object") return undefined;
    v = Array.isArray(v) && key === "length" ? v.length : (v as Record<string, unknown>)[key];
  }
  return v;
}

/** The synthetic world, its fixture hooks and the bash state the blocks share. */
async function world(kind: Recipe["world"], runtime: string) {
  const root = mkdtempSync(path.join(tmpdir(), "comforge-recipe-"));
  const bin = path.join(root, ".bin");
  const home = path.join(root, ".home");
  mkdirSync(bin);
  mkdirSync(home);
  const runtimePath =
    spawnSync("bash", ["-lc", `command -v ${runtime}`], { encoding: "utf8" }).stdout.trim() ||
    runtime;
  writeFileSync(
    path.join(bin, "comforge"),
    `#!/bin/sh\nexec "${runtimePath}" "${HARNESS}/@comforge/cli/dist/cli.js" "$@"\n`,
  );
  writeFileSync(
    path.join(bin, "comforge-mcp"),
    `#!/bin/sh\nexec "${runtimePath}" "${HARNESS}/@comforge/mcp/dist/bin.js" "$@"\n`,
  );
  chmodSync(path.join(bin, "comforge"), 0o755);
  chmodSync(path.join(bin, "comforge-mcp"), 0o755);
  // Scripts a recipe writes under $WORK import the published packages.
  const work = path.join(root, "work");
  mkdirSync(work);
  symlinkSync(HARNESS, path.join(work, "node_modules"));
  const remote = path.join(root, "remote.git");
  writeFileSync(
    path.join(home, "gitconfig"),
    `[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n[url "${remote}"]\n\tinsteadOf = https://github.com/acme/widgets.git\n`,
  );
  const gh = createFakeGitHub();
  let login = BOT;
  gh.readOverrides.push((p) => {
    if (p === "/user") return new Response(JSON.stringify({ login }), { status: 200 });
    const m = p.match(/^\/repos\/acme\/widgets\/git\/ref\/heads\/(.+)$/);
    const branchSha = (branch: string) => {
      const r = spawnSync("git", ["rev-parse", "--verify", `refs/heads/${branch}`], {
        cwd: remote,
        encoding: "utf8",
      });
      return r.status === 0 ? r.stdout.trim() : null;
    };
    if (m) {
      const sha = branchSha(m[1] as string);
      if (sha) gh.refs.set(m[1] as string, sha);
    }
    // GitHub moves a pull request's head when its branch is pushed; the fake does not.
    const pr = p.match(/^\/repos\/acme\/widgets\/pulls\/(\d+)$/);
    const pull = pr ? gh.pulls.get(Number(pr[1])) : undefined;
    if (pull) {
      const sha = branchSha(pull.head.ref);
      if (sha) pull.head.sha = sha;
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
        return new Response("upstream connection reset", { status: 502 });
      }
    },
  });
  const env: Record<string, string> = {
    PATH: `${bin}:${path.dirname(runtimePath)}:${process.env.PATH ?? ""}`,
    HOME: home,
    GIT_CONFIG_GLOBAL: path.join(home, "gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Recipe",
    GIT_AUTHOR_EMAIL: "recipe@example.invalid",
    GIT_COMMITTER_NAME: "Recipe",
    GIT_COMMITTER_EMAIL: "recipe@example.invalid",
    ROOT: root,
    WORK: work,
    COMFORGE_API_ORIGIN: `http://127.0.0.1:${server.port}`,
    ACME_TOKEN: TOKEN,
  };
  let cwd = kind === "repository" ? REPO_ROOT : root;
  if (kind === "github") {
    const sh = (dir: string, ...args: string[]) => {
      const r = spawnSync(args[0] as string, args.slice(1), { cwd: dir, env, encoding: "utf8" });
      if (r.status !== 0) throw new Error(`${args.join(" ")}: ${r.stderr}`);
    };
    sh(root, "git", "init", "--quiet", "--bare", remote);
    const repo = path.join(root, "widgets");
    sh(root, "git", "clone", "--quiet", "https://github.com/acme/widgets.git", repo);
    writeFileSync(path.join(repo, "README.md"), "# widgets\n");
    sh(repo, "git", "add", ".");
    sh(repo, "git", "commit", "--quiet", "-m", "initial");
    sh(repo, "git", "push", "--quiet", "origin", "main");
    env.REPO = repo;
    cwd = repo;
  }
  const state = path.join(root, ".state");
  const pwdFile = path.join(root, ".pwd");
  writeFileSync(state, "");
  writeFileSync(pwdFile, cwd);
  // Asynchronous: the synthetic GitHub is served from this process, so a blocking spawn
  // would leave every request of the child unanswered.
  const run = async (code: string) => {
    const script = `set -a\nsource "${state}"\ncd "$(cat "${pwdFile}")"\n${code}\n__rc=$?\nexport -p > "${state}"\npwd > "${pwdFile}"\nexit $__rc\n`;
    const proc = Bun.spawn(["bash", "--noprofile", "--norc", "-c", script], {
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const timer = setTimeout(() => proc.kill(), 300_000);
    const [stdout, stderr, status] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    clearTimeout(timer);
    return { stdout, stderr, status };
  };
  const hook = (before: Block["before"]) => {
    if (before?.fault) gh.faults.push(before.fault as never);
    for (const f of before?.faults ?? []) gh.faults.push(f as never);
    if (before?.login) login = before.login;
  };
  const dispose = () => {
    server.stop(true);
    rmSync(root, { recursive: true, force: true });
  };
  return { run, hook, dispose, gh, token: TOKEN };
}

export async function runRecipe(recipe: Recipe, runtime = "node"): Promise<RecipeResult> {
  const w = await world(recipe.world, runtime);
  const steps: StepResult[] = [];
  try {
    for (const block of recipe.blocks) {
      w.hook(block.before);
      const r = await w.run(block.code);
      const exit = r.status ?? -1;
      const out = r.stdout ?? "";
      const err = r.stderr ?? "";
      if (process.env.COMFORGE_RECIPES_VERBOSE)
        console.error(
          `--- ${recipe.name} block ${block.index} (line ${block.line}) exit ${exit}\n${out}\n${err}`,
        );
      const problems: string[] = [];
      const want = block.expect ?? {};
      if (exit !== (want.exit ?? 0)) problems.push(`exit ${exit}, expected ${want.exit ?? 0}`);
      if (want.json) {
        const doc = lastJson(out) ?? lastJson(err);
        for (const [k, v] of Object.entries(want.json))
          if (JSON.stringify(at(doc, k)) !== JSON.stringify(v))
            problems.push(`${k} = ${JSON.stringify(at(doc, k))}, expected ${JSON.stringify(v)}`);
      }
      if (want.stdout && !out.includes(want.stdout))
        problems.push(`stdout lacks ${JSON.stringify(want.stdout)}`);
      if (want.stderr && !err.includes(want.stderr))
        problems.push(`stderr lacks ${JSON.stringify(want.stderr)}`);
      if (out.includes(w.token) || err.includes(w.token))
        problems.push("the synthetic token appeared in output");
      steps.push({
        block: block.index,
        line: block.line,
        pass: problems.length === 0,
        detail: problems.length
          ? `${problems.join("; ")} | ${(err || out).trim().split("\n").slice(-3).join(" ⏎ ").slice(0, 400)}`
          : `exit ${exit}`,
      });
      if (problems.length) break;
    }
  } finally {
    w.dispose();
  }
  const pass = steps.length === recipe.blocks.length && steps.every((s) => s.pass);
  return { recipe: recipe.name, title: recipe.title, world: recipe.world, pass, steps };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const opt = (f: string) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : undefined);
  const only = opt("--recipe");
  const runtime = opt("--runtime") ?? "node";
  const names = listRecipes().filter((n) => !only || n.includes(only));
  const results: RecipeResult[] = [];
  for (const name of names) {
    const recipe = parseRecipe(name, readFileSync(path.join(RECIPES_DIR, name), "utf8"));
    const r = await runRecipe(recipe, runtime);
    results.push(r);
    if (!argv.includes("--json")) {
      console.log(
        `${r.pass ? "PASS" : "FAIL"} ${name} (${r.steps.filter((s) => s.pass).length}/${recipe.blocks.length} blocks)`,
      );
      for (const s of r.steps.filter((x) => !x.pass)) console.log(`  line ${s.line}: ${s.detail}`);
    }
  }
  const harness = JSON.parse(
    readFileSync(path.join(REPO_ROOT, "harness/package.json"), "utf8"),
  ).dependencies;
  if (argv.includes("--json"))
    console.log(JSON.stringify({ schema: RECIPES_SCHEMA, runtime, harness, results }, null, 2));
  if (existsSync(path.join(REPO_ROOT, "harness/node_modules")) === false) process.exit(2);
  process.exit(results.every((r) => r.pass) ? 0 : 1);
}
