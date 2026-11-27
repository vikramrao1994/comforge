# Comforge

Deterministic engineering infrastructure for coding agents. Comforge gives every ticket a
verified specification, an isolated checkout, validation of the exact commit, a governed pull
request, a verifiable completion record, advisory reviews and recovery from interrupted writes
— with every approval left to people. Deterministic code decides every permission; agent
instructions only guide. It works with any agent that can run a command or speak MCP.

**It is not** an autonomous agent, a model, a sandbox, a CI system or a token-compression
product. It never merges, approves, deploys or closes an issue.

## When to use it — and when not

| Use Comforge when | Look elsewhere when |
|---|---|
| agents open pull requests in a GitHub repository and you need each change tied to a published specification, an exact validated commit and an auditable record | you need isolation from untrusted code (use containers or VMs; Comforge runs your validation as you) |
| several agents, sessions or people hand work over and must not duplicate writes | you want an agent framework that plans and writes code (Comforge governs the lifecycle around it) |
| you want owner-signed authorization of agent writes, or an explicit operator mode | your forge is not GitHub (github.com or GitHub Enterprise) |
| you need one lifecycle from the CLI, MCP and your own server alike | you are on Windows (refused; use WSL) |

## Install and a first workflow

```sh
npm install --save-dev --save-exact @comforge/cli @comforge/mcp
npx comforge init --write            # review, then commit and push comforge.config.json to your base branch
npx comforge doctor
npx comforge spec publish ACME-101 --title "ACME-101 — widget" --body-file spec.md --execute
npx comforge start ACME-101 --issue <N>     # isolated checkout on agent/acme-101
#   … work in the checkout, commit with "Ticket: ACME-101" …
npx comforge verify ACME-101                # validation on the exact commit
npx comforge deliver ACME-101 --title "Widget" --result result.json --execute
```

The complete, tested version — configuration, expected output, errors and cleanup — is
[recipe 1](docs/recipes/01-first-governed-initiative.md). Every recipe runs in CI against the
published packages.

## CLI, MCP or embedded

| Interface | For | Start |
|---|---|---|
| `comforge` CLI | agents with a shell, scripts, CI | [CLI quickstart](docs/getting-started/quickstart-cli.md) · [reference](docs/reference/cli.md) |
| `comforge-mcp` (stdio, HTTP) | agent clients: Claude Code, Codex, Cursor, any MCP client | [MCP quickstart](docs/getting-started/quickstart-mcp.md) · [integrations](docs/integrations/README.md) |
| embedded services | your own server or supervisor | [recipe 7](docs/recipes/07-embedded-host-services.md) · [API](docs/reference/api.md) |

All three call the same services under the same governance. How to choose:
[tool selection](docs/reference/tool-selection.md).

## Architecture

| Package | Published | Role |
|---|---|---|
| [`@comforge/cli`](packages/cli/README.md) | 0.5.0 | the lifecycle as a CLI and embeddable services — **start here** |
| [`@comforge/mcp`](packages/mcp/README.md) | 0.3.0 | the lifecycle as an MCP server with tool profiles, and host services |
| [`@comforge/core`](packages/core/README.md) | 0.2.0 | pure contracts: specifications, grants, receipts, decisions, reviews, completions |
| [`@comforge/github`](packages/github/README.md) | 0.6.0 | caller-authorized GitHub transport |
| [`@comforge/ledger`](packages/ledger/README.md) | 0.1.0 | write-ahead operation ledger (memory, file, SQLite) |

Consumers depend on `@comforge/cli` and `@comforge/mcp`; the libraries come with them.
[Architecture](docs/concepts/architecture.md).

## Recipes

[First initiative](docs/recipes/01-first-governed-initiative.md) ·
[MCP for agents](docs/recipes/02-mcp-for-coding-agents.md) ·
[parallel initiatives](docs/recipes/03-parallel-initiatives.md) ·
[interrupted handover and recovery](docs/recipes/04-interrupted-handover-and-recovery.md) ·
[owner grants](docs/recipes/05-owner-grants.md) ·
[specification, review, revision](docs/recipes/06-specification-review-revision.md) ·
[embedded host](docs/recipes/07-embedded-host-services.md) ·
[file and SQLite persistence](docs/recipes/08-file-and-sqlite-persistence.md) ·
[a Python project](docs/recipes/09-non-typescript-project.md) ·
[governed npm release](docs/recipes/10-governed-npm-release.md) ·
[context routing](docs/recipes/11-context-routing.md)

## Benchmarks

Component-level only: compact MCP discovery is 39–46% smaller, CLI `--compact` 24–30% (in
characters), and summary-first reads 33–80% smaller *but carry less information*; equivalent content through
MCP is **larger** than the CLI's compact JSON. No end-to-end agent saving or competitive
comparison has been measured. [Summary](docs/benchmarks/summary.md) ·
[method and limits](docs/benchmarks/README.md).

## Trust model

- **Authorization is configuration on the base branch**, never the working tree: `operator`
  mode (whoever runs it with the token decides — policy) or `owner-grant` mode (each write needs
  an owner-signed grant — enforcement, if the agent cannot read the key).
  [Authorization and trust](docs/security/authorization-and-trust.md).
- **Host isolation is host-provided.** Validation runs the candidate's code as you.
- **Reconciliation, not exactly-once.** A lost write is held as indeterminate and settled from
  GitHub, never re-sent blindly.

## Compatibility

Node.js ≥ 22.18 or Bun ≥ 1.4, Git ≥ 2.30, macOS or Linux, github.com or GitHub Enterprise.
[Compatibility](docs/reference/compatibility.md).

## Limitations and roadmap

Status labels: **published** (released on npm), **implemented** (on `main`, unreleased),
**experimental** (synthetic or rehearsal runs only), **planned**.

- **Implemented, unreleased:** repository metadata of every package (`release-intents/`).
- **Known gap:** the CLI's usage lines omit four accepted flags
  ([CLI reference](docs/reference/cli.md#known-gap)).
- **Experimental:** the reusable [benchmark library](benchmarks/); live agent experiments are not run.
- **Planned:** end-to-end agent benchmarks; a live raw-GitHub comparison; per-client
  verification beyond registration.

[Known limitations](docs/troubleshooting/known-limitations.md) ·
[troubleshooting](docs/troubleshooting/troubleshooting.md).

## Contributing

[Contributing](docs/contributing/contributing.md) ·
[release governance](docs/contributing/release-governance.md) ·
[agent instructions](CLAUDE.md) · [documentation](docs/README.md). Licensed under
[Apache-2.0](LICENSE).
