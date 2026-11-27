/**
 * `bun tooling/benchmarks/measure.ts [--out FILE]` — component-level context measurements of
 * the PUBLISHED harness (`harness/`: the exact `@comforge/cli` and `@comforge/mcp` releases),
 * credential-free and model-free, in the recipes' synthetic world.
 *
 * What it measures is the size of exact texts an agent would read: characters, and an
 * APPROXIMATE token count (`ceil(chars / 4)`; no tokenizer runs here, so ratios are reliable and
 * absolute token counts are not). It measures single calls of single components. It does not
 * measure an agent, a session's total cost, an end-to-end saving, or any competitor.
 *
 * Cases: MCP discovery per profile (default and compact), CLI help + capabilities, every
 * initiative's status as CLI JSON (indented, compact, summary) and as MCP results (every page,
 * text content), and one initiative's full record against its MCP summary.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createWorld } from "../docs/recipes";

const REPO = path.resolve(import.meta.dir, "../..");
export const MEASUREMENTS_SCHEMA = "comforge-component-measurements/v1";
export const DEFAULT_OUT = "evidence/benchmarks/component-measurements.json";
const INITIATIVES = 12;

const size = (text: string) => ({ chars: text.length, approxTokens: Math.ceil(text.length / 4) });

const CONFIG = `cat > Makefile <<'EOF'
test:
\t@true
EOF
cat > comforge.config.json <<EOF
{ "schema": "comforge-config/v1",
  "repository": { "owner": "acme", "name": "widgets", "baseBranch": "main", "remote": "origin", "apiOrigin": "$COMFORGE_API_ORIGIN" },
  "validation": { "commands": [{ "name": "test", "run": ["make", "test"] }] },
  "specification": { "required": true, "digestScheme": "acme-spec/v1", "markerNamespace": "acme-spec", "publisherName": "Acme Specs", "publishToolName": "acme_create_issue" },
  "security": { "capabilities": ["pulls:create", "pulls:update", "issues:comment", "issues:create"],
                "credentials": { "source": "env", "variable": "ACME_TOKEN" }, "authorization": { "mode": "operator" } } }
EOF
git add . && git commit -qm configure && git push -q origin main`;

const PROBE = `import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const [mode, ...rest] = process.argv.slice(2);
const compact = mode === "compact";
const profiles = rest.flatMap((p) => ["--profile", p]);
const t = new StdioClientTransport({ command: "comforge-mcp", args: ["--repository", process.cwd(), ...profiles, ...(compact ? ["--compact-discovery"] : [])], env: process.env });
const c = new Client({ name: "measure", version: "1.0.0" });
await c.connect(t);
const out = { toolsList: JSON.stringify(await c.listTools()) };
if (rest.includes("read-only") && rest.length === 1) {
  const pages = [];
  let cursor;
  do {
    const r = await c.callTool({ name: "comforge_status", arguments: { repository: "widgets", ...(cursor ? { cursor } : {}) } });
    pages.push(r);
    cursor = r.structuredContent?.page?.next ?? null;
  } while (cursor);
  out.statusPages = pages.length;
  out.statusText = pages.map((p) => p.content.map((x) => x.text).join("")).join("");
  out.statusStructured = pages.map((p) => JSON.stringify(p.structuredContent)).join("");
  // Equivalent content: one call per initiative, as an agent that needs every record does.
  const each = [];
  for (let i = 1; i <= Number(process.env.MEASURE_INITIATIVES); i++) {
    const id = "ACME-" + String(i).padStart(3, "0");
    each.push(await c.callTool({ name: "comforge_status", arguments: { repository: "widgets", initiative: id } }));
  }
  out.eachCalls = each.length;
  out.eachText = each.map((p) => p.content.map((x) => x.text).join("")).join("");
  out.oneSummaryText = each[0].content.map((x) => x.text).join("");
}
console.log(JSON.stringify(out));
await c.close();`;

export async function measure() {
  const w = await createWorld("github", "node");
  const sh = async (code: string) => {
    const r = await w.run(code);
    if (r.status !== 0) throw new Error(`${code.slice(0, 80)}…: ${r.stderr.slice(0, 400)}`);
    return r.stdout;
  };
  try {
    await sh(CONFIG);
    for (let i = 1; i <= INITIATIVES; i++) {
      const id = `ACME-${String(i).padStart(3, "0")}`;
      await sh(
        `printf 'Spec ${i}.\\n' > s.md && comforge spec publish ${id} --title "${id} — item" --body-file s.md --execute --json > s.json && I=$(node -p 'require("./s.json").issueNumber') && comforge start ${id} --issue "$I" --json > st.json && C=$(node -p 'require("./st.json").checkout') && (cd "$C" && echo ${i} > f${i}.txt && git add . && git commit -qm $'feat: item\\n\\nTicket: ${id}') && comforge verify ${id} --json > /dev/null`,
      );
    }
    await sh(`cat > "$WORK/measure-probe.mjs" <<'EOF'\n${PROBE}\nEOF`);
    const cli = {
      help: await sh("comforge --help"),
      capabilities: await sh("comforge capabilities --json"),
      statusAll: await sh("comforge status --json"),
      statusAllCompact: await sh("comforge status --json --compact"),
      statusAllSummary: await sh("comforge status --json --summary --compact"),
      statusOne: await sh("comforge status ACME-001 --json"),
      statusOneCompact: await sh("comforge status ACME-001 --json --compact"),
    };
    const mcp: Record<string, Record<string, unknown>> = {};
    for (const [label, args] of [
      ["read-only", "default read-only"],
      ["read-only (compact)", "compact read-only"],
      ["executor+publisher", "default read-only executor publisher"],
      ["executor+publisher (compact)", "compact read-only executor publisher"],
    ] as const)
      mcp[label] = JSON.parse(
        await sh(`MEASURE_INITIATIVES=${INITIATIVES} node "$WORK/measure-probe.mjs" ${args}`),
      );
    const ro = mcp["read-only"] as {
      statusText: string;
      statusStructured: string;
      statusPages: number;
      eachText: string;
      eachCalls: number;
      oneSummaryText: string;
    };
    const node = (await sh("node --version")).trim();
    const discovery = Object.fromEntries(
      Object.entries(mcp).map(([k, v]) => {
        const list = JSON.parse(v.toolsList as string) as { tools: unknown[] };
        return [k, { tools: list.tools.length, ...size(v.toolsList as string) }];
      }),
    );
    const harness = JSON.parse(
      readFileSync(path.join(REPO, "harness/package.json"), "utf8"),
    ).dependencies;
    const pct = (from: number, to: number) => Math.round((1 - to / from) * 1000) / 10;
    const d = discovery as Record<string, { chars: number }>;
    return {
      schema: MEASUREMENTS_SCHEMA,
      versions: harness,
      runtime: `node ${node}`,
      method: {
        texts:
          "exact stdout of the CLI with the flags shown; the MCP JSON-RPC tools/list result and tool results' text content, from the official MCP SDK client over stdio",
        tokens:
          "approxTokens = ceil(chars / 4); no tokenizer. Compare ratios, not absolute tokens, with historical tokenizer counts",
        fixture: `${INITIATIVES} verified initiatives in a synthetic repository; synthetic GitHub on 127.0.0.1`,
        equivalence:
          "‘equivalent’ = the same information; ‘summary’ = less information (not equivalent)",
      },
      discovery,
      cliDiscovery: {
        helpPlusCapabilities: size(cli.help + cli.capabilities),
        help: size(cli.help),
        capabilities: size(cli.capabilities),
      },
      tasks: [
        {
          task: `every initiative's status (${INITIATIVES})`,
          kind: "equivalent",
          cliJson: size(cli.statusAll),
          cliCompact: size(cli.statusAllCompact),
          mcpText: { calls: ro.eachCalls, ...size(ro.eachText) },
        },
        {
          task: `every initiative's status (${INITIATIVES})`,
          kind: "summary",
          cliSummary: size(cli.statusAllSummary),
          mcpListText: { calls: ro.statusPages, ...size(ro.statusText) },
          mcpListStructured: size(ro.statusStructured),
        },
        {
          task: "one initiative: full record vs first answer",
          kind: "summary",
          cliJson: size(cli.statusOne),
          cliCompact: size(cli.statusOneCompact),
          mcpSummaryText: size(ro.oneSummaryText),
        },
      ],
      derived: {
        compactDiscoveryReductionPercent: {
          "read-only": pct(d["read-only"]?.chars ?? 0, d["read-only (compact)"]?.chars ?? 0),
          "executor+publisher": pct(
            d["executor+publisher"]?.chars ?? 0,
            d["executor+publisher (compact)"]?.chars ?? 0,
          ),
        },
        cliCompactReductionPercent: {
          statusAll: pct(cli.statusAll.length, cli.statusAllCompact.length),
          statusOne: pct(cli.statusOne.length, cli.statusOneCompact.length),
        },
        // Positive = MCP larger. Against indented and against compact CLI JSON.
        mcpVsCliEquivalentStatusPercent:
          Math.round((ro.eachText.length / cli.statusAll.length - 1) * 1000) / 10,
        mcpVsCliCompactEquivalentStatusPercent:
          Math.round((ro.eachText.length / cli.statusAllCompact.length - 1) * 1000) / 10,
        summaryFirstVsCliFullPercent: {
          everyInitiative: pct(cli.statusAll.length, ro.statusText.length),
          oneInitiative: pct(cli.statusOne.length, ro.oneSummaryText.length),
        },
      },
    };
  } finally {
    w.dispose();
  }
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const out = argv.includes("--out") ? (argv[argv.indexOf("--out") + 1] as string) : DEFAULT_OUT;
  const result = await measure();
  mkdirSync(path.dirname(path.join(REPO, out)), { recursive: true });
  writeFileSync(path.join(REPO, out), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result.derived, null, 2));
}
