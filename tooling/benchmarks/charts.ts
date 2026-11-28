/**
 * Benchmark charts (docs/assets/charts/*.svg), rendered from the same evidence as
 * docs/benchmarks/summary.md and written or checked with it (`bun run benchmarks:summary`,
 * `bun run benchmarks:check`). No number in a chart is typed here: every bar is read from
 * evidence/benchmarks/*.json, and every chart names its unit, versions and kind of comparison.
 *
 * Each chart carries its own background and switches palette with prefers-color-scheme, so it
 * stays legible whichever theme the page around it uses.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

const REPO = path.resolve(import.meta.dir, "../..");
export const CHART_DIR = "docs/assets/charts";
const read = <T>(rel: string) => JSON.parse(readFileSync(path.join(REPO, rel), "utf8")) as T;

type Role = "baseline" | "comforge" | "larger";
type Bar = { label: string; value: number; role: Role };
type Group = { label: string; bars: Bar[] };
type Chart = { title: string; subtitle: string; unit: string; groups: Group[]; notes: string[] };

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const n = (x: number) => x.toLocaleString("en-US");
const SANS = `ui-sans-serif, -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif`;

/** Horizontal bars, one row per bar, groups separated; labels left, values at the bar's end. */
export function barChart(c: Chart): string {
  const width = 760;
  const labelW = 190;
  const plotW = width - labelW - 110;
  const max = Math.max(...c.groups.flatMap((g) => g.bars.map((b) => b.value)));
  const barH = 18;
  let y = 74;
  const body: string[] = [];
  for (const g of c.groups) {
    body.push(`<text x="24" y="${y}" class="group">${esc(g.label)}</text>`);
    y += 10;
    for (const b of g.bars) {
      const w = Math.max(2, Math.round((b.value / max) * plotW));
      body.push(
        `<text x="${labelW + 8}" y="${y + 13}" class="label" text-anchor="end">${esc(b.label)}</text>`,
        `<rect x="${labelW + 16}" y="${y}" width="${w}" height="${barH}" rx="3" class="${b.role}"><title>${esc(`${g.label} — ${b.label}: ${n(b.value)} ${c.unit}`)}</title></rect>`,
        `<text x="${labelW + 22 + w}" y="${y + 13}" class="value">${n(b.value)}</text>`,
      );
      y += barH + 6;
    }
    y += 22;
  }
  const legendY = y - 4;
  const legend = (
    [
      ["baseline", "baseline"],
      ["comforge", "Comforge (smaller)"],
      ["larger", "Comforge larger (counterexample)"],
    ] as const
  ).filter(([role]) => c.groups.some((g) => g.bars.some((b) => b.role === role)));
  let lx = 24;
  for (const [role, text] of legend) {
    body.push(
      `<rect x="${lx}" y="${legendY}" width="12" height="12" rx="2" class="${role}"/>`,
      `<text x="${lx + 18}" y="${legendY + 10}" class="note">${esc(text)}</text>`,
    );
    lx += 30 + text.length * 6.6;
  }
  y = legendY + 34;
  for (const note of c.notes) {
    body.push(`<text x="24" y="${y}" class="note">${esc(note)}</text>`);
    y += 17;
  }
  const height = y + 8;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="t s"><title id="t">${esc(c.title)}</title><desc id="s">${esc(`${c.subtitle} ${c.groups.map((g) => `${g.label}: ${g.bars.map((b) => `${b.label} ${n(b.value)}`).join(", ")}`).join("; ")}.`)}</desc>
<style>
.bg{fill:#ffffff;stroke:#d0d7de}.title{fill:#0f1720;font:600 16px ${SANS}}.sub,.note{fill:#4b5563;font:12px ${SANS}}
.group{fill:#0f1720;font:600 13px ${SANS}}.label{fill:#0f1720;font:12px ${SANS}}.value{fill:#0f1720;font:600 12px ${SANS}}
.baseline{fill:#8c959f}.comforge{fill:#0b7285}.larger{fill:#b45309}
@media (prefers-color-scheme: dark){.bg{fill:#0d1117;stroke:#30363d}.title,.group,.label,.value{fill:#e6edf3}.sub,.note{fill:#9aa4b2}.baseline{fill:#6e7681}.comforge{fill:#3bc9db}.larger{fill:#f59e0b}}
</style>
<rect class="bg" x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="8"/>
<text x="24" y="30" class="title">${esc(c.title)}</text>
<text x="24" y="50" class="sub">${esc(c.subtitle)}</text>
${body.join("\n")}
</svg>
`;
}

type Historical = {
  versions: string;
  tokenizer: string;
  results: { id: string; tokens?: Record<string, unknown> }[];
};
type Size = { chars: number; calls?: number };
type Measurements = {
  versions: Record<string, string>;
  discovery: Record<string, Size & { tools: number }>;
  tasks: Record<string, unknown>[];
};

/** Every chart, keyed by its path under the repository. */
export function charts(): Record<string, string> {
  const h = read<Historical>("evidence/benchmarks/historical.json");
  const m = read<Measurements>("evidence/benchmarks/component-measurements.json");
  const tok = (id: string) => h.results.find((r) => r.id === id)?.tokens as Record<string, never>;
  const histNote = [
    "Historical: release candidates before the current releases; Anthropic token counts per text.",
    "Component-level only — not an end-to-end agent saving. Method and limits: docs/benchmarks/README.md",
  ];
  const retrieval = (id: string, label: string): Group => {
    const t = tok(id) as unknown as { rawGitHub: number; cli: number; mcp: number };
    return {
      label,
      bars: [
        { label: "raw GitHub REST JSON", value: t.rawGitHub, role: "baseline" },
        { label: "CLI --json", value: t.cli, role: "comforge" },
        { label: "MCP tool result", value: t.mcp, role: "comforge" },
      ],
    };
  };
  const pair = (label: string, [before, after]: [number, number], a: string, b: string): Group => ({
    label,
    bars: [
      { label: a, value: before, role: "baseline" },
      { label: b, value: after, role: "comforge" },
    ],
  });
  const disc = tok("compact-discovery") as unknown as Record<string, [number, number]>;
  const cli = tok("cli-compact") as unknown as Record<string, [number, number]>;
  const costs = tok("mcp-costs-more") as unknown as Record<string, { mcp: number; cli: number }>;
  const t0 = m.tasks[0] as { cliJson: Size; cliCompact: Size; mcpText: Size };
  const t2 = m.tasks[2] as { cliJson: Size; cliCompact: Size };
  const d = m.discovery;
  const current = Object.entries(m.versions)
    .map(([k, v]) => `${k} ${v}`)
    .join(", ");
  return {
    [`${CHART_DIR}/retrieval.svg`]: barChart({
      title: "Selective retrieval vs raw GitHub JSON",
      subtitle:
        "Tokens an agent reads for the same information (equivalent content). Lower is smaller.",
      unit: "tokens",
      groups: [
        retrieval("pr-list", "List pull requests"),
        retrieval("issue-comments", "An issue's comments"),
      ],
      notes: [
        "Selective retrieval: the same fields, without the REST envelope. Not reproducible credential-free (needs live GitHub).",
        ...histNote,
      ],
    }),
    [`${CHART_DIR}/compaction.svg`]: barChart({
      title: "Compact output for the same content",
      subtitle: "Tokens before and after the compact flags (equivalent content). Lower is smaller.",
      unit: "tokens",
      groups: [
        pair(
          "MCP discovery, 17 tools",
          disc["executor+publisher (17 tools)"] as [number, number],
          "tools/list",
          "--compact-discovery",
        ),
        pair(
          "MCP discovery, 10 tools",
          disc["read-only"] as [number, number],
          "tools/list",
          "--compact-discovery",
        ),
        pair(
          "CLI, one initiative's full record",
          cli["one initiative"] as [number, number],
          "--json",
          "--json --compact",
        ),
        pair(
          "CLI, every initiative's status",
          cli["every initiative's status"] as [number, number],
          "--json",
          "--json --compact",
        ),
      ],
      notes: histNote,
    }),
    [`${CHART_DIR}/mcp-larger.svg`]: barChart({
      title: "Where MCP costs more than the CLI",
      subtitle:
        "Equivalent initiative state: MCP's envelope and per-call split add tokens. Lower is smaller.",
      unit: "tokens",
      groups: Object.entries(costs).map(([label, v]) => ({
        label: label[0]?.toUpperCase() + label.slice(1),
        bars: [
          { label: "CLI --json (one call)", value: v.cli, role: "baseline" as const },
          { label: "MCP tool results", value: v.mcp, role: "larger" as const },
        ],
      })),
      notes: histNote,
    }),
    [`${CHART_DIR}/current.svg`]: barChart({
      title: "Reproduced with the current releases",
      subtitle: `Characters of the exact text an agent reads (${current}). Lower is smaller.`,
      unit: "characters",
      groups: [
        pair(
          `MCP discovery, ${d["executor+publisher"]?.tools} tools`,
          [d["executor+publisher"]?.chars ?? 0, d["executor+publisher (compact)"]?.chars ?? 0],
          "tools/list",
          "--compact-discovery",
        ),
        pair(
          `MCP discovery, ${d["read-only"]?.tools} tools`,
          [d["read-only"]?.chars ?? 0, d["read-only (compact)"]?.chars ?? 0],
          "tools/list",
          "--compact-discovery",
        ),
        pair(
          "CLI, every initiative's status",
          [t0.cliJson.chars, t0.cliCompact.chars],
          "--json",
          "--json --compact",
        ),
        pair(
          "CLI, one initiative's record",
          [t2.cliJson.chars, t2.cliCompact.chars],
          "--json",
          "--json --compact",
        ),
        {
          label: "Every initiative's status, equivalent content",
          bars: [
            { label: "CLI --json --compact", value: t0.cliCompact.chars, role: "baseline" },
            { label: `MCP, ${t0.mcpText.calls} calls`, value: t0.mcpText.chars, role: "larger" },
          ],
        },
      ],
      notes: [
        "Synthetic fixture (12 initiatives). Reproduce: bun run benchmarks:measure.",
        "Component-level only — not an end-to-end agent saving. Method and limits: docs/benchmarks/README.md",
      ],
    }),
  };
}
