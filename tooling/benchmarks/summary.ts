/**
 * `bun tooling/benchmarks/summary.ts [--check]` — renders `docs/benchmarks/summary.md` from the
 * benchmark evidence (`evidence/benchmarks/*.json` and the routing evaluation set). With
 * `--check` it writes nothing and exits 1 when the page differs from the evidence, or when a
 * derived percentage in the evidence does not follow from its raw sizes — so no number on the
 * page can drift from, or be typed independently of, its evidence. The charts in
 * docs/assets/charts/ (tooling/benchmarks/charts.ts) are written and checked with the page.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CHART_DIR, charts } from "./charts";

const REPO = path.resolve(import.meta.dir, "../..");
export const SUMMARY_FILE = "docs/benchmarks/summary.md";
const read = <T>(rel: string) => JSON.parse(readFileSync(path.join(REPO, rel), "utf8")) as T;

type Size = { chars: number; approxTokens: number; calls?: number };
type Measurements = {
  versions: Record<string, string>;
  runtime: string;
  method: Record<string, string>;
  discovery: Record<string, Size & { tools: number }>;
  cliDiscovery: { helpPlusCapabilities: Size };
  tasks: Record<string, unknown>[];
  derived: {
    compactDiscoveryReductionPercent: Record<string, number>;
    cliCompactReductionPercent: { statusAll: number; statusOne: number };
    mcpVsCliEquivalentStatusPercent: number;
    mcpVsCliCompactEquivalentStatusPercent: number;
    summaryFirstVsCliFullPercent: { everyInitiative: number; oneInitiative: number };
  };
};
type Historical = {
  provenance: string;
  versions: string;
  tokenizer: string;
  results: {
    id: string;
    what: string;
    kind: string;
    claim: string;
    reproducibleCredentialFree: boolean | string;
    why?: string;
  }[];
};

const pct = (from: number, to: number) => Math.round((1 - to / from) * 1000) / 10;
const more = (a: number, b: number) => Math.round((a / b - 1) * 1000) / 10;

/** Derived figures recomputed from the raw sizes; a mismatch means hand-edited evidence. */
export function inconsistencies(m: Measurements): string[] {
  const problems: string[] = [];
  const d = m.discovery;
  const t0 = m.tasks[0] as { cliJson: Size; cliCompact: Size; mcpText: Size };
  const t1 = m.tasks[1] as { mcpListText: Size };
  const t2 = m.tasks[2] as { cliJson: Size; cliCompact: Size; mcpSummaryText: Size };
  const expect: [string, number, number][] = [
    [
      "compact discovery (read-only)",
      m.derived.compactDiscoveryReductionPercent["read-only"] ?? NaN,
      pct(d["read-only"]?.chars ?? 0, d["read-only (compact)"]?.chars ?? 0),
    ],
    [
      "compact discovery (executor+publisher)",
      m.derived.compactDiscoveryReductionPercent["executor+publisher"] ?? NaN,
      pct(d["executor+publisher"]?.chars ?? 0, d["executor+publisher (compact)"]?.chars ?? 0),
    ],
    [
      "CLI compact (all)",
      m.derived.cliCompactReductionPercent.statusAll,
      pct(t0.cliJson.chars, t0.cliCompact.chars),
    ],
    [
      "CLI compact (one)",
      m.derived.cliCompactReductionPercent.statusOne,
      pct(t2.cliJson.chars, t2.cliCompact.chars),
    ],
    [
      "MCP vs CLI",
      m.derived.mcpVsCliEquivalentStatusPercent,
      more(t0.mcpText.chars, t0.cliJson.chars),
    ],
    [
      "MCP vs CLI compact",
      m.derived.mcpVsCliCompactEquivalentStatusPercent,
      more(t0.mcpText.chars, t0.cliCompact.chars),
    ],
    [
      "summary-first (all)",
      m.derived.summaryFirstVsCliFullPercent.everyInitiative,
      pct(t0.cliJson.chars, t1.mcpListText.chars),
    ],
    [
      "summary-first (one)",
      m.derived.summaryFirstVsCliFullPercent.oneInitiative,
      pct(t2.cliJson.chars, t2.mcpSummaryText.chars),
    ],
  ];
  for (const [name, stated, computed] of expect)
    if (stated !== computed)
      problems.push(`${name}: evidence says ${stated}%, its sizes give ${computed}%`);
  return problems;
}

