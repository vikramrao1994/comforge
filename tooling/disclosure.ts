/**
 * `bun run disclosure` — the public-disclosure scan of every tracked file (and every file about
 * to be committed). It applies the release scan's rules (tooling/release/mirror.ts) plus rules
 * for a public source repository: references to private repositories, private ticket ids,
 * machine paths and application terms. Exceptions are listed, each with its reason, in
 * tooling/disclosure-allow.json; an exception that no longer matches anything is itself an error.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { DISCLOSURE_RULES } from "./release/mirror";

const REPO = path.resolve(import.meta.dir, "..");
const PUBLIC_REPOSITORY = "vikramrao1994/comforge";
const SYNTHETIC_TICKETS =
  /^(DEMO|OTHER|ACME|EXAMPLE|TICKET|GLOBEX|WIDGET|TEST|FOO|BAR|SECRET|SHA|UTF|ISO|RFC|AES)\b/;

export const REPOSITORY_RULES: ReadonlyArray<{ id: string; pattern: RegExp }> = [
  ...DISCLOSURE_RULES.filter(
    (r) => r.id !== "env-file" && r.id !== "owner-identity" && r.id !== "portfolio-path",
  ),
  // The owner's public login appears only as this repository's identity (allowed below).
  { id: "owner-identity", pattern: /vikram/i },
  { id: "private-repository", pattern: /\bportfolio\b/i },
  {
    id: "private-path",
    pattern:
      /\b(?:docs\/engineering|src\/lib|src\/app|scripts\/(?:engineering|git|factory-core|db|diagnostics)|tests\/unit|packages\/factory-[a-z]+|context-engine|mcp\/comforge)\b/,
  },
  { id: "machine-path", pattern: /\bDesktop\/|\/private\/tmp\/claude|\/var\/folders\// },
  {
    id: "app-term",
    pattern: /\b(?:fly\.io|flyctl|next-intl|kern-react|photography|cover letter|curator)\b/i,
  },
];
const TICKET = /\b[A-Z][A-Z0-9]{2,}(?:-[A-Z0-9]+)*-\d{3}[A-Z]?\b/g;

export type Finding = { file: string; line: number; rule: string; text: string };
type Allow = { path: string; rule: string; reason: string; contains?: string };

export function trackedFiles(): string[] {
  const r = spawnSync("git", ["ls-files", "-co", "--exclude-standard", "-z"], {
    cwd: REPO,
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.split("\0").filter(Boolean);
}

const glob = (pattern: string) =>
  new RegExp(
    `^${pattern
      .split("**")
      .map((part) => part.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*"))
      .join(".*")}$`,
  );

export function scan(files = trackedFiles()): { findings: Finding[]; unusedAllowances: Allow[] } {
  const allow = (
    JSON.parse(readFileSync(path.join(REPO, "tooling", "disclosure-allow.json"), "utf8")) as {
      allow: Allow[];
    }
  ).allow;
  const used = new Set<Allow>();
  const findings: Finding[] = [];
  for (const file of files) {
    if (/\.(tgz|png|jpg|ico|lockb)$/.test(file) || file === "tooling/disclosure-allow.json")
      continue;
    let text: string;
    try {
      text = readFileSync(path.join(REPO, file), "utf8");
    } catch {
      continue;
    }
    if (/(^|\/)\.env(\.|$)/.test(file))
      findings.push({ file, line: 0, rule: "env-file", text: "" });
    text.split("\n").forEach((raw, index) => {
      const line = raw
        .replaceAll(`github.com/${PUBLIC_REPOSITORY}`, "github.com/<repository>")
        .replaceAll(PUBLIC_REPOSITORY, "<repository>");
      const hits: string[] = [];
      for (const rule of REPOSITORY_RULES) if (rule.pattern.test(line)) hits.push(rule.id);
      for (const m of line.matchAll(TICKET))
        if (!SYNTHETIC_TICKETS.test(m[0])) hits.push("internal-ticket");
      for (const rule of new Set(hits)) {
        const a = allow.find(
          (x) =>
            x.rule === rule && glob(x.path).test(file) && (!x.contains || raw.includes(x.contains)),
        );
        if (a) used.add(a);
        else findings.push({ file, line: index + 1, rule, text: raw.trim().slice(0, 160) });
      }
    });
  }
  return { findings, unusedAllowances: allow.filter((a) => !used.has(a)) };
}

if (import.meta.main) {
  const { findings, unusedAllowances } = scan();
  const json = process.argv.includes("--json");
  if (json) console.log(JSON.stringify({ findings, unusedAllowances }, null, 2));
  else {
    for (const f of findings) console.log(`${f.file}:${f.line} ${f.rule}  ${f.text}`);
    for (const a of unusedAllowances) console.log(`unused allowance: ${a.path} ${a.rule}`);
    console.log(
      findings.length + unusedAllowances.length === 0
        ? "disclosure scan: clean"
        : `disclosure scan: ${findings.length} finding(s), ${unusedAllowances.length} unused allowance(s)`,
    );
  }
  process.exit(findings.length + unusedAllowances.length === 0 ? 0 : 1);
}
