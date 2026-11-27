# Examples

Independent consumers with synthetic data, each shipped on its package's release branch and
exercised from the packed tarball in CI:

| Example | Shows |
|---|---|
| [`examples/core-consumer`](../examples/core-consumer/) | specifications, grants, receipts, lifecycle decisions, reviews, completion records |
| [`examples/github-consumer`](../examples/github-consumer/) | the GitHub transport and caller-authorized writes against a fake server |
| [`examples/ledger-consumer`](../examples/ledger-consumer/) | the file and SQLite ledgers |
| [`examples/cli-consumer`](../examples/cli-consumer/) | a non-TypeScript (Makefile) project governed by the CLI |
| [`examples/mcp-consumer`](../examples/mcp-consumer/) | stdio and HTTP MCP servers for a Makefile and a TypeScript repository |
| [`tests/mcp/fixtures/two-package-consumer`](../tests/mcp/fixtures/two-package-consumer/) | a host that depends on exactly `@comforge/cli` and `@comforge/mcp` |
