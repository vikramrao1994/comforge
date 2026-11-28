<p align="center">
  <a href="https://github.com/vikramrao1994/comforge">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/vikramrao1994/comforge/main/docs/assets/brand/comforge-logo-dark.svg">
      <img alt="Comforge" src="https://raw.githubusercontent.com/vikramrao1994/comforge/main/docs/assets/brand/comforge-logo-light.svg" height="40">
    </picture>
  </a>
</p>

# @comforge/cli

Terminal workflows for governed agent work in any Git repository hosted on GitHub. The `comforge` command gives each ticket its own isolated checkout, validates the exact commit, opens a governed pull request with a verifiable completion record, and recovers interrupted work. The same lifecycle is available as embeddable services.

[![npm](https://img.shields.io/npm/v/@comforge/cli?label=npm&color=0b7285)](https://www.npmjs.com/package/@comforge/cli)
[![CI](https://github.com/vikramrao1994/comforge/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/vikramrao1994/comforge/actions/workflows/ci.yml)
[![License](https://img.shields.io/npm/l/@comforge/cli?color=0b7285)](https://github.com/vikramrao1994/comforge/blob/main/LICENSE)
[![Node](https://img.shields.io/node/v/@comforge/cli?color=0b7285)](https://github.com/vikramrao1994/comforge/blob/main/docs/reference/compatibility.md)

## Install

```sh
npm install --save-dev --save-exact @comforge/cli     # or: bun add -d --exact @comforge/cli
npx comforge --version                                # or: bunx comforge --version
```

## Quick example

```sh
npx comforge init --write        # write comforge.config.json (a bare `init` only previews it)
git add comforge.config.json && git commit -m "chore: configure comforge"   # merge it to your base branch
npx comforge doctor              # read-only environment, configuration and credential checks

export GITHUB_TOKEN=…            # only where GitHub commands run
npx comforge start ACME-101 --issue 42      # verify the specification, create an isolated checkout
cd ../widgets-agents/acme-101               # work here; commit with the trailer "Ticket: ACME-101"
npx comforge verify ACME-101                # run your validation commands on the exact commit
npx comforge deliver ACME-101 --title "Rate-limit exports" --result result.json            # dry run
npx comforge deliver ACME-101 --title "Rate-limit exports" --result result.json --execute  # PR + completion record
# People review and merge on GitHub, then:
npx comforge cleanup 17 --execute
```

Every command that writes to GitHub is a dry run until you pass `--execute`. Every command takes `--json` for deterministic output. The commands never merge, deploy, approve, request a review or close an issue: those stay with people.

## What it provides

| Command | What it does |
|---|---|
| `init`, `doctor`, `capabilities`, `schema` | Set up and inspect: detect conventions and write the configuration, run read-only checks, list commands and error codes, print the configuration's JSON Schema |
| `context` | Route a task to its category in your routing manifest |
| `start`, `revise`, `status` | Verify the specification and clone an isolated checkout; resume the initiative of an open pull request; show local state |
| `verify` | Run the trusted validation commands on the clean, committed head |
| `publish`, `complete`, `deliver` | Push the validated head and open or update its pull request; publish a completion record; do both and read them back |
| `recover` | Settle unresolved writes from GitHub, or `--abandon` one a complete search did not find |
| `cleanup`, `migrate` | Remove a merged initiative's checkout; import an earlier lifecycle's state |
| `grant` | Print and sign owner grants (`grant template`, `grant sign`) |
| `spec publish`, `review publish`, `review list` | Publish a specification issue or an advisory review; list a pull request's advisory reviews |
| `comments`, `prs`, `artifact` | Read comments, pull requests and a file at an exact commit, as bounded untrusted text |

Programmatic entry points:

| Export | Subpath | Use |
|---|---|---|
| `createLifecycleServices` | `@comforge/cli` | Every lifecycle, governance and read command as a function returning `{ ok, value }` or `{ ok: false, error }` |
| `defaultRuntime` | `@comforge/cli` | The process-backed runtime the executable uses |
| `parseConfig`, `configJsonSchema` | `@comforge/cli/config` | Read and validate `comforge.config.json` |
| `routeTask`, `checkManifest` | `@comforge/cli/routing` | Context routing over a manifest |
| `createProtocolServices`, `profileFromConfig` | `@comforge/cli/protocols` | Specification, review and completion protocols under an explicit versioned profile |
| `createRuntimeAuthority`, `ed25519Signer` | `@comforge/cli/authority` | Execution grants and receipts for a host that runs work itself |

Writes need authorization from the trusted configuration, read from the base branch and never from the working tree: an owner-signed grant (`owner-grant` mode) or an explicit `operator` mode. With neither, every write is refused. Exit codes: `0` done, `1` refused by a governance check, `2` usage or configuration, `3` environment failure, `4` incomplete (rerun the same command).

## Compatibility

- Node.js 22.18 or later, or Bun 1.4 or later; Git 2.30 or later on `PATH`.
- macOS and Linux. Windows is refused with `unsupported-platform`.
- GitHub (github.com, or GitHub Enterprise through `repository.apiOrigin`). `gh` is needed only for assigning pull requests or as a credential source.
- Any project language: validation and provisioning are commands you configure.

Details: [compatibility](https://github.com/vikramrao1994/comforge/blob/main/docs/reference/compatibility.md).

## Limitations

- **Not a sandbox.** `verify` runs your validation commands, and so the candidate's code, as you. Run untrusted work in a container or VM.
- **It governs only what goes through it.** Someone with write access can still push or merge by other means; use branch rulesets.
- **No exactly-once claim.** A write whose answer was lost is held as `indeterminate` and never sent again automatically; `comforge recover` looks for it.
- Local state lives in `.git/comforge/`. The file ledger needs a filesystem with hard links.

See [requirements and limits](https://github.com/vikramrao1994/comforge/blob/main/docs/reference/cli.md#requirements-and-limits) and [authorization details](https://github.com/vikramrao1994/comforge/blob/main/docs/reference/cli.md#authorization-details).

## Documentation

- [Repository README](https://github.com/vikramrao1994/comforge#readme)
- [CLI reference](https://github.com/vikramrao1994/comforge/blob/main/docs/reference/cli.md), [configuration](https://github.com/vikramrao1994/comforge/blob/main/docs/reference/configuration.md), [errors and exit codes](https://github.com/vikramrao1994/comforge/blob/main/docs/reference/errors.md), [API](https://github.com/vikramrao1994/comforge/blob/main/docs/reference/api.md)
- [Recipes](https://github.com/vikramrao1994/comforge/tree/main/docs/recipes), including [a first governed initiative](https://github.com/vikramrao1994/comforge/blob/main/docs/recipes/01-first-governed-initiative.md) and [owner grants](https://github.com/vikramrao1994/comforge/blob/main/docs/recipes/05-owner-grants.md)
- [Architecture](https://github.com/vikramrao1994/comforge/blob/main/docs/concepts/architecture.md)
- [Runnable example](https://github.com/vikramrao1994/comforge/tree/main/examples/cli-consumer)
- [Changelog](https://github.com/vikramrao1994/comforge/blob/main/packages/cli/CHANGELOG.md)
- [License (Apache-2.0)](https://github.com/vikramrao1994/comforge/blob/main/LICENSE)
