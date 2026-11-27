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
bun tooling/validate.ts docs skills && bun run disclosure
```

## Failure and recovery

- Broken relative link: fix the path; the validator lists each one.

## References

- [docs/README.md](../../docs/README.md)
