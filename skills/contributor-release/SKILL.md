---
name: contributor-release
description: Plan, prepare and publish a package release under owner authorization.
category: contributor
---

# contributor-release

Plan, prepare and publish a package release under owner authorization.

## When to use

- The task is to release a package, prepare a version PR, or recover a partial publication.

## Prerequisites

- Merged changes with release intents; the owner available to approve the release run's `comforge-release` environment.

## Examples

```sh
bun run release:plan
bun run release:version-pr                 # opens nothing without --open
# owner: merge the version PR, then Approve the release run's comforge-release environment
bun run release:npm-readback --package @comforge/<id>
bun run release:record --package <id>
```

## Decision rules

- Release in dependency order (core → github, ledger → cli → mcp); a dependent's pin must name a published, read-back version.
- A candidate is built by CI; never build or publish one locally.
- Use a campaign for several packages.

## Security boundaries

- Only the owner approves a release run's `comforge-release` environment; an agent never approves it, and never holds its credentials.
- Only one publisher is active (`COMFORGE_PUBLISHER`, and `COMFORGE_PREVIOUS_PUBLISHER_RETIRED` in `comforge-release`); the switch-over is owner-only and follows `docs/contributing/release-transition.md` in order.

## Validation

```sh
bun test --isolate tests/release && bun run release:plan
```

## Failure and recovery

- Partial campaign: read back and record what published; retry the rest from its own candidate.
- `candidate-mismatch`: the rebuild differs; investigate reproducibility, never override.

## References

- [docs/contributing/release-governance.md](../../docs/contributing/release-governance.md)
- [docs/recipes/10-governed-npm-release.md](../../docs/recipes/10-governed-npm-release.md)
