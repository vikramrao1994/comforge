---
name: contributor-package-development
description: Develop a change inside one package with tests, docs and a release intent.
category: contributor
---

# contributor-package-development

Develop a change inside one package with tests, docs and a release intent.

## When to use

- The task edits files under `packages/<id>/`.

## Prerequisites

- Skill contributor-architecture; the package README and CHANGELOG.

## Examples

```sh
bun test --isolate packages/<id>/test
bun run typecheck
# add release-intents/<date>-<slug>.json:
# {"schema":"comforge-release-intent/v1","package":"@comforge/<id>","bump":"patch|minor|major","summary":"…","breaking":null,"covers":[]}
```

## Decision rules

- Every change to shipped files (src, README, llms.txt) needs a release intent in the same PR.
- Update the package README and llms.txt when behaviour or API changes.
- Keep examples runnable: they are tested from the packed tarball.

## Security boundaries

- Do not change released records, tags or `releases/` baselines by hand.

## Validation

```sh
bun test --isolate packages/<id>/test tests/<id> && bun run release:plan
```

## Failure and recovery

- `release:plan` says unreleased change without intent: add the intent or revert the shipped change.

## References

- [docs/contributing/contributing.md](../../docs/contributing/contributing.md)
- [docs/contributing/release-governance.md](../../docs/contributing/release-governance.md)
