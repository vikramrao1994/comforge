---
name: comforge-mcp-setup
description: Connect an agent client to the Comforge MCP server with the least-privileged tool profile.
category: consumer
---

# comforge-mcp-setup

Connect an agent client to the Comforge MCP server with the least-privileged tool profile.

## When to use

- The user wants an agent client (Claude Code, Codex, other MCP clients) to use Comforge tools.

## Prerequisites

- `@comforge/mcp` available (npx or installed); a configured repository.

## Examples

```sh
// .mcp.json (or the client's equivalent)
{ "mcpServers": { "comforge": { "command": "npx",
  "args": ["-y", "@comforge/mcp@0.3.0", "--repo", ".", "--profile", "read-only"] } } }
# then call the comforge_capabilities tool
```

## Decision rules

- Start with `read-only`; add `executor` and `publisher` only for a principal that should write; `reviewer` only publishes advisory reviews.
- Discover tools through `comforge_capabilities` rather than assuming them.

## Security boundaries

- The HTTP handler is for a host that authenticates principals itself; never expose it unauthenticated.
- Every call re-checks the profile; do not try to call a tool the profile hides.

## Validation

```sh
Call comforge_capabilities: the listed profiles and tools match what you configured.
```

## Failure and recovery

- A tool is missing: the principal's profile does not permit it.
- `repository-not-configured`: pass `--repo` pointing at a repository with `comforge.config.json`.

## References

- [docs/getting-started/quickstart-mcp.md](../../docs/getting-started/quickstart-mcp.md)
- [packages/mcp/README.md#tools](../../packages/mcp/README.md#tools)
- [docs/recipes/02-mcp-for-coding-agents.md](../../docs/recipes/02-mcp-for-coding-agents.md)
- [docs/integrations/README.md](../../docs/integrations/README.md)
- [docs/reference/mcp.md](../../docs/reference/mcp.md)
