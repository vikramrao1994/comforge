/**
 * Documentation drift checks (`bun run validate reference | invented | versions | recipes |
 * benchmarks`). Each returns its problems; an empty list is clean.
 *
 * - reference: the generated inventories match the contracts, and every command, flag, error
 *   code, MCP tool, launch flag and configuration section/key is explained on its handwritten
 *   reference page.
 * - invented: no document names a `comforge` command, a flag of a command, a `comforge-mcp` flag
 *   (also inside an MCP client configuration's `"args"` array) or a `comforge_*` tool that the
 *   contracts do not declare.
 * - versions: no document calls a package version published that is newer than the workspace
 *   version, unless the same line labels it a candidate, planned or unreleased.
 * - recipes: at least ten recipes, each with an executable block, an errors section and cleanup,
 *   each listed in the recipes index (execution itself is tests/docs/recipes.test.ts).
 * - benchmarks: the benchmark summary page matches its evidence and the evidence is internally
 *   consistent, and so do the charts drawn from it (tooling/benchmarks/summary.ts, charts.ts).
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { chartProblems, inconsistencies, render, SUMMARY_FILE } from "../benchmarks/summary";
import {
  cliContracts,
  configContracts,
  mcpContracts,
  PACKAGES,
  packageVersion,
  REPO,
} from "./contracts";
import { checkGenerated, GENERATED_DIR } from "./generate";
import { listRecipes, parseRecipe, RECIPES_DIR } from "./recipes";

const read = (rel: string) => readFileSync(path.join(REPO, rel), "utf8");

function markdownFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(path.join(REPO, dir))) {
      const rel = `${dir}/${name}`;
      if (statSync(path.join(REPO, rel)).isDirectory()) walk(rel);
      else if (name.endsWith(".md")) out.push(rel);
    }
  };
  walk("docs");
  walk("skills");
  return [
    ...out.filter((f) => !f.startsWith(GENERATED_DIR)),
    "README.md",
    "CLAUDE.md",
    "AGENTS.md",
    "llms.txt",
    ...PACKAGES.flatMap((p) => [`packages/${p}/README.md`, `packages/${p}/llms.txt`]),
  ].filter((f) => existsSync(path.join(REPO, f)));
}

export async function checkReference(): Promise<string[]> {
  const problems = await checkGenerated();
  const cli = await cliContracts();
  const mcp = await mcpContracts();
  const cfg = await configContracts();
  const page = (rel: string) => read(`docs/reference/${rel}`);
  const cliPage = page("cli.md");
  for (const c of cli.commands) {
    if (!cliPage.includes(`\`${c.name}`))
      problems.push(`docs/reference/cli.md does not explain command ${c.name}`);
    for (const f of c.flags) {
      const row = cliPage.split("\n").find((l) => l.includes(`\`${c.name}`) && l.includes(f));
      if (!row) problems.push(`docs/reference/cli.md does not explain ${c.name} ${f}`);
    }
  }
  for (const f of cli.globalFlags)
    if (!cliPage.includes(`\`${f}`))
      problems.push(`docs/reference/cli.md does not explain global flag ${f}`);
  const errors = page("errors.md");
  for (const code of Object.keys(cli.errorCodes))
    if (!errors.includes(`| \`${code}\` |`))
      problems.push(`docs/reference/errors.md does not explain CLI code ${code}`);
  for (const code of Object.keys(mcp.errorCodes))
    if (!errors.includes(`| \`${code}\` |`))
      problems.push(`docs/reference/errors.md does not explain MCP code ${code}`);
  const mcpPage = page("mcp.md");
  for (const t of mcp.tools)
    if (!mcpPage.includes(`\`${t.name}\``))
      problems.push(`docs/reference/mcp.md does not explain tool ${t.name}`);
  for (const p of mcp.profiles)
    if (!mcpPage.includes(`\`${p}\``))
      problems.push(`docs/reference/mcp.md does not explain profile ${p}`);
  for (const f of mcp.binFlags)
    if (!mcpPage.includes(`\`${f}`))
      problems.push(`docs/reference/mcp.md does not explain launch flag ${f}`);
  const cfgPage = page("configuration.md");
  for (const s of cfg.sections) {
    if (!cfgPage.includes(`| \`${s.name}\` |`))
      problems.push(`docs/reference/configuration.md does not explain section ${s.name}`);
    for (const k of s.keys)
      if (!cfgPage.includes(`\`${k}\``))
        problems.push(`docs/reference/configuration.md does not explain ${s.name}.${k}`);
  }
  return problems;
}

/** Code spans and code-block lines, where commands are written. */
function codeLines(text: string): string[] {
  const out: string[] = [];
  let fenced = false;
  for (const line of text.split("\n")) {
    if (line.trimStart().startsWith("```")) {
      fenced = !fenced;
      continue;
    }
    if (fenced) out.push(line);
    else for (const m of line.matchAll(/`([^`]+)`/g)) out.push(m[1] as string);
  }
  return out;
}

export async function checkInvented(): Promise<string[]> {
  const cli = await cliContracts();
  const mcp = await mcpContracts();
  const commands = new Map(
    cli.commands.map((c) => [c.name, new Set([...c.flags, ...cli.globalFlags])]),
  );
  const tools = new Set(mcp.tools.map((t) => t.name));
  const binFlags = new Set(mcp.binFlags);
  const problems: string[] = [];
  for (const file of markdownFiles()) {
    const lines = codeLines(read(file));
    for (const line of lines) {
      // An MCP client configuration's args array: `"args": ["-y", "@comforge/mcp@…", "--flag", …]`.
      const args = line.match(/"args"\s*:\s*\[([^\]]*)\]/)?.[1];
      if (args && /@comforge\/mcp|comforge-mcp/.test(args))
        for (const m of args.matchAll(/"(--[a-z][a-z-]*)"/g))
          if (!binFlags.has(m[1] as string))
            problems.push(`${file}: comforge-mcp has no flag ${m[1]}`);
      for (const m of line.matchAll(/\bcomforge_[a-z_]+\b/g))
        if (!tools.has(m[0])) problems.push(`${file}: unknown MCP tool ${m[0]}`);
      // Token by token: `comforge <command> [flags]` and `comforge-mcp [flags]`, each up to the
      // next shell separator. A `comforge` followed by `--` is a name (e.g. an MCP server's).
      const tokens = line.split(/\s+/).filter(Boolean);
      for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i] as string;
        if (t !== "comforge" && t !== "comforge-mcp") continue;
        const words: string[] = [];
        for (
          let j = i + 1;
          j < tokens.length && !/^(;|&&|\|\||\||\)|#)$/.test(tokens[j] as string);
          j++
        )
          words.push(tokens[j] as string);
        const flags = words.filter((w) => /^--[a-z]/.test(w)).map((w) => w.replace(/=.*$/, ""));
        if (t === "comforge-mcp") {
          for (const f of flags)
            if (!binFlags.has(f)) problems.push(`${file}: comforge-mcp has no flag ${f}`);
          continue;
        }
        const command = words[0];
        if (!command || command === "--" || command.startsWith("<") || command.startsWith("…"))
          continue;
        if (command.startsWith("-")) {
          for (const f of flags)
            if (!cli.globalFlags.includes(f)) problems.push(`${file}: ${f} is not a global flag`);
          continue;
        }
        if (/[^a-z]/.test(command)) continue;
        const accepted = commands.get(command);
        if (!accepted) {
          problems.push(`${file}: unknown command comforge ${command}`);
          continue;
        }
        // Flags after a nested `comforge` belong to it, not to this command.
        const own = words.slice(
          0,
          (words.findIndex((w, k) => k > 0 && /^comforge/.test(w)) + 1 || words.length + 1) - 1,
        );
        for (const f of own.filter((w) => /^--[a-z]/.test(w)).map((w) => w.replace(/=.*$/, "")))
          if (!accepted.has(f)) problems.push(`${file}: comforge ${command} has no flag ${f}`);
      }
    }
  }
  return [...new Set(problems)];
}

export function checkVersions(): string[] {
  const current = Object.fromEntries(PACKAGES.map((p) => [p, packageVersion(p)]));
  const cmp = (a: string, b: string) => {
    const [x, y] = [a.split(".").map(Number), b.split(".").map(Number)];
    for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
    return 0;
  };
  const problems: string[] = [];
  for (const file of markdownFiles())
    for (const [i, line] of read(file).split("\n").entries())
      for (const m of line.matchAll(
        /@comforge\/(core|github|ledger|cli|mcp)`?\s+(?:v)?(\d+\.\d+\.\d+)/g,
      )) {
        const [pkg, version] = [m[1] as string, m[2] as string];
        if (
          cmp(version, current[pkg] as string) > 0 &&
          !/candidate|planned|unreleased|next/i.test(line)
        )
          problems.push(
            `${file}:${i + 1}: @comforge/${pkg} ${version} is newer than ${current[pkg]} and not labelled a candidate`,
          );
      }
  return problems;
}

