/**
 * `bun tooling/brand/diagrams.ts [--check]` — writes (or checks) the architecture and lifecycle
 * diagrams in docs/assets/diagrams/. Boxes and arrows are declared here so the diagrams stay
 * editable as code; the package graph they draw is the one in docs/concepts/architecture.md.
 * Each diagram carries its own background and switches palette with prefers-color-scheme.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const OUT = "docs/assets/diagrams";
const REPO = path.resolve(import.meta.dir, "../..");
const SANS = `ui-sans-serif, -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif`;
const MONO = `ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

type Box = {
  x: number;
  y: number;
  w: number;
  h: number;
  title: string;
  lines?: string[];
  kind?: "accent" | "plain" | "outer" | "people";
  mono?: boolean;
};

function box(b: Box): string {
  const cls = b.kind ?? "plain";
  const lines = b.lines ?? [];
  const top = b.y + b.h / 2 - (lines.length * 15) / 2 + (lines.length ? 2 : 5);
  return [
    `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="8" class="box ${cls}"/>`,
    `<text x="${b.x + b.w / 2}" y="${top}" text-anchor="middle" class="${cls === "accent" ? "t-accent" : "t-title"}"${b.mono ? ` style="font-family:${MONO}"` : ""}>${esc(b.title)}</text>`,
    ...lines.map(
      (l, i) =>
        `<text x="${b.x + b.w / 2}" y="${top + 16 + i * 15}" text-anchor="middle" class="${cls === "accent" ? "t-on" : "t-sub"}">${esc(l)}</text>`,
    ),
  ].join("\n");
}

const arrow = (x1: number, y1: number, x2: number, y2: number, dashed = false) =>
  `<path d="M${x1} ${y1} L${x2} ${y2}" class="edge${dashed ? " dashed" : ""}" marker-end="url(#arrow)"/>`;

function frame(width: number, height: number, title: string, desc: string, body: string[]): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="t d"><title id="t">${esc(title)}</title><desc id="d">${esc(desc)}</desc>
<style>
.bg{fill:#ffffff;stroke:#d0d7de}.box{stroke-width:1.2}.plain{fill:#f6f8fa;stroke:#d0d7de}.accent{fill:#0b7285;stroke:#0b7285}
.outer{fill:none;stroke:#8c959f;stroke-dasharray:4 4}.people{fill:#fff8e6;stroke:#d4a72c}
.t-title{fill:#0f1720;font:600 13px ${SANS}}.t-accent{fill:#ffffff;font:600 13px ${SANS}}.t-sub{fill:#4b5563;font:11.5px ${SANS}}
.label{fill:#4b5563;font:600 11px ${SANS};letter-spacing:.04em}.edge{stroke:#6e7781;stroke-width:1.4;fill:none}.dashed{stroke-dasharray:5 4}.head{fill:#6e7781}
.t-on{fill:#e6fcff;font:11.5px ${SANS}}
@media (prefers-color-scheme: dark){.bg{fill:#0d1117;stroke:#30363d}.plain{fill:#161b22;stroke:#30363d}.accent{fill:#3bc9db;stroke:#3bc9db}.outer{stroke:#6e7681}.people{fill:#2b2111;stroke:#9e6a03}
.t-title{fill:#e6edf3}.t-accent{fill:#0d1117}.t-sub{fill:#9aa4b2}.label{fill:#9aa4b2}.edge{stroke:#8b949e}.head{fill:#8b949e}.t-on{fill:#0d1117}}
</style>
<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" class="head"/></marker></defs>
<rect class="bg" x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="10"/>
${body.join("\n")}
</svg>
`;
}

function architecture(): string {
  const W = 760;
  const col = (i: number) => 24 + i * 244;
  const body = [
    `<text x="24" y="30" class="label">WHO CALLS IT</text>`,
    box({
      x: col(0),
      y: 40,
      w: 224,
      h: 46,
      title: "Agents with a shell, scripts, CI",
      kind: "people",
    }),
    box({
      x: col(1),
      y: 40,
      w: 224,
      h: 46,
      title: "MCP clients",
      lines: ["Claude Code · Codex · Cursor · any client"],
      kind: "people",
    }),
    box({
      x: col(2),
      y: 40,
      w: 224,
      h: 46,
      title: "Your own server or supervisor",
      kind: "people",
    }),
    arrow(col(0) + 112, 86, col(0) + 112, 112),
    arrow(col(1) + 112, 86, col(1) + 112, 112),
    arrow(col(2) + 112, 86, col(2) + 112, 112),
    `<text x="24" y="108" class="label">INTERFACES</text>`,
    box({
      x: col(0),
      y: 114,
      w: 224,
      h: 52,
      title: "comforge",
      lines: ["@comforge/cli"],
      kind: "accent",
      mono: true,
    }),
    box({
      x: col(1),
      y: 114,
      w: 224,
      h: 52,
      title: "comforge-mcp",
      lines: ["@comforge/mcp · stdio, HTTP"],
      kind: "accent",
      mono: true,
    }),
    box({
      x: col(2),
      y: 114,
      w: 224,
      h: 52,
      title: "Embedded services",
      lines: ["@comforge/cli · @comforge/mcp/host"],
      kind: "accent",
    }),
    arrow(col(0) + 112, 166, col(0) + 112, 196),
    arrow(col(1) + 112, 166, col(1) + 112, 196),
    arrow(col(2) + 112, 166, col(2) + 112, 196),
    box({
      x: 24,
      y: 198,
      w: W - 48,
      h: 52,
      title: "Lifecycle services — one implementation, one governance",
      lines: ["specification · start · verify · publish · complete · recover · cleanup"],
    }),
    arrow(col(0) + 112, 250, col(0) + 112, 286),
    arrow(col(1) + 112, 250, col(1) + 112, 286),
    arrow(col(2) + 112, 250, col(2) + 112, 286),
    `<text x="24" y="280" class="label">LIBRARIES</text>`,
    box({
      x: col(0),
      y: 288,
      w: 224,
      h: 56,
      title: "@comforge/core",
      lines: ["contracts and authorization", "pure: no I/O"],
      mono: true,
    }),
    box({
      x: col(1),
      y: 288,
      w: 224,
      h: 56,
      title: "@comforge/github",
      lines: ["typed, governed GitHub operations", "caller-authorized transport"],
      mono: true,
    }),
    box({
      x: col(2),
      y: 288,
      w: 224,
      h: 56,
      title: "@comforge/ledger",
      lines: ["durable operation records", "memory · file · SQLite"],
      mono: true,
    }),
    arrow(col(1) + 112, 344, col(1) + 112, 378),
    arrow(col(2) + 112, 344, col(2) + 112, 378),
    `<text x="24" y="374" class="label">WHAT IT TOUCHES</text>`,
    box({
      x: col(0),
      y: 380,
      w: 224,
      h: 46,
      title: "Git",
      lines: ["one isolated checkout per ticket"],
      kind: "outer",
    }),
    box({
      x: col(1),
      y: 380,
      w: 224,
      h: 46,
      title: "GitHub",
      lines: ["issues · pull requests · comments"],
      kind: "outer",
    }),
    box({
      x: col(2),
      y: 380,
      w: 224,
      h: 46,
      title: "Local state",
      lines: ["write-ahead ledger, initiative records"],
      kind: "outer",
    }),
    `<text x="24" y="452" class="t-sub">Never merges, approves, deploys or closes an issue: every approval stays with people.</text>`,
  ];
  return frame(
    W,
    470,
    "Comforge architecture",
    "Three interfaces — the comforge CLI, the comforge-mcp server and embedded services — call one set of lifecycle services built on @comforge/core (contracts and authorization, no I/O), @comforge/github (governed GitHub transport) and @comforge/ledger (durable operation records). They act on Git checkouts, GitHub and local state, and never merge, approve, deploy or close.",
    body,
  );
}

function lifecycle(): string {
  const W = 760;
  const steps: Array<[string, string, string]> = [
    ["spec publish", "specification issue", "with a digest"],
    ["start", "isolated checkout", "on agent/<ticket>"],
    ["agent works", "commits with", "a Ticket: trailer"],
    ["verify", "validation of the", "exact commit"],
    ["deliver", "pull request and", "completion record"],
  ];
  const bw = 128;
  const gap = (W - 48 - steps.length * bw) / (steps.length - 1);
  const x = (i: number) => 24 + i * (bw + gap);
  const body: string[] = [`<text x="24" y="30" class="label">THE GOVERNED PATH</text>`];
  steps.forEach(([title, a, b], i) => {
    body.push(
      box({
        x: x(i),
        y: 42,
        w: bw,
        h: 62,
        title,
        lines: [a, b],
        kind: i === 2 ? "plain" : "accent",
        mono: i !== 2,
      }),
    );
    if (i < steps.length - 1) body.push(arrow(x(i) + bw, 73, x(i + 1) - 2, 73));
  });
  const d = x(4);
  body.push(
    arrow(d + bw / 2, 104, d + bw / 2, 150),
    box({
      x: d - 40,
      y: 152,
      w: bw + 40,
      h: 52,
      title: "people review and merge",
      lines: ["on GitHub, never Comforge"],
      kind: "people",
    }),
    arrow(d - 40, 178, x(2) + 202, 178),
    box({
      x: x(2),
      y: 152,
      w: 200,
      h: 52,
      title: "cleanup",
      lines: ["checkout removed, record closed"],
      kind: "accent",
      mono: true,
    }),
    `<text x="24" y="246" class="label">WHEN DELIVER, RECOVER OR CLEANUP IS INTERRUPTED</text>`,
    box({
      x: 24,
      y: 258,
      w: 210,
      h: 52,
      title: "exit 4: incomplete",
      lines: ["a write's answer was lost"],
    }),
    arrow(234, 284, 268, 284),
    box({
      x: 270,
      y: 258,
      w: 210,
      h: 52,
      title: "recover --execute",
      lines: ["settle each write from GitHub"],
      kind: "accent",
      mono: true,
    }),
    arrow(480, 284, 514, 284),
    box({
      x: 516,
      y: 258,
      w: 220,
      h: 52,
      title: "rerun the same command",
      lines: ["no duplicate pull request"],
    }),
    `<text x="24" y="340" class="t-sub">Every GitHub write is recorded before it is sent; an unknown outcome is reconciled, never re-sent blindly.</text>`,
  );
  return frame(
    W,
    358,
    "Comforge lifecycle",
    "A ticket moves through spec publish, start (isolated checkout), the agent's commits, verify (validation of the exact commit) and deliver (pull request and completion record). People review and merge on GitHub; cleanup then removes the checkout. If a run is interrupted it exits 4; recover settles each recorded write from GitHub and the same command is rerun without creating a duplicate pull request.",
    body,
  );
}

export const DIAGRAMS: Record<string, () => string> = {
  [`${OUT}/architecture.svg`]: architecture,
  [`${OUT}/lifecycle.svg`]: lifecycle,
};

export function checkDiagrams(): string[] {
  return Object.entries(DIAGRAMS)
    .filter(
      ([rel, make]) =>
        !existsSync(path.join(REPO, rel)) || readFileSync(path.join(REPO, rel), "utf8") !== make(),
    )
    .map(
      ([rel]) => `${rel} differs from tooling/brand/diagrams.ts: run bun tooling/brand/diagrams.ts`,
    );
}

if (import.meta.main) {
  if (process.argv.includes("--check")) {
    const problems = checkDiagrams();
    for (const p of problems) console.log(p);
    process.exit(problems.length ? 1 : 0);
  }
  mkdirSync(path.join(REPO, OUT), { recursive: true });
  for (const [rel, make] of Object.entries(DIAGRAMS)) writeFileSync(path.join(REPO, rel), make());
  console.log(`wrote ${Object.keys(DIAGRAMS).length} diagrams to ${OUT}`);
}
