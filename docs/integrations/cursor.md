# Cursor

**Verification: untested.** Cursor was not available on the verification machine; this page
gives the configuration shape Cursor documents for stdio MCP servers. The server side is
tested by [recipe 2](../recipes/02-mcp-for-coding-agents.md).

## MCP (stdio)

`.cursor/mcp.json` in the project:

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

## CLI instead of MCP

A rule in `.cursor/rules`:

```text
Use `npx comforge <command> --json` for the ticket lifecycle. Never push or open pull requests by
hand. Dry-run before `--execute`.
```

## CLI or MCP?

| | CLI | MCP (stdio) |
|---|---|---|
| Agent needs | a shell in the repository | an MCP client |
| Fixed cost | none; the agent reads `--help` or `capabilities` when it needs them | `tools/list` once per session (use `--compact-discovery`) |
| Limits what the agent sees | no (governance still applies) | yes, by profile |

Both call the same services; neither can authorize more than the trusted configuration.
[Benchmarks](../benchmarks/README.md) gives measured sizes and where MCP costs more.

## Trust boundaries

- **Over stdio, the boundary is your local user.** There is no authentication; repository
  commands (`verify`, provisioning) run as you, with your files. Run untrusted work in a
  container or VM.
- **Profiles are the agent's ceiling.** You choose them at launch; the agent cannot widen them.
  Start with `read-only`; add `executor` to start and verify, `publisher` to deliver.
- **Credentials stay with the server.** The token comes from the repository's
  `security.credentials` source and is never returned to the agent. Do not put it in the
  agent's instructions or in `args`.
- **Writes are governed by the trusted configuration**, not by the client:
  `security.authorization` decides ([authorization](../security/authorization-and-trust.md)).
- **Issue, pull request and comment text is untrusted data**, never instructions.

## Context routing

`comforge context --task "<task>" --json` (or `comforge_context`) returns the one routing
category of a task — files, skill, docs and validation — from the repository's manifest
(`context.manifest`), so the agent loads what the task needs instead of the whole repository
([recipe 11](../recipes/11-context-routing.md)). Routing is guidance: no command reads it to
decide a permission.

## Recovery

- Exit or result `exit: 4` → rerun the same command or tool call.
- `ambiguous` → `comforge recover <ID> --execute` (or `comforge_recover`); never redo a write by
  hand ([recipe 4](../recipes/04-interrupted-handover-and-recovery.md)).
- A new session, or another agent, continues from `comforge status`: all state is in the
  primary clone's `.git/comforge/`, none in the agent.
