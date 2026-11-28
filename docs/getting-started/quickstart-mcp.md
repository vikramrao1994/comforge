# MCP quickstart

Status: published (`@comforge/mcp` 0.3.0). The server exposes the lifecycle as 18 tools in four
profiles; a principal sees only the tools its profiles permit.

Local stdio server for one repository (the agent client launches it):

```json
{
  "mcpServers": {
    "comforge": {
      "command": "npx",
      "args": ["-y", "@comforge/mcp@0.3.0", "--repository", "/path/to/repository", "--profile", "read-only"]
    }
  }
}
```

Start with `read-only`; add `executor` (start, revise, verify) and `publisher` (deliver, recover,
cleanup, publish a specification) only for a principal that should write. `reviewer` publishes
advisory reviews. Discover what is available with the `comforge_capabilities` tool.

The HTTP handler (`createHttpHandler`) is for a host that authenticates principals itself; see
[host services](../concepts/host-services.md) and the [MCP reference](../reference/mcp.md#deploying-the-http-handler).
The server never merges, approves, deploys, or runs a lifecycle write without the repository's
authorization mode allowing it.

Tested in CI, with what an agent sees per profile: [recipe 2](../recipes/02-mcp-for-coding-agents.md).
Per client: [integrations](../integrations/README.md). Every tool and flag: [MCP reference](../reference/mcp.md).