export function checkRecipes(): string[] {
  const problems: string[] = [];
  const names = listRecipes();
  if (names.length < 10)
    problems.push(`docs/recipes has ${names.length} recipes; at least 10 are required`);
  const index = read("docs/recipes/README.md");
  for (const name of names) {
    const text = readFileSync(path.join(RECIPES_DIR, name), "utf8");
    const recipe = parseRecipe(name, text);
    if (recipe.blocks.length === 0) problems.push(`docs/recipes/${name} has no executable block`);
    if (!/^## .*Errors/im.test(text)) problems.push(`docs/recipes/${name} has no Errors section`);
    if (!/cleanup/i.test(text)) problems.push(`docs/recipes/${name} says nothing about cleanup`);
    if (!/^\*\*How this page is tested\.\*\*/m.test(text))
      problems.push(`docs/recipes/${name} does not say how it is tested`);
    if (!index.includes(`(${name})`)) problems.push(`docs/recipes/README.md does not list ${name}`);
  }
  return problems;
}

export function checkBenchmarks(): string[] {
  const problems = inconsistencies(
    JSON.parse(read("evidence/benchmarks/component-measurements.json")),
  );
  if (!existsSync(path.join(REPO, SUMMARY_FILE)) || read(SUMMARY_FILE) !== render())
    problems.push(`${SUMMARY_FILE} does not match the evidence: run bun run benchmarks:summary`);
  problems.push(...chartProblems());
  return problems;
}
