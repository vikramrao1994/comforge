---
name: comforge-install
description: Install Comforge in a repository and verify the environment before first use.
category: consumer
---

# comforge-install

Install Comforge in a repository and verify the environment before first use.

## When to use

- The user asks to set up, install or try Comforge in a repository.
- `comforge` is not installed, or `comforge doctor` has never passed here.

## Prerequisites

- Node.js ≥ 22.18 or Bun ≥ 1.4; Git ≥ 2.30; macOS or Linux.
- A GitHub repository with a base branch you can open pull requests against.

## Examples

```sh
npm install --save-dev --save-exact @comforge/cli @comforge/mcp
npx comforge doctor --json
npx comforge capabilities --json
```

## Decision rules

- Pin exact versions (`--save-exact`); upgrades are reviewed changes.
- Install only `@comforge/cli` and `@comforge/mcp`; the library packages come with them.
- On Windows stop: the CLI refuses with `unsupported-platform`.

## Security boundaries

- Never paste a token into `comforge.config.json` or a command line; credentials come from the configured source (`gh` or an environment variable).

## Validation

```sh
npx comforge doctor --json   # every check PASS, or each FAIL names its fix
```

## Failure and recovery

- `doctor` reports a missing credential: configure `security.credentials`, never commit one.
- `unsupported-platform`: use macOS or Linux (a container works).

## References

- [docs/getting-started/quickstart-cli.md](../../docs/getting-started/quickstart-cli.md)
- [docs/reference/compatibility.md](../../docs/reference/compatibility.md)
- [packages/cli/README.md#install](../../packages/cli/README.md#install)
- [docs/recipes/01-first-governed-initiative.md](../../docs/recipes/01-first-governed-initiative.md)
- [docs/reference/cli.md](../../docs/reference/cli.md)