/** Charts that differ from (or are missing against) the evidence. */
export function chartProblems(): string[] {
  return Object.entries(charts())
    .filter(
      ([rel, svg]) =>
        !existsSync(path.join(REPO, rel)) || readFileSync(path.join(REPO, rel), "utf8") !== svg,
    )
    .map(([rel]) => `${rel} does not match the evidence: run bun run benchmarks:summary`);
}

export function render(): string {
  const m = read<Measurements>("evidence/benchmarks/component-measurements.json");
  const h = read<Historical>("evidence/benchmarks/historical.json");
  const routing = read<{ cases: unknown[] }>("tests/repository/fixtures/routing-eval.json").cases
    .length;
  const n = (x: number) => x.toLocaleString("en-US");
  const t0 = m.tasks[0] as { task: string; cliJson: Size; cliCompact: Size; mcpText: Size };
  const t1 = m.tasks[1] as { cliSummary: Size; mcpListText: Size };
  const t2 = m.tasks[2] as { cliJson: Size; cliCompact: Size; mcpSummaryText: Size };
  const versions = Object.entries(m.versions)
    .map(([k, v]) => `\`${k}\` ${v}`)
    .join(", ");
  const lines = [
    "<!-- Generated by tooling/benchmarks/summary.ts from evidence/benchmarks/*.json. Do not edit; run `bun run benchmarks:summary`. -->",
    "",
    "# Benchmark summary",
    "",
    "Component-level measurements only. **No end-to-end agent saving, agent cost or competitive",
    "comparison has been measured** (status: pending). Method and limits: [README](README.md).",
    "",
    `## Reproduced now (${versions}, ${m.runtime})`,
    "",
    "Characters of the exact text an agent reads; tokens are **approximate** (`ceil(chars / 4)`,",
    "no tokenizer). Compare ratios. Reproduce: `bun run benchmarks:measure`",
    "(evidence: [`component-measurements.json`](../../evidence/benchmarks/component-measurements.json)).",
    "",
    "| Measurement | Kind | Before | After | Change |",
    "|---|---|---|---|---|",
    ...Object.entries({
      "read-only": "read-only (compact)",
      "executor+publisher": "executor+publisher (compact)",
    }).map(
      ([a, b]) =>
        `| MCP discovery, ${a} (${m.discovery[a]?.tools} tools), \`--compact-discovery\` | equivalent | ${n(m.discovery[a]?.chars ?? 0)} chars | ${n(m.discovery[b]?.chars ?? 0)} chars | −${m.derived.compactDiscoveryReductionPercent[a]}% |`,
    ),
    `| CLI, every initiative's status, \`--compact\` | equivalent | ${n(t0.cliJson.chars)} | ${n(t0.cliCompact.chars)} | −${m.derived.cliCompactReductionPercent.statusAll}% |`,
    `| CLI, one initiative's record, \`--compact\` | equivalent | ${n(t2.cliJson.chars)} | ${n(t2.cliCompact.chars)} | −${m.derived.cliCompactReductionPercent.statusOne}% |`,
    `| Every initiative's status: CLI JSON → MCP, one call each (${t0.mcpText.calls}) | equivalent | ${n(t0.cliJson.chars)} | ${n(t0.mcpText.chars)} | ${m.derived.mcpVsCliEquivalentStatusPercent > 0 ? "+" : "−"}${Math.abs(m.derived.mcpVsCliEquivalentStatusPercent)}% |`,
    `| Every initiative's status: CLI \`--compact\` → MCP, one call each | equivalent | ${n(t0.cliCompact.chars)} | ${n(t0.mcpText.chars)} | **+${m.derived.mcpVsCliCompactEquivalentStatusPercent}% (MCP larger)** |`,
    `| Every initiative: CLI full JSON → MCP status list (${t1.mcpListText.calls} pages) | **summary, not equivalent** | ${n(t0.cliJson.chars)} | ${n(t1.mcpListText.chars)} | −${m.derived.summaryFirstVsCliFullPercent.everyInitiative}% |`,
    `| One initiative: CLI full record → MCP status | **summary, not equivalent** | ${n(t2.cliJson.chars)} | ${n(t2.mcpSummaryText.chars)} | −${m.derived.summaryFirstVsCliFullPercent.oneInitiative}% |`,
    `| CLI \`--json --summary\`, every initiative | **summary, not equivalent** | ${n(t0.cliJson.chars)} | ${n(t1.cliSummary.chars)} | — |`,
    `| CLI help + capabilities (a CLI agent's discovery, for comparison) | — | — | ${n(m.cliDiscovery.helpPlusCapabilities.chars)} | — |`,
    "",
    "Where MCP costs more: equivalent content through MCP is larger than the CLI's compact JSON,",
    "and an MCP session pays its `tools/list` once per session; a CLI agent reads help only when",
    "it needs it.",
    "",
    "![Bar chart: characters before and after compact output with the current releases, and the case where MCP is larger than the CLI's compact JSON](../assets/charts/current.svg)",
    "",
    "## Historical (earlier versions; not attributed to the current releases)",
    "",
    `${h.provenance} Versions: ${h.versions}. Tokens: ${h.tokenizer}.`,
    "",
    "These are distinct component-level baselines, each against its own comparison — not one",
    "end-to-end agent saving. *Selective retrieval* returns the fields an agent needs instead of",
    "GitHub's full REST payload; *compact output* encodes the same content in fewer tokens; a",
    "*summary* carries less information and is not compared with equivalent content.",
    "",
    "![Bar chart: tokens for listing pull requests and an issue's comments — raw GitHub REST JSON, CLI and MCP](../assets/charts/retrieval.svg)",
    "",
    "![Bar chart: tokens before and after compact discovery and compact CLI output](../assets/charts/compaction.svg)",
    "",
    "![Bar chart: equivalent initiative state, where MCP tool results are larger than the CLI's JSON](../assets/charts/mcp-larger.svg)",
    "",
    "| Result | Kind | Claim | Reproduced here |",
    "|---|---|---|---|",
    ...h.results.map(
      (r) =>
        `| ${r.what} | ${r.kind} | ${r.claim} | ${r.reproducibleCredentialFree === true ? "comparable measurement above (characters, current versions)" : `no — ${r.why ?? String(r.reproducibleCredentialFree)}`} |`,
    ),
    "",
    "## Regression checks (run in CI on every pull request)",
    "",
    "| Check | Where |",
    "|---|---|",
    `| Context routing: ${routing} cases must route exactly (written with the manifest; a regression check, not an independent benchmark) | \`bun run validate routing\` |`,
    "| Ledger conformance and concurrency (memory, file, SQLite) | `packages/ledger/test`, `tests/ledger` |",
    "| Lost answers, interrupted writes, concurrent deliveries | `packages/cli/test/recovery.test.ts` |",
    "| Executable recipes against the published harness | `tests/docs/recipes.test.ts` |",
    "",
  ];
  return lines.join("\n");
}

if (import.meta.main) {
  const m = read<Measurements>("evidence/benchmarks/component-measurements.json");
  const problems = inconsistencies(m);
  const text = render();
  if (process.argv.includes("--check")) {
    const file = path.join(REPO, SUMMARY_FILE);
    if (!existsSync(file)) problems.push(`${SUMMARY_FILE} is missing`);
    else if (readFileSync(file, "utf8") !== text)
      problems.push(`${SUMMARY_FILE} is stale: run bun run benchmarks:summary`);
    problems.push(...chartProblems());
    for (const p of problems) console.log(p);
    console.log(problems.length ? `FAIL benchmarks (${problems.length})` : "PASS benchmarks");
    process.exit(problems.length ? 1 : 0);
  }
  if (problems.length) {
    for (const p of problems) console.error(p);
    process.exit(1);
  }
  writeFileSync(path.join(REPO, SUMMARY_FILE), text);
  mkdirSync(path.join(REPO, CHART_DIR), { recursive: true });
  for (const [rel, svg] of Object.entries(charts())) writeFileSync(path.join(REPO, rel), svg);
  console.log(`wrote ${SUMMARY_FILE} and ${Object.keys(charts()).length} charts in ${CHART_DIR}`);
}
