/**
 * The authoritative public contracts of the five packages, read from their own sources: the
 * CLI's command table, global flags, error and exit codes; the MCP server's tools, profiles,
 * error codes and launch flags; the configuration JSON Schema; and every runtime export of
 * every published subpath. The reference generator, the drift checks and the audit all read
 * this module, so documentation can only describe what the code declares.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

export const REPO = path.resolve(import.meta.dir, "../..");
export const PACKAGES = ["core", "github", "ledger", "cli", "mcp"] as const;
export type PackageId = (typeof PACKAGES)[number];

const read = (rel: string) => readFileSync(path.join(REPO, rel), "utf8");

export function packageVersion(id: PackageId): string {
  return (JSON.parse(read(`packages/${id}/package.json`)) as { version: string }).version;
}

export type CliCommand = {
  name: string;
  usage: string;
  summary: string;
  writes: string;
  dryRunByDefault: boolean;
  flags: string[];
};

/** `--flag` tokens of a usage line, without values. */
export function flagsOf(usage: string): string[] {
  return [...new Set([...usage.matchAll(/--[a-z][a-z-]*/g)].map((m) => m[0]))].sort();
}

export async function cliContracts() {
  const agent = (await import(path.join(REPO, "packages/cli/src/commands/agent.ts"))) as {
    COMMANDS: {
      name: string;
      usage: string;
      summary: string;
      writes: string;
      dryRunByDefault?: boolean;
    }[];
  };
  const commands: CliCommand[] = agent.COMMANDS.map((c) => ({
    name: c.name,
    usage: c.usage,
    summary: c.summary,
    writes: c.writes,
    dryRunByDefault: c.dryRunByDefault === true,
    flags: flagsOf(c.usage),
  }));
  const errors = (await import(path.join(REPO, "packages/cli/src/errors.ts"))) as {
    ERROR_CODES: Record<string, number>;
    EXIT: Record<string, number>;
  };
  const agentSource = read("packages/cli/src/commands/agent.ts");
  const globalFlags = flagsOf(agentSource.match(/globalFlags: \[([^\]]+)\]/)?.[1] ?? "");
  if (globalFlags.length === 0) throw new Error("the CLI's global flags were not found");
  return {
    version: packageVersion("cli"),
    commands,
    globalFlags,
    errorCodes: errors.ERROR_CODES,
    exitCodes: errors.EXIT,
  };
}

export async function mcpContracts() {
  const c = (await import(path.join(REPO, "packages/mcp/src/contracts.ts"))) as {
    TOOLS: Record<
      string,
      {
        name: string;
        title: string;
        description: string;
        profiles: readonly string[];
        executes: boolean;
        writes: boolean;
        destructive: boolean;
      }
    >;
    PROFILES: readonly string[];
  };
  const r = (await import(path.join(REPO, "packages/mcp/src/results.ts"))) as {
    MCP_CODES: Record<string, string>;
  };
  const tools = (await import(path.join(REPO, "packages/mcp/src/tools.ts"))) as {
    REMOTE_READ_TOOLS: readonly string[];
  };
  const bin = read("packages/mcp/src/bin.ts");
  const usage = bin.match(/usage: comforge-mcp ([^`\n]+)/)?.[1] ?? "";
  return {
    version: packageVersion("mcp"),
    tools: Object.values(c.TOOLS),
    profiles: [...c.PROFILES],
    errorCodes: r.MCP_CODES,
    remoteReadTools: [...tools.REMOTE_READ_TOOLS],
    binFlags: flagsOf(usage.replace(/\$\{[^}]+\}/g, "")),
    transports: ["stdio (`comforge-mcp`, `serveStdio`)", "HTTP (`createHttpHandler`)"],
  };
}

type SchemaNode = {
  properties?: Record<string, unknown>;
  anyOf?: SchemaNode[];
  oneOf?: SchemaNode[];
};

/** Property names of an object schema, through `anyOf`/`oneOf` alternatives (nullable sections). */
function keysOf(node: SchemaNode): string[] {
  const own = Object.keys(node.properties ?? {});
  const alts = [...(node.anyOf ?? []), ...(node.oneOf ?? [])].flatMap(keysOf);
  return [...new Set([...own, ...alts])].sort();
}

export async function configContracts() {
  const cfg = (await import("@comforge/cli/config")) as { configJsonSchema: () => unknown };
  const schema = cfg.configJsonSchema() as {
    properties: Record<string, SchemaNode>;
    required?: string[];
  };
  const sections = Object.entries(schema.properties)
    .filter(([k]) => k !== "$schema")
    .map(([name, s]) => ({
      name,
      required: (schema.required ?? []).includes(name),
      keys: keysOf(s),
    }));
  return { schema, sections };
}

/** Every published subpath (package.json `exports`, minus `./package.json`). */
export function subpaths(id: PackageId): string[] {
  const exp = (
    JSON.parse(read(`packages/${id}/package.json`)) as { exports: Record<string, string> }
  ).exports;
  return Object.keys(exp)
    .filter((k) => k !== "./package.json")
    .map((k) => (k === "." ? `@comforge/${id}` : `@comforge/${id}${k.slice(1)}`));
}

export type ExportEntry = { specifier: string; name: string; kind: string; summary: string };

function sourceFiles(id: PackageId): string[] {
  const dir = path.join(REPO, `packages/${id}/src`);
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".ts")) out.push(p);
    }
  };
  walk(dir);
  return out;
}

/** The first sentence of the doc comment above `name`'s declaration, if any. */
function summaryOf(texts: string[], name: string): string {
  const decl = new RegExp(
    `(/\\*\\*(?:(?!\\*/)[\\s\\S])*\\*/)\\s*export\\s+(?:async\\s+)?(?:function|const|class|let)\\s+${name}\\b`,
  );
  for (const t of texts) {
    const m = t.match(decl);
    if (!m?.[1]) continue;
    const text = m[1]
      .replace(/^\/\*\*|\*\/$/g, "")
      .split("\n")
      .map((l) => l.replace(/^\s*\*\s?/, ""))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    const sentence = text.match(/^(.+?[.!?])(\s|$)/)?.[1] ?? text;
    return sentence.length > 160 ? `${sentence.slice(0, 157)}…` : sentence;
  }
  return "";
}

export async function apiContracts(): Promise<ExportEntry[]> {
  const out: ExportEntry[] = [];
  for (const id of PACKAGES) {
    const texts = sourceFiles(id).map((f) => readFileSync(f, "utf8"));
    for (const specifier of subpaths(id)) {
      const mod = (await import(specifier)) as Record<string, unknown>;
      for (const name of Object.keys(mod).sort()) {
        const v = mod[name];
        const kind =
          typeof v === "function"
            ? /^class\s/.test(Function.prototype.toString.call(v))
              ? "class"
              : "function"
            : v && typeof v === "object" && "safeParse" in (v as object)
              ? "schema"
              : "constant";
        out.push({ specifier, name, kind, summary: summaryOf(texts, name) });
      }
    }
  }
  return out;
}
