/**
 * Repository checks shared by `bun run validate` and tests/repository. Each returns a list of
 * problems; an empty list passes. Deterministic, offline, credential-free.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { checkManifest, routeTask } from "../packages/cli/src/routing.ts";

export const REPO = path.resolve(import.meta.dir, "..");
const read = (f: string) => readFileSync(path.join(REPO, f), "utf8");
const PACKAGES = ["core", "github", "ledger", "cli", "mcp"] as const;

function walk(dir: string, filter: (f: string) => boolean): string[] {
  const abs = path.join(REPO, dir);
  if (!existsSync(abs)) return [];
  return readdirSync(abs).flatMap((name) => {
    const rel = `${dir}/${name}`;
    if (name === "node_modules" || name === "fixtures" || name.startsWith(".")) return [];
    return statSync(path.join(REPO, rel)).isDirectory()
      ? walk(rel, filter)
      : filter(rel)
        ? [rel]
        : [];
  });
}

export const SKILL_SECTIONS = [
  "When to use",
  "Prerequisites",
  "Examples",
  "Decision rules",
  "Security boundaries",
  "Validation",
  "Failure and recovery",
  "References",
] as const;

export function skillNames(): string[] {
  return readdirSync(path.join(REPO, "skills")).filter((n) =>
    existsSync(path.join(REPO, "skills", n, "SKILL.md")),
  );
}

export function checkSkills(): string[] {
  const problems: string[] = [];
  const index = read("skills/README.md");
  for (const name of skillNames()) {
    const file = `skills/${name}/SKILL.md`;
    const text = read(file);
    const fm = /^---\n([\s\S]*?)\n---\n/.exec(text);
    if (!fm) problems.push(`${file}: no frontmatter`);
    else {
      if (!new RegExp(`^name: ${name}$`, "m").test(fm[1] as string))
        problems.push(`${file}: frontmatter name must be ${name}`);
      if (!/^description: .{20,300}$/m.test(fm[1] as string))
        problems.push(`${file}: description of 20–300 characters required`);
      if (!/^category: (consumer|contributor)$/m.test(fm[1] as string))
        problems.push(`${file}: category consumer or contributor required`);
    }
    for (const section of SKILL_SECTIONS)
      if (!text.includes(`\n## ${section}\n`))
        problems.push(`${file}: missing section "${section}"`);
    if (!/```sh\n[\s\S]+?\n```/.test(text)) problems.push(`${file}: needs an executable example`);
    if (!index.includes(`(${name}/SKILL.md)`))
      problems.push(`skills/README.md does not list ${name}`);
    if (text.split("\n").length > 120)
      problems.push(`${file}: over 120 lines; split it or link a doc`);
  }
  return problems;
}

export function routing() {
  return checkManifest(JSON.parse(read("context/routing.json")), REPO);
}

export function checkRouting(): string[] {
  const { manifest, issues } = routing();
  const problems = issues.map((i) => `${i.category ?? "(root)"}: ${i.message}`);
  if (!manifest) return problems;
  const skills = new Set(skillNames());
  const referenced = new Set<string>();
  for (const [id, c] of Object.entries(manifest.categories)) {
    for (const s of (c.skills as string[] | undefined) ?? []) {
      referenced.add(s);
      if (!skills.has(s)) problems.push(`${id}: skill ${s} does not exist`);
    }
    for (const d of (c.docs as string[] | undefined) ?? [])
      if (!existsSync(path.join(REPO, d))) problems.push(`${id}: doc ${d} does not exist`);
    if (!(c.validation ?? []).length) problems.push(`${id}: no validation command`);
  }
  for (const s of skills)
    if (!referenced.has(s)) problems.push(`skill ${s} is not reachable from any routing category`);
  const evals = JSON.parse(read("tests/repository/fixtures/routing-eval.json")) as {
    cases: { task: string; expect: string }[];
  };
  for (const c of evals.cases) {
    const got = routeTask(manifest, c.task).match?.id ?? "general";
    if (got !== c.expect) problems.push(`routing eval: "${c.task}" → ${got}, expected ${c.expect}`);
  }
  return problems;
}

/** Relative links in every Markdown document and llms.txt resolve inside the repository. */
export function checkDocs(): string[] {
  const files = [
    ...walk("docs", (f) => f.endsWith(".md")),
    ...walk("skills", (f) => f.endsWith(".md")),
    ...walk("release-intents", (f) => f.endsWith(".md")),
    ...PACKAGES.flatMap((p) => [`packages/${p}/README.md`, `packages/${p}/llms.txt`]),
    "README.md",
    "CLAUDE.md",
    "AGENTS.md",
    "llms.txt",
  ].filter((f) => existsSync(path.join(REPO, f)));
  const problems: string[] = [];
  for (const file of files) {
    for (const [, target] of read(file).matchAll(/\]\(([^)\s]+)\)/g)) {
      if (!target || /^[a-z]+:|^#/i.test(target)) continue;
      // A package document's dist/ link resolves in the published tarball, not in the source tree.
      if (file.startsWith("packages/") && target.startsWith("dist/")) continue;
      const resolved = path.posix.normalize(
        path.posix.join(path.posix.dirname(file), (target.split("#")[0] as string) || "."),
      );
      if (resolved.startsWith("..") || !existsSync(path.join(REPO, resolved)))
        problems.push(`${file} → ${target}`);
    }
  }
  for (const doc of walk("docs", (f) => f.endsWith(".md") && !f.includes("/decisions/")))
    if (
      !read("docs/README.md").includes(`(${path.posix.relative("docs", doc)})`) &&
      doc !== "docs/README.md"
    )
      problems.push(`docs/README.md does not link ${doc}`);
  return problems;
}

