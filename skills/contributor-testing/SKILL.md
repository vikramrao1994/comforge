---
name: contributor-testing
description: Choose and run the right tests; add tests that are credential-free and model-free.
category: contributor
---

# contributor-testing

Choose and run the right tests; add tests that are credential-free and model-free.

## When to use

- Any change; before reporting it complete.

## Prerequisites

- `bun install`; Node.js for the runtime matrix tests.

## Examples

```sh
bun run test                                   # all packages and repository tests
bun test --isolate packages/<id>/test           # one package
COMFORGE_TEST_RUNTIMES=node bun test --isolate tests/cli/consumerInstall.test.ts
```

## Decision rules

- Always run `bun test` with `--isolate`.
- Tests never need production credentials or paid model calls; use the fake GitHub server.
- Process-level and packed-tarball tests are synthetic; label real-client results separately.

## Security boundaries

- No real tokens in fixtures; token-shaped strings must be obviously fake.

## Validation

```sh
bun run validate && bun run test
```

## Failure and recovery

- Flaky process test: rerun once in isolation; a second failure is a real failure.

## References

- [docs/contributing/contributing.md](../../docs/contributing/contributing.md)
