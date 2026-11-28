/**
 * `bun tooling/demos/demos.ts [--check] [--demo NAME]` — records the terminal demonstrations in
 * docs/demos/ (text) and docs/assets/demos/ (SVG) by RUNNING each scenario, or (`--check`) runs
 * them again and fails when a committed file differs.
 *
 * Every scenario runs in the recipes' world (tooling/docs/recipes.ts): a throwaway repository
 * with a SYNTHETIC GitHub on 127.0.0.1 and `comforge` resolving to the PUBLISHED harness. What a
 * demo shows is the real output of those commands. Commit times and the synthetic server's port
 * are fixed, so commit SHAs and digests reproduce exactly; only these volatile values are
 * replaced, and each page says so: the temporary directory (→ `~`), timestamps (→ `<time>`) and
 * durations (→ `<ms>`).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PALETTE } from "../brand/brand";
import { createWorld, parseRecipe, RECIPES_DIR } from "../docs/recipes";

const REPO = path.resolve(import.meta.dir, "../..");
const TEXT_DIR = path.join(REPO, "docs/demos");
const SVG_DIR = path.join(REPO, "docs/assets/demos");

type Step = { comment: string } | { run: string; hidden?: true; fault?: string[]; exit?: number };
type Demo = { name: string; title: string; intro: string; recipe: string; steps: Step[] };

/** recipe 1's configuration block: the same trusted configuration every demo starts from. */
const configure = () =>
  parseRecipe("01", readFileSync(path.join(RECIPES_DIR, "01-first-governed-initiative.md"), "utf8"))
    .blocks[0]?.code as string;

const result = (ticket: string, checkout: string) => `cat > result.json <<EOF
{ "contract": "acme-completion/v1", "issueType": "implementation", "outcome": "completed",
  "sourceRevision": "$(git -C ${checkout} rev-parse HEAD)", "execution": { "runner": "my-agent", "model": "none" },
  "summary": "${ticket} done.", "sections": { "changed_behavior": "See the diff." },
  "findings": [], "changedArtifacts": [], "evidence": [],
  "validation": [{ "gate": "test", "command": "make test", "status": "PASS" }],
  "limitations": [], "nextSteps": [] }
EOF`;

/** Display filters, written into the shown command so the reader sees exactly what ran. */
const NO_STAGES = "| grep -v '^  stages:'";
const PRS = `comforge prs --json | jq -r '.pullRequests[] | "#\\(.number)  \\(.headRef)  \\(.title.text)"'`;