const importsOf = (text: string) =>
  [...text.matchAll(/(?:\bfrom\s+|\bimport\s*\(\s*|^\s*import\s+)["']([^"']+)["']/gm)].map(
    (m) => m[1] as string,
  );

/** Package boundaries: core is pure; siblings by name only; no repository-internal imports. */
export function checkBoundaries(): string[] {
  const problems: string[] = [];
  for (const id of PACKAGES) {
    const manifest = JSON.parse(read(`packages/${id}/package.json`)) as {
      dependencies?: Record<string, string>;
    };
    const declared = new Set(Object.keys(manifest.dependencies ?? {}));
    for (const file of walk(`packages/${id}/src`, (f) => f.endsWith(".ts"))) {
      for (const spec of importsOf(read(file))) {
        if (spec.startsWith(".")) {
          const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), spec));
          if (!target.startsWith(`packages/${id}/src/`))
            problems.push(`${file}: relative import outside its package: ${spec}`);
          continue;
        }
        if (spec.startsWith("node:") || spec.startsWith("bun:")) {
          // Computation only in core: hashing and signatures, never files, network or processes.
          if (id === "core" && spec !== "node:crypto" && spec !== "node:buffer")
            problems.push(`${file}: core performs no I/O (${spec})`);
          continue;
        }
        const name = spec.startsWith("@")
          ? spec.split("/").slice(0, 2).join("/")
          : (spec.split("/")[0] as string);
        if (!declared.has(name)) problems.push(`${file}: imports undeclared dependency ${name}`);
        if (id === "core" && name.startsWith("@comforge/"))
          problems.push(`${file}: core imports no sibling (${name})`);
      }
    }
  }
  return problems;
}

/** The harness is the published release, isolated from the workspace candidates. */
export function checkHarness(): string[] {
  const problems: string[] = [];
  const root = JSON.parse(read("package.json")) as {
    workspaces: string[];
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  if (root.workspaces.some((w) => w.startsWith("harness")))
    problems.push("harness/ must not be a workspace");
  for (const [n, v] of Object.entries(root.devDependencies ?? {}))
    if (n.startsWith("@comforge/") && v !== "workspace:*")
      problems.push(`root ${n} must be the workspace candidate`);
  const harness = JSON.parse(read("harness/package.json")) as {
    dependencies: Record<string, string>;
  };
  for (const [n, v] of Object.entries(harness.dependencies))
    if (!/^\d+\.\d+\.\d+$/.test(v))
      problems.push(`harness ${n} must pin an exact published version, not ${v}`);
  if (!existsSync(path.join(REPO, "harness", "bun.lock")))
    problems.push("harness/bun.lock is missing");
  return problems;
}
