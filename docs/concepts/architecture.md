# Architecture

## Packages

| Package | Role | Depends on | Status |
|---|---|---|---|
| `@comforge/core` | Pure kernel: specification, grant, receipt, lifecycle decision, review and completion contracts. No I/O. | zod | published 0.2.0 |
| `@comforge/github` | Caller-authorized GitHub transport: reads, evidence, published specifications, verified writes | core | published 0.6.0 |
| `@comforge/ledger` | Write-ahead operation ledger with file and SQLite adapters and a conformance suite | none | published 0.1.0 |
| `@comforge/cli` | The lifecycle: config, start/verify/deliver/recover/cleanup, authorization, protocol services, runtime authority | core, github, ledger | published 0.5.0 |
| `@comforge/mcp` | MCP server (stdio and HTTP) with tool profiles, and embeddable host services | cli, core, github, ledger | published 0.3.0 |

```
            ┌──────────────┐     ┌──────────────┐
 consumers  │ @comforge/cli│◄────│ @comforge/mcp│
            └──────┬───────┘     └──────┬───────┘
                   │                    │
        ┌──────────┼─────────┬──────────┘
        ▼          ▼         ▼
  @comforge/core  @comforge/github  @comforge/ledger
        ▲              │
        └──────────────┘
```

## Two consumer interfaces

Consumers depend on `@comforge/cli` and `@comforge/mcp` only. Their subpath exports are the
supported embedding surface: `@comforge/cli/protocols` (protocol services under a compatibility
profile), `@comforge/cli/authority` (runtime grants and receipts), `@comforge/cli/config`,
`@comforge/cli/routing`, and `@comforge/mcp/host` (engineering host services). Importing the
three library packages directly is supported but couples a consumer to their versions.

## Boundaries (machine-checked)

- `core` performs no I/O and imports no other package (`packages/core/test/boundary.test.ts`).
- Packages import each other only through package names, never relative paths
  (`tests/repository/validators.test.ts`, `bun run validate`).
- Package sources import nothing from `tooling/`, `tests/`, `benchmarks/` or `harness/`.
- The harness (`harness/`) is the published release that governs this repository; workspace
  candidates never resolve as the harness ([decision 0002](../decisions/0002-published-harness.md)).

## Repository layout

| Path | Owns |
|---|---|
| `packages/<id>/` | Package source, tests, README, llms.txt, CHANGELOG |
| `examples/<id>-consumer/` | Independent consumers, shipped on each release branch |
| `tooling/release/` | Release planner, intents, candidates, authorization, release build |
| `tooling/` | Repository validators (`validate.ts`, `typecheck.ts`, `disclosure.ts`) |
| `release-intents/`, `releases/` | Reviewed release intents, release records, campaign plans, planning baselines |
| `skills/` | Consumer and contributor agent skills |
| `context/routing.json` | Task → files, skills, docs and validation routing |
| `harness/` | The published Comforge release used for this repository's own workflow |
