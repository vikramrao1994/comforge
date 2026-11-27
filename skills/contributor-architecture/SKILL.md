---
name: contributor-architecture
description: Orient in the Comforge repository: packages, boundaries and where a change belongs.
category: contributor
---

# contributor-architecture

Orient in the Comforge repository: packages, boundaries and where a change belongs.

## When to use

- Any change to this repository, before the first edit.
- The task names a package, a protocol, the release tooling or a validator.

## Prerequisites

- `bun install`; read CLAUDE.md and context/routing.json.

## Examples

```sh
bun tooling/route.ts "add a retry to the ledger file adapter"   # files, skills, docs, validation
bun run validate
```

## Decision rules

- Put a change in the lowest package that owns the concept: contracts in core, GitHub I/O in github, persistence in ledger, lifecycle in cli, tools in mcp.
- core stays pure: no I/O, no other package.
- Cross-package imports use package names, never relative paths.

## Security boundaries

- Never import from `harness/`, `tooling/` or `tests/` in package source.

## Validation

```sh
bun run validate && bun run test
```

## Failure and recovery

- `boundaries` failure: move the import to the owning package or expose it through its exports.

## References

- [docs/concepts/architecture.md](../../docs/concepts/architecture.md)
- [context/routing.json](../../context/routing.json)
