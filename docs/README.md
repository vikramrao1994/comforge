# Comforge documentation

Comforge is a governed engineering workflow for coding agents: specifications, isolated
checkouts, validation of an exact commit, governed publication, advisory reviews, evidence and
recovery, with a person keeping every approval.

Status labels used throughout: **published** (in a released npm version), **implemented** (on
`main`, not yet released), **experimental** (validated only in synthetic or rehearsal runs),
**planned** (not built).

| Start here | |
|---|---|
| [Overview](getting-started/overview.md) | What Comforge is, what it is not, who it is for |
| [Architecture](concepts/architecture.md) | The five packages and the two consumer interfaces |
| [CLI quickstart](getting-started/quickstart-cli.md) | Govern a repository from the command line |
| [MCP quickstart](getting-started/quickstart-mcp.md) | Give an agent client governed tools |
| [Configuration](reference/configuration.md) | `comforge.config.json` reference |
| [Commands, capabilities and tool profiles](reference/tool-selection.md) | What each command and tool does and may write |
| [Host services](concepts/host-services.md) | Embedding the MCP host services in your own server |
| [Protocols and runtime authority](concepts/protocols-and-authority.md) | Specification, grant, receipt, review and completion contracts |
| [Authorization and trust boundaries](security/authorization-and-trust.md) | Who decides a write, and what an agent can never do |
| [Persistence, concurrency and reconciliation](concepts/persistence-and-reconciliation.md) | The write ledger and `recover` |
| [Migration and recovery](troubleshooting/migration-and-recovery.md) | Importing earlier state, rolling forward, partial failures |
| [Runtimes and platforms](reference/compatibility.md) | Supported Node.js, Bun, OS; refusal behaviour |
| [Examples](recipes/README.md) | Independent consumer examples |
| [Contributing](contributing/contributing.md) | Developing Comforge itself |
| [Release governance](contributing/release-governance.md) | How a package version is planned, authorized and published |
| [Release publisher transition](contributing/release-transition.md) | The fail-closed switch-over to this repository's publisher |
| [Known limitations](troubleshooting/known-limitations.md) | What Comforge does not do |
| [Decisions](decisions/) | Architectural decision records |

Per-package references are the package READMEs: [core](../packages/core/README.md),
[github](../packages/github/README.md), [ledger](../packages/ledger/README.md),
[cli](../packages/cli/README.md), [mcp](../packages/mcp/README.md).
