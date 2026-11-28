---
name: contributor-dependency-migration
description: Move a consumer (or this repository's harness) to a new Comforge release.
category: contributor
---

# contributor-dependency-migration

Move a consumer (or this repository's harness) to a new Comforge release.

## When to use

- A new version was published and a consumer must adopt it; or the harness is upgraded.

## Prerequisites

- The release is read back (`release:npm-readback`).

## Examples

```sh
# harness of this repository
cd harness && bun add --exact @comforge/cli@<version> @comforge/mcp@<version>
# any consumer repository
bun run release:adopt --package <id>       # plans the exact pin update
```

## Decision rules

- Adopt exact versions; adopt dependents together when they pin each other.
- A consumer migration patch, if any, is digest-pinned and applied before its tests.

## Security boundaries

- Upgrading the harness changes what governs this repository: owner-reviewed PR only.

## Validation

```sh
cd harness && bun install --frozen-lockfile && cd .. && bun run harness -- doctor --json
```

## Failure and recovery

- Lockfile drift: reinstall from the reviewed lockfile; never hand-edit it.

## References

- [docs/contributing/release-governance.md](../../docs/contributing/release-governance.md)
- [docs/decisions/0002-published-harness.md](../../docs/decisions/0002-published-harness.md)
