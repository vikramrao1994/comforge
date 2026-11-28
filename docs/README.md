# Comforge documentation

Deterministic engineering infrastructure for coding agents: verified specifications, isolated
checkouts, validation of an exact commit, governed publication, advisory reviews, evidence and
recovery, with a person keeping every approval.

Status labels used throughout: **published** (in a released npm version), **implemented** (on
`main`, not yet released), **experimental** (validated only in synthetic or rehearsal runs),
**planned** (not built).

## Getting started

| Page | |
|---|---|
| [Overview](getting-started/overview.md) | What Comforge is, what it is not, who it is for |
| [CLI quickstart](getting-started/quickstart-cli.md) | Govern a repository from the command line |
| [MCP quickstart](getting-started/quickstart-mcp.md) | Give an agent client governed tools |

## Recipes (executed in CI)

[Index](recipes/README.md) ·
[1 first initiative](recipes/01-first-governed-initiative.md) ·
[2 MCP for agents](recipes/02-mcp-for-coding-agents.md) ·
[3 parallel initiatives](recipes/03-parallel-initiatives.md) ·
[4 handover and recovery](recipes/04-interrupted-handover-and-recovery.md) ·
[5 owner grants](recipes/05-owner-grants.md) ·
[6 specification, review, revision](recipes/06-specification-review-revision.md) ·
[7 embedded host](recipes/07-embedded-host-services.md) ·
[8 persistence](recipes/08-file-and-sqlite-persistence.md) ·
[9 Python project](recipes/09-non-typescript-project.md) ·
[10 npm release](recipes/10-governed-npm-release.md) ·
[11 context routing](recipes/11-context-routing.md)

## Demos (recorded in CI)

Real output of executable scenarios against a local synthetic GitHub:
[first governed workflow](demos/first-workflow.md) ·
[parallel agent development](demos/parallel-agents.md) ·
[interrupted-agent recovery](demos/interrupted-recovery.md)

## Agent integrations

[Index](integrations/README.md) · [Claude Code](integrations/claude-code.md) ·
[Codex](integrations/codex.md) · [Cursor](integrations/cursor.md) ·
[any agent](integrations/generic.md)

## Concepts

| Page | |
|---|---|
| [Architecture](concepts/architecture.md) | The five packages and the two consumer interfaces |
| [Host services](concepts/host-services.md) | Embedding the MCP host services in your own server |
| [Protocols and runtime authority](concepts/protocols-and-authority.md) | Specification, grant, receipt, review and completion contracts |
| [Persistence, concurrency and reconciliation](concepts/persistence-and-reconciliation.md) | The write ledger and `recover` |

## Reference

[Index](reference/README.md) · [CLI](reference/cli.md) · [MCP](reference/mcp.md) ·
[configuration](reference/configuration.md) · [API](reference/api.md) ·
[errors](reference/errors.md) · [tool selection](reference/tool-selection.md) ·
[compatibility](reference/compatibility.md)

Generated from the contracts: [CLI commands](reference/inventory/cli-commands.md) ·
[CLI errors](reference/inventory/cli-errors.md) · [MCP tools](reference/inventory/mcp-tools.md) ·
[MCP errors](reference/inventory/mcp-errors.md) ·
[configuration keys](reference/inventory/configuration.md) · [API inventory](reference/inventory/api.md)

## Benchmarks

[Method, provenance and limits](benchmarks/README.md) · [summary and charts](benchmarks/summary.md)

## Security

[Authorization and trust boundaries](security/authorization-and-trust.md): who decides a write,
and what an agent can never do.

## Troubleshooting

[Troubleshooting](troubleshooting/troubleshooting.md) ·
[migration and recovery](troubleshooting/migration-and-recovery.md) ·
[known limitations](troubleshooting/known-limitations.md)

## Contributing

[Contributing](contributing/contributing.md) ·
[release governance](contributing/release-governance.md) ·
[release publisher transition](contributing/release-transition.md) ·
[decisions](decisions/) · [reports](reports/documentation-001.md) ·
[visual identity and assets](contributing/visual-identity.md)

Per-package references are the package READMEs: [core](../packages/core/README.md),
[github](../packages/github/README.md), [ledger](../packages/ledger/README.md),
[cli](../packages/cli/README.md), [mcp](../packages/mcp/README.md).
