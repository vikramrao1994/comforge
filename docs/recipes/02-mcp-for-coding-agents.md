# Recipe 2 — give a coding agent governed tools over MCP

<!-- recipe: {"world": "github"} -->

Run the published `comforge-mcp` stdio server (`@comforge/mcp` 0.3.0, published) for one
repository and one profile, register it with an agent client, and check what the agent can see
and call. The server calls the CLI's lifecycle services in process; it adds no authority.

**Prerequisites:** a configured repository (the configuration must be on the base branch,
[recipe 1](01-first-governed-initiative.md) step 1) and
`npm install --save-dev --save-exact @comforge/cli @comforge/mcp`.

**How this page is tested.** CI runs every `sh` block in a throwaway clone of `acme/widgets`
whose GitHub is a local synthetic server. The client in step 3 is the official MCP TypeScript
SDK, standing in for an agent client; it is not a test of Claude Code, Codex or Cursor
themselves (see [integrations](../integrations/)).

## 1. Configure the repository

```sh recipe
cat > Makefile <<'EOF'
test:
	@echo "tests pass"
EOF
cat > comforge.config.json <<EOF
{
  "schema": "comforge-config/v1",
  "repository": { "owner": "acme", "name": "widgets", "baseBranch": "main", "remote": "origin",
                  "apiOrigin": "$COMFORGE_API_ORIGIN" },
  "validation": { "commands": [{ "name": "test", "run": ["make", "test"] }] },
  "security": { "credentials": { "source": "env", "variable": "ACME_TOKEN" } }
}
EOF
git add Makefile comforge.config.json && git commit -qm "chore: configure comforge" && git push -q origin main
```

## 2. Register the server with your client

The operator chooses the repositories and profiles at launch; a caller can never widen them.
Start with `read-only`. Claude Code reads `.mcp.json` in the project root:

```json
{
  "mcpServers": {
    "comforge": {
      "command": "npx",
      "args": ["comforge-mcp", "--repository", ".", "--profile", "read-only", "--compact-discovery"]
    }
  }
}
```

Codex (`~/.codex/config.toml`) and Cursor (`.cursor/mcp.json`) take the same command and
arguments; see [integrations](../integrations/). Add `--profile executor` to let the agent start
and verify initiatives, and `--profile publisher` to let it deliver. `--compact-discovery` leaves
output schemas out of `tools/list`, which makes discovery smaller.

## 3. See what the agent sees

```sh recipe
cat > "$WORK/probe.mjs" <<'EOF'
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const profiles = process.argv.slice(2).flatMap((p) => ["--profile", p]);
const transport = new StdioClientTransport({
  command: "comforge-mcp",
  args: ["--repository", process.cwd(), ...profiles, "--compact-discovery"],
  env: process.env,
});
const client = new Client({ name: "probe", version: "1.0.0" });
await client.connect(transport);
const { tools } = await client.listTools();
const status = await client.callTool({ name: "comforge_status", arguments: { repository: "widgets" } });
console.log(JSON.stringify({ tools: tools.map((t) => t.name), status: status.structuredContent }));
await client.close();
EOF
node "$WORK/probe.mjs" read-only
```
<!-- recipe-expect: {"json": {"tools.length": 10, "status.ok": true}} -->

`read-only` lists ten tools: capabilities, context, status, evidence, issue, pr, prs, comments,
reviews and artifact. Every result is a versioned envelope
(`{"schema": "comforge-mcp/v1", "ok": true, "summary", "data"}`), bounded and redacted.

```sh recipe
node "$WORK/probe.mjs" read-only executor publisher
```
<!-- recipe-expect: {"json": {"tools.length": 17}} -->

With `executor` and `publisher` the agent also sees `comforge_start`, `comforge_revise`,
`comforge_verify`, `comforge_deliver`, `comforge_recover`, `comforge_cleanup` and
`comforge_publish_specification` (the reviewer's `comforge_publish_review` needs `reviewer`).

## Errors

| Code | Cause |
|---|---|
| `profile-denied` | the tool needs a profile the server was not launched with |
| `unknown-repository` | the `repository` id is not one the server was given (`widgets` here: the configured name, lowercased) |
| `authorization-required` | a write tool ran without `security.authorization` in the trusted configuration |

## Side effects, security, cleanup

- **Nothing is written** in this recipe. Over stdio the trust boundary is the local user: there is
  no authentication, and repository commands run as you.
- **Credentials** come from the repository's `security.credentials` source, read by the server and
  never returned to the agent.
- **Over HTTP** (`createHttpHandler`), the executing tools are not even listed unless the host
  supplies an `IsolationProvider`; see [`@comforge/mcp`](../../packages/mcp/README.md).
- **Cleanup:** remove the `mcpServers.comforge` entry.
