# Any agent or MCP client

**Verification:** the server is exercised by an MCP SDK client in
[recipe 2](../recipes/02-mcp-for-coding-agents.md) (CI). A specific client is untested unless its
own page says otherwise.

## Over a shell: the CLI

1. `npx comforge capabilities --json` once: commands, exit codes, error codes, what it never does.
2. `npx comforge status --json --summary` to see the state.
3. Every command prints deterministic JSON with `--json`; branch on `error` codes
   ([errors](../reference/errors.md)), dry-run before `--execute`.

## Over MCP: `comforge-mcp`

Any client that launches a stdio server:

```text
command: npx
args:    comforge-mcp --repository <dir> --profile read-only [--profile executor] [--profile publisher] [--compact-discovery] [--summary-text]
```

`--summary-text` makes each result's text one summary line and leaves `structuredContent`
unchanged: use it only with a client that passes `structuredContent` to the model, or the model
sees just the summary. For a remote client, host `createHttpHandler` behind your own
authentication ([MCP reference](../reference/mcp.md)).

## Embedded

A program that is its own agent host calls `createLifecycleServices` and `createEngineeringHost`
in process ([recipe 7](../recipes/07-embedded-host-services.md)).

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
