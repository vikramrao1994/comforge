---
name: contributor-documentation
description: Keep docs, package READMEs, llms.txt and skills accurate and consistent.
category: contributor
---

# contributor-documentation

Keep docs, package READMEs, llms.txt and skills accurate and consistent.

## When to use

- The change alters behaviour, commands, configuration, tools or release flow.

## Prerequisites

- docs/README.md index; the package README tables.

## Examples

```sh
bun tooling/validate.ts docs skills
```

## Decision rules

- Package READMEs own reference tables; docs/ summarize and link instead of copying.
- Label every capability: published, implemented, experimental or planned.
- Examples in READMEs are copied verbatim from `examples/` (tested).

## Security boundaries

- Never document private systems, credentials or personal data.

## Validation

```sh
bun run docs:generate      # after a change to a command, flag, tool, error code, config key or export
bun tooling/validate.ts docs skills reference invented versions recipes benchmarks && bun run disclosure
bun run docs:recipes       # every recipe, as written, against the published harness
```

## Failure and recovery

- Broken relative link: fix the path; the validator lists each one.

## References

- [docs/README.md](../../docs/README.md)
- [docs/recipes/README.md](../../docs/recipes/README.md)
- [docs/benchmarks/README.md](../../docs/benchmarks/README.md)
