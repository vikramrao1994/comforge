import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createHttpHandler, TOOL_NAMES } from "@comforge/mcp";

const here = path.dirname(fileURLToPath(import.meta.url));
const runtime = typeof globalThis.Bun === "undefined" ? `node ${process.versions.node}` : `bun ${process.versions.bun}`;
const checks = [];
const failed = [];
const check = (name, ok) => {
  checks.push(name);
  if (!ok) failed.push(name);
};

const root = mkdtempSync(path.join(tmpdir(), "acme-mcp-"));
const home = path.join(root, "home");
mkdirSync(home);
writeFileSync(path.join(home, "gitconfig"), "[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n");
const env = {
  PATH: process.env.PATH ?? "",
  HOME: home,
  GIT_CONFIG_GLOBAL: path.join(home, "gitconfig"),
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Acme",
  GIT_AUTHOR_EMAIL: "acme@example.invalid",
  GIT_COMMITTER_NAME: "Acme",
  GIT_COMMITTER_EMAIL: "acme@example.invalid",
};
const sh = (cwd, ...args) => {
  const r = spawnSync(args[0], args.slice(1), { cwd, env, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};

/** A repository with a bare remote and a committed configuration on main. */
function repository(name, files, validate) {
  const remote = path.join(root, `${name}.git`);
  const dir = path.join(root, name);
  sh(root, "git", "init", "--quiet", "--bare", remote);
  sh(root, "git", "clone", "--quiet", remote, dir);
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), text);
  }
  const config = {
    schema: "comforge-config/v1",
    repository: { owner: "acme", name, baseBranch: "main", remote: "origin" },
    validation: { commands: [{ name: "check", run: validate }] },
    context: { manifest: "routing.json" },
    security: { credentials: { source: "env", variable: "ACME_TOKEN" } },
  };
  writeFileSync(path.join(dir, "comforge.config.json"), `${JSON.stringify(config, null, 2)}\n`);
  writeFileSync(
    path.join(dir, "routing.json"),
    JSON.stringify({
      version: 1,
      categories: {
        build: { label: "Build", description: "Build system", triggers: ["build", "makefile", "tsconfig"], files: [Object.keys(files)[0]], guidance: [], validation: [] },
      },
    }),
  );
  sh(dir, "git", "add", ".");
  sh(dir, "git", "commit", "--quiet", "-m", "initial");
  sh(dir, "git", "push", "--quiet", "origin", "main");
  return dir;
}

const text = (r) => JSON.parse(r.content[0].text);

try {
  const make = repository("gadgets", { Makefile: "check:\n\t@true\n" }, ["make", "check"]);
  const ts = repository(
    "sprockets",
    { "tsconfig.json": "{\"compilerOptions\":{\"strict\":true}}\n", "src/index.ts": "export const n: number = 1;\n" },
    ["sh", "-c", "test -f src/index.ts"],
  );

  // --- stdio: the installed executable, operator-chosen repositories and profile ---
  const bin = path.join(here, "node_modules", "@comforge", "mcp", "dist", "bin.js");
  const client = new Client({ name: "acme", version: "0" });
  await client.connect(
    new StdioClientTransport({ command: process.execPath, args: [bin, "--repository", make, "--repository", ts], env, stderr: "pipe" }),
  );
  const tools = (await client.listTools()).tools.map((t) => t.name);
  check("stdio: read-only by default", tools.includes("comforge_status") && !tools.includes("comforge_start"));
  const caps = text(await client.callTool({ name: "comforge_capabilities", arguments: {} }));
  check("stdio: both repositories allowlisted", JSON.stringify(caps.data.repositories) === JSON.stringify(["gadgets", "sprockets"]));
  check("stdio: cleanup executes only under its own authorization", caps.data.cleanup.execute === true && /publication grant never/.test(caps.data.cleanup.authorization));
  for (const id of ["gadgets", "sprockets"]) {
    const s = text(await client.callTool({ name: "comforge_status", arguments: { repository: id } }));
    check(`stdio: ${id} status`, s.ok === true && Array.isArray(s.data.initiatives));
  }
  const routed = text(await client.callTool({ name: "comforge_context", arguments: { repository: "sprockets", task: "fix the tsconfig" } }));
  check("stdio: context routes in the TypeScript repository", routed.data.match?.id === "build");
  const routedMake = text(await client.callTool({ name: "comforge_context", arguments: { repository: "gadgets", task: "the makefile build" } }));
  check("stdio: context routes in the Makefile repository", routedMake.data.match?.id === "build");
  const unknown = await client.callTool({ name: "comforge_status", arguments: { repository: "elsewhere" } });
  check("stdio: an unlisted repository is refused", unknown.isError === true && text(unknown).code === "unknown-repository");
  const forged = await client.callTool({ name: "comforge_status", arguments: { repository: "gadgets", root: "/" } });
  check("stdio: a forged field is refused", forged.isError === true);
  await client.close();

  // --- HTTP: the host mounts the handler and authenticates ---
  const handler = createHttpHandler({
    repositories: [{ id: "gadgets", root: make, owner: "acme", name: "gadgets" }],
    host: { runtime: (b) => ({ cwd: b.root, env, now: Date.now, run: (c, a, o) => { const r = spawnSync(c, a, { cwd: o.cwd, env: o.env ?? env, encoding: "utf8", timeout: o.timeoutMs }); return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "", timedOut: false }; } }) },
    authenticate: (req) => (req.headers.get("authorization") === "Bearer acme-reader" ? { id: "reader", profiles: ["executor", "publisher"], repositories: ["gadgets"] } : null),
    allowedHosts: ["mcp.acme.test"],
    allowedOrigins: [],
  });
  const fetchVia = async (url, init) => {
    const headers = new Headers(init?.headers);
    headers.set("host", "mcp.acme.test");
    return handler.handle(new Request(url, { ...init, headers }));
  };
  const anonymous = await fetchVia("https://mcp.acme.test/mcp", { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
  check("http: unauthenticated is 401", anonymous.status === 401);
  const remote = new Client({ name: "acme-remote", version: "0" });
  await remote.connect(
    new StreamableHTTPClientTransport(new URL("https://mcp.acme.test/mcp"), {
      fetch: fetchVia,
      requestInit: { headers: { authorization: "Bearer acme-reader" } },
    }),
  );
  const remoteTools = (await remote.listTools()).tools.map((t) => t.name);
  check("http: no executing tool without host isolation", !remoteTools.includes("comforge_start") && !remoteTools.includes("comforge_deliver"));
  check("http: read tools are listed", remoteTools.includes("comforge_pr") && remoteTools.length < TOOL_NAMES.length);
  const remoteStatus = text(await remote.callTool({ name: "comforge_status", arguments: { repository: "gadgets" } }));
  check("http: status over HTTP", remoteStatus.ok === true);
  await remote.close();
  await handler.close();
} catch (error) {
  failed.push(`error: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  rmSync(root, { recursive: true, force: true });
}

process.stdout.write(`${JSON.stringify({ runtime, checks, failed })}\n`);
process.exit(failed.length === 0 ? 0 : 1);