export const DEMOS: Demo[] = [
  {
    name: "first-workflow",
    title: "First governed workflow",
    intro: "One ticket from a published specification to a pull request with a completion record.",
    recipe: "01-first-governed-initiative.md",
    steps: [
      { run: configure(), hidden: true },
      { run: "printf 'Add a widget command.\\n' > spec.md", hidden: true },
      { comment: "Publish the specification the work must satisfy" },
      {
        run: 'comforge spec publish ACME-101 --title "ACME-101 — widget command" --body-file spec.md --execute',
      },
      { comment: "Start an isolated checkout for the ticket" },
      { run: "comforge start ACME-101 --issue 100" },
      { comment: "The agent works and commits in its checkout" },
      {
        run: "( cd ../widgets-agents/acme-101 && printf 'widget:\\n\\t@echo widget\\n' >> Makefile && git commit -qam $'feat: widget command\\n\\nTicket: ACME-101' )",
      },
      { comment: "Validate the exact committed head" },
      { run: "comforge verify ACME-101" },
      { run: result("ACME-101", "../widgets-agents/acme-101"), hidden: true },
      { comment: "Push, open the pull request and publish the completion record" },
      {
        run: `comforge deliver ACME-101 --title "Widget command" --result result.json --execute ${NO_STAGES}`,
      },
      { comment: "Every pull request on the repository" },
      { run: PRS },
    ],
  },
  {
    name: "parallel-agents",
    title: "Parallel agent development",
    intro:
      "Two agents work on two tickets at once, each in its own checkout, with no shared working tree.",
    recipe: "03-parallel-initiatives.md",
    steps: [
      { run: configure(), hidden: true },
      {
        run: [
          "printf 'Specification of ACME-201.\\n' > a.md && printf 'Specification of ACME-202.\\n' > b.md",
          'comforge spec publish ACME-201 --title "ACME-201 — parser" --body-file a.md --execute --json > /dev/null',
          'comforge spec publish ACME-202 --title "ACME-202 — formatter" --body-file b.md --execute --json > /dev/null',
        ].join("\n"),
        hidden: true,
      },
      { comment: "Two published specifications; one checkout per agent" },
      {
        run: "comforge start ACME-201 --issue 100 --json --summary | grep -E '^  \"(branch|initiative)\"'",
      },
      {
        run: "comforge start ACME-202 --issue 101 --json --summary | grep -E '^  \"(branch|initiative)\"'",
      },
      { comment: "Each agent commits in its own checkout" },
      {
        run: "git -C ../widgets-agents/acme-201 commit -q --allow-empty -m $'feat: parser\\n\\nTicket: ACME-201'",
      },
      {
        run: "git -C ../widgets-agents/acme-202 commit -q --allow-empty -m $'feat: formatter\\n\\nTicket: ACME-202'",
      },
      { comment: "Validation and state are per initiative" },
      { run: "comforge verify ACME-201 --json --summary | grep -E '^  \"(initiative|status)\"'" },
      { run: "comforge verify ACME-202 --json --summary | grep -E '^  \"(initiative|status)\"'" },
      {
        run: `${result("ACME-201", "../widgets-agents/acme-201")}\ncp result.json a.json\n${result("ACME-202", "../widgets-agents/acme-202")}\ncp result.json b.json`,
        hidden: true,
      },
      { comment: "Deliver both: two pull requests, two completion records" },
      {
        run: 'comforge deliver ACME-201 --title "Parser" --result a.json --execute --json --summary | grep \'"delivery"\'',
      },
      {
        run: 'comforge deliver ACME-202 --title "Formatter" --result b.json --execute --json --summary | grep \'"delivery"\'',
      },
      { run: PRS },
    ],
  },
  {
    name: "interrupted-recovery",
    title: "Interrupted-agent recovery",
    intro:
      "A delivery is cut off after GitHub applied a write but before its answer arrived. A second agent reconciles from the recorded state and finishes, without a duplicate pull request.",
    recipe: "04-interrupted-handover-and-recovery.md",
    steps: [
      { run: configure(), hidden: true },
      {
        run: [
          "printf 'Specification of ACME-301.\\n' > s.md",
          'comforge spec publish ACME-301 --title "ACME-301 — exporter" --body-file s.md --execute --json > /dev/null',
          "comforge start ACME-301 --issue 100 --json > /dev/null",
          "git -C ../widgets-agents/acme-301 commit -q --allow-empty -m $'feat: exporter\\n\\nTicket: ACME-301'",
          "comforge verify ACME-301 --json > /dev/null",
          result("ACME-301", "../widgets-agents/acme-301"),
        ].join("\n"),
        hidden: true,
      },
      {
        comment:
          "Agent A delivers; the connection drops after the pull request is created, then again before the completion comment",
      },
      {
        run: `comforge deliver ACME-301 --title "Exporter" --result result.json --execute ${NO_STAGES}`,
        fault: ["network-after", "network-before"],
        exit: 4,
      },
      { comment: "Agent B takes over from the recorded state and reconciles with GitHub" },
      { run: "comforge recover ACME-301 --execute", exit: 4 },
      { comment: "The comment was never created; give that one write up explicitly" },
      { run: "comforge recover ACME-301 --abandon --execute" },
      { comment: "Rerun the same delivery: the existing pull request is reused" },
      {
        run: `comforge deliver ACME-301 --title "Exporter" --result result.json --execute ${NO_STAGES}`,
      },
      { comment: "Still exactly one pull request" },
      { run: PRS },
    ],
  },
];

