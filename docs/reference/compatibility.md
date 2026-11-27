# Compatibility

## Runtimes and platforms

| | Supported | Tested in CI |
|---|---|---|
| Node.js | ≥ 22.18 (`engines` of every package) | 22, 24, 26 on Ubuntu and macOS |
| Bun | ≥ 1.4 | 1.4.1 on Ubuntu and macOS |
| OS | macOS, Linux | Ubuntu, macOS |
| Windows | **refused** with `unsupported-platform` | refusal is tested (`packages/cli/test`) |
| Git | ≥ 2.30 on `PATH` | the runner's |
| GitHub | github.com; GitHub Enterprise through `repository.apiOrigin` | synthetic server only (no live GitHub in CI) |
| `node:sqlite` (SQLite ledger) | Node.js ≥ 22.13, Bun | through the ledger conformance suite |

The packages ship compiled JavaScript with declarations; consumers need no TypeScript loader.
The packed-package consumer tests (`tests/*/consumerInstall.test.ts`) install each package from
its built tarball and run its example under both Node.js and Bun.

## Package versions

| Package | Published | Depends on |
|---|---|---|
| `@comforge/core` | 0.2.0 | — |
| `@comforge/github` | 0.6.0 | `@comforge/core` `^0.1.2 \|\| ^0.2.0` |
| `@comforge/ledger` | 0.1.0 | — |
| `@comforge/cli` | 0.5.0 | `@comforge/core` 0.2.0, `@comforge/github` 0.6.0, `@comforge/ledger` 0.1.0 (exact) |
| `@comforge/mcp` | 0.3.0 | `@comforge/cli` 0.5.0, `@comforge/core` 0.2.0, `@comforge/github` 0.6.0, `@comforge/ledger` 0.1.0 (exact), `@modelcontextprotocol/sdk` 1.32.2 |

Every package versions independently. Install `@comforge/cli` and `@comforge/mcp` exactly
(`--save-exact`); they pin their library versions exactly. The harness this repository governs
itself with pins the same two releases (`harness/package.json`). Pending changes in `main` are
**candidates** until released: `release-intents/` lists them and `bun run release:plan` shows
the next version of each package.

## Formats

The configuration (`comforge-config/v1`), local state records, write-ledger records and every
published record (specifications, grants, receipts, reviews, completions) carry a schema
version. An unknown version is refused, never guessed; `comforge doctor` reports one that
needs migration, and `comforge migrate` imports an earlier lifecycle's state.
