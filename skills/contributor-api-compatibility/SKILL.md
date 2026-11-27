---
name: contributor-api-compatibility
description: Keep public APIs, exit codes, error codes and protocols compatible across versions.
category: contributor
---

# contributor-api-compatibility

Keep public APIs, exit codes, error codes and protocols compatible across versions.

## When to use

- The change touches exports, types, CLI output, exit/error codes, configuration schema or a protocol record format.

## Prerequisites

- The package's exports map and its frozen contract tests.

## Examples

```sh
bun test --isolate tests/cli/contracts.test.ts packages/core/test/surface.test.ts packages/core/test/verifierFixture.test.ts
```

## Decision rules

- Removing or renumbering an exit or error code, an export, a configuration field or a tool is breaking: major bump (minor before 1.0).
- Record formats are byte-frozen: published specifications, reviews and completion records must keep verifying.
- Additive changes need docs and a minor/patch intent.

## Security boundaries

- Never change a digest scheme or marker in place; add a new scheme and keep verifying the old one.

## Validation

```sh
bun run test && bun run release:plan   # the planner's bump matches the intent
```

## Failure and recovery

- A frozen fixture fails: the change is breaking; redesign it as additive or plan a breaking release.

## References

- [packages/cli/README.md#upgrading](../../packages/cli/README.md#upgrading)
- [docs/concepts/protocols-and-authority.md](../../docs/concepts/protocols-and-authority.md)