/** Replace the values that change between runs; everything else is printed as produced. */
export function normalize(text: string, root: string): string {
  const bare = root.replace(/^\/private/, "");
  const roots = [`/private${bare}`, bare];
  let out = text;
  for (const r of roots) out = out.split(r).join("~");
  return out
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, "<time>")
    .replace(/("durationMs":\s*)\d+/g, "$1<ms>")
    .replace(/[ \t]+$/gm, "");
}

/** The synthetic GitHub's port while recording; fixed so the recorded SHAs reproduce. */
const DEMO_PORT = 47_391;

type Transcript = { lines: Array<{ kind: "comment" | "command" | "output"; text: string }> };

export async function record(demo: Demo): Promise<Transcript> {
  const world = await createWorld("github", "node", {
    env: { GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z" },
    port: DEMO_PORT,
  });
  const lines: Transcript["lines"] = [];
  try {
    const root = (await world.run('printf %s "$ROOT"')).stdout;
    for (const step of demo.steps) {
      if ("comment" in step) {
        lines.push({ kind: "comment", text: `# ${step.comment}` });
        continue;
      }
      for (const f of step.fault ?? []) world.gh.faults.push(f as never);
      // pipefail: a display filter in a shown command never hides the command's exit status.
      const r = await world.run(`set -o pipefail\n${step.run}`);
      const expected = step.exit ?? 0;
      if (r.status !== expected)
        throw new Error(
          `${demo.name}: \`${step.run.split("\n")[0]}\` exited ${r.status}, expected ${expected}\n${r.stderr || r.stdout}`,
        );
      if (r.stdout.includes(world.token) || r.stderr.includes(world.token))
        throw new Error(`${demo.name}: the synthetic token appeared in output`);
      if (step.hidden) continue;
      lines.push({ kind: "command", text: `$ ${step.run}` });
      const output = normalize(`${r.stdout}${r.stderr}`, root).replace(/\n+$/, "");
      for (const l of output ? output.split("\n") : []) lines.push({ kind: "output", text: l });
      if (r.status !== 0) lines.push({ kind: "output", text: `[exit ${r.status}]` });
    }
  } finally {
    world.dispose();
  }
  return { lines };
}

function harnessVersions(): string {
  const deps = JSON.parse(readFileSync(path.join(REPO, "harness/package.json"), "utf8"))
    .dependencies as Record<string, string>;
  return ["@comforge/cli", "@comforge/mcp"].map((p) => `\`${p}\` ${deps[p]}`).join(", ");
}

export function renderText(demo: Demo, t: Transcript): string {
  const body = t.lines.map((l) => l.text).join("\n");
  return `<!-- Generated by tooling/demos/demos.ts. Do not edit; run \`bun tooling/demos/demos.ts\`. -->

# Demo: ${demo.title}

${demo.intro}

![${demo.title}: terminal recording](../assets/demos/${demo.name}.svg)

**What this is.** The real output of an executable scenario, recorded with the published
${harnessVersions()} against a **local synthetic GitHub** (127.0.0.1, repository \`acme/widgets\`):
nothing reaches github.com, and the credential is synthetic. Setup steps that are not shown
(writing the configuration and completion result) follow
[the recipe](../recipes/${demo.recipe}). Normalized: the temporary directory is shown as \`~\`,
timestamps as \`<time>\` and durations as \`<ms>\`. Commands run with \`set -o pipefail\`, so a display filter
(\`grep\`, \`jq\`) never hides an exit status. CI re-records it and fails on any difference (\`bun run validate demos\`).

## Text transcript

\`\`\`console
${body}
\`\`\`
`;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const COLS = 100;

/** A static terminal window: wrapped lines, commands in the accent, comments muted. */
export function renderSvg(demo: Demo, t: Transcript): string {
  const s = PALETTE.dark;
  const rows: Array<{ kind: string; text: string }> = [];
  for (const l of t.lines) {
    const chunks = l.text.match(new RegExp(`.{1,${COLS}}`, "g")) ?? [""];
    for (const [i, c] of chunks.entries()) rows.push({ kind: l.kind, text: i ? `  ${c}` : c });
    if (l.kind === "output" && l.text.startsWith("[exit")) rows.push({ kind: "gap", text: "" });
  }
  const lh = 18;
  const top = 44;
  const height = top + rows.length * lh + 18;
  const width = 16 + COLS * 7.8 + 24;
  const color = (k: string) => (k === "command" ? s.accent : k === "comment" ? s.muted : s.ink);
  const text = rows
    .map((r, i) =>
      r.text
        ? `<text x="16" y="${top + i * lh}" fill="${color(r.kind)}"${r.kind === "command" ? ' font-weight="600"' : ""} xml:space="preserve">${esc(r.text)}</text>`
        : "",
    )
    .filter(Boolean)
    .join("\n");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="t d"><title id="t">${esc(demo.title)} — Comforge terminal demo</title><desc id="d">${esc(demo.intro)} Text transcript: docs/demos/${demo.name}.md</desc>
<rect width="${width}" height="${height}" rx="10" fill="${s.canvas}" stroke="#30363d"/>
<circle cx="20" cy="16" r="5" fill="#484f58"/><circle cx="36" cy="16" r="5" fill="#484f58"/><circle cx="52" cy="16" r="5" fill="#484f58"/>
<text x="${width / 2}" y="20" fill="${s.muted}" text-anchor="middle" font-family="ui-sans-serif, -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif" font-size="12">${esc(demo.title)} · synthetic GitHub</text>
<g font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" font-size="13">
${text}
</g>
</svg>
`;
}

/**
 * Every ```console block in the root README must appear, line for line and contiguously, in a
 * recorded transcript: README output is never typed by hand.
 */
export function checkExcerpts(): string[] {
  const transcripts = DEMOS.map((d) =>
    existsSync(path.join(TEXT_DIR, `${d.name}.md`))
      ? readFileSync(path.join(TEXT_DIR, `${d.name}.md`), "utf8")
      : "",
  );
  const problems: string[] = [];
  const readme = readFileSync(path.join(REPO, "README.md"), "utf8");
  for (const m of readme.matchAll(/```console\n([\s\S]*?)\n```/g)) {
    const block = m[1] as string;
    if (!transcripts.some((t) => t.includes(`\n${block}\n`)))
      problems.push(
        `README.md: a console block starting "${block.split("\n")[0]}" is not in any docs/demos transcript`,
      );
  }
  return problems;
}

/** Problems with the committed demos (empty when re-recording reproduces them). */
export async function checkDemos(only?: string): Promise<string[]> {
  const problems: string[] = [];
  if (!existsSync(path.join(REPO, "harness/node_modules")))
    return ["harness is not installed: run bun run harness:install"];
  for (const demo of DEMOS.filter((d) => !only || d.name === only)) {
    let t: Transcript;
    try {
      t = await record(demo);
    } catch (e) {
      problems.push((e as Error).message);
      continue;
    }
    for (const [file, content] of [
      [path.join(TEXT_DIR, `${demo.name}.md`), renderText(demo, t)],
      [path.join(SVG_DIR, `${demo.name}.svg`), renderSvg(demo, t)],
    ] as const)
      if (!existsSync(file) || readFileSync(file, "utf8") !== content)
        problems.push(
          `${path.relative(REPO, file)} differs from a fresh recording: run bun tooling/demos/demos.ts`,
        );
  }
  return problems;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const only = argv.includes("--demo") ? argv[argv.indexOf("--demo") + 1] : undefined;
  if (argv.includes("--check")) {
    const problems = await checkDemos(only);
    for (const p of problems) console.log(p);
    process.exit(problems.length ? 1 : 0);
  }
  mkdirSync(TEXT_DIR, { recursive: true });
  mkdirSync(SVG_DIR, { recursive: true });
  for (const demo of DEMOS.filter((d) => !only || d.name === only)) {
    const t = await record(demo);
    writeFileSync(path.join(TEXT_DIR, `${demo.name}.md`), renderText(demo, t));
    writeFileSync(path.join(SVG_DIR, `${demo.name}.svg`), renderSvg(demo, t));
    console.log(`recorded ${demo.name} (${t.lines.length} lines)`);
  }
}
