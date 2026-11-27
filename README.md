# Comforge

An open, verifiable software factory for coding agents: verified specifications, isolated
checkouts, validation of an exact commit, governed pull requests, advisory reviews, evidence and
recovery — with every approval left to people. Deterministic code decides every permission;
agent instructions only guide.

| Package | Version | |
|---|---|---|
| [`@comforge/cli`](packages/cli/README.md) | 0.5.0 | the lifecycle, as a CLI and embeddable services — **start here** |
| [`@comforge/mcp`](packages/mcp/README.md) | 0.3.0 | the lifecycle as an MCP server with tool profiles, and host services |
| [`@comforge/core`](packages/core/README.md) | 0.2.0 | pure contracts: specifications, grants, receipts, decisions, reviews, completions |
| [`@comforge/github`](packages/github/README.md) | 0.6.0 | caller-authorized GitHub transport |
| [`@comforge/ledger`](packages/ledger/README.md) | 0.1.0 | write-ahead operation ledger (file, SQLite) |

```sh
npm install --save-dev --save-exact @comforge/cli @comforge/mcp
npx comforge init && npx comforge doctor
```

- [Documentation](docs/README.md) · [CLI quickstart](docs/getting-started/quickstart-cli.md) · [MCP quickstart](docs/getting-started/quickstart-mcp.md)
- [Architecture](docs/concepts/architecture.md) · [Authorization and trust](docs/security/authorization-and-trust.md) · [Known limitations](docs/troubleshooting/known-limitations.md)
- [Contributing](docs/contributing/contributing.md) · [Release governance](docs/contributing/release-governance.md) · [Agent instructions](CLAUDE.md)

Node.js ≥ 22.18 or Bun ≥ 1.4 on macOS or Linux. Licensed under [Apache-2.0](LICENSE).
