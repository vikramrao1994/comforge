# Programmatic API

Status: published, at the versions in each heading. This page explains the entry points you
are most likely to call; the generated [API inventory](generated/api.md) lists **every** runtime
export of every published subpath (238 across 16 subpaths), with the first sentence of its
source documentation. Types ship in each package's `dist/*.d.ts`. Consumers normally depend on
`@comforge/cli` and `@comforge/mcp` only; the three libraries are their dependencies and are
usable directly.

## `@comforge/cli` 0.5.0

| Entry point | Subpath | Use |
|---|---|---|
| `createLifecycleServices({ runtime, repository, credentials?, state?, writeLedger?, signal?, host? })` | `@comforge/cli` | every lifecycle, governance and read command as a function resolving to `{ ok: true, value, exit }` or `{ ok: false, error: { code, message, detail, exit } }` ([recipe 7](../recipes/07-embedded-host-services.md)) |
| `defaultRuntime()` | `@comforge/cli` | the process-backed runtime the `comforge` executable uses (spawn, clock, file system, environment) |
| `parseConfig`, `configJsonSchema`, `ConfigSchema` | `@comforge/cli/config` | read and validate `comforge.config.json` |
| `routeTask`, `checkManifest`, `RoutingManifestSchema` | `@comforge/cli/routing` | context routing over a manifest |
| `createProtocolServices(profile)`, `profileFromConfig` | `@comforge/cli/protocols` | specification, advisory-review and completion protocols under an explicit, versioned profile |
| `createRuntimeAuthority(options)`, `ed25519Signer`, `keyIdFor` | `@comforge/cli/authority` | execution grants and validation receipts for a host that runs work itself; refuses every command grant |

`HostPolicy` (passed as `host`) is trusted supervisor code: `checkoutParent`,
`prepareCheckout`, `remove`, `validation`. See [host services](../concepts/host-services.md).

## `@comforge/mcp` 0.3.0

| Entry point | Subpath | Use |
|---|---|---|
| `createComforgeMcpServer(options)` | `@comforge/mcp` | the MCP server over repository bindings |
| `serveStdio(options)` | `@comforge/mcp` | the stdio transport (`comforge-mcp`) |
| `createHttpHandler(options)` | `@comforge/mcp` | Streamable HTTP with authentication, allowlists, limits and per-principal sessions |
| `createEngineeringHost({ repository, transport, writes? })` | `@comforge/mcp/host` | engineering services in your own server: `evidence`, `advisoryReviews`, `trustedConfig`, `confirmTrustedConfig`, optional `writes` |
| `fetchTransport(options)`, `sqliteOperationStore(options)` | `@comforge/mcp/host` | the read transport, and a SQLite store for host writes' operation records |

## `@comforge/core` 0.2.0

Pure contracts, no I/O. `createSpecificationProtocol`, `createGrantProtocol`,
`createReceiptProtocol`, `createReviewProtocol`, `createCompletionProtocol` and
`evaluateLifecycleAction`, each also on its own subpath (`/specification`, `/grant`, `/receipt`,
`/review`, `/completion`, `/lifecycle`). Records produced under the same identities are byte
identical across hosts. See [protocols and authority](../concepts/protocols-and-authority.md)
and [`examples/core-consumer`](../../examples/core-consumer/).

## `@comforge/github` 0.6.0

`createFetchTransport` (credential, timeout, body limit), `createGitHubEvidence` (complete or
refuse reads at exact commits), `createGitHubWriter` (caller-authorized writes: each operation
descriptor is authorized separately, within the configured capabilities), `listAdvisoryReviews`,
`latestAdvisoryReview` and `readSpecificationIssue`. Errors are `GitHubAdapterError` with codes
in `GITHUB_ERROR_CODES`. See [`examples/github-consumer`](../../examples/github-consumer/).

## `@comforge/ledger` 0.1.0

`createMemoryLedger`, `createFileLedger` (`/file`), `createSQLiteLedger` with
`ledgerTableStatements` and `statementDriver` (`/sqlite`), and `ledgerConformance` (`/conformance`)
to test your own adapter ([recipe 8](../recipes/08-file-and-sqlite-persistence.md)). Errors are
`LedgerError` (`isLedgerError`).
