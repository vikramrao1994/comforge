# CLI reference — `comforge`

Status: published (`@comforge/cli` 0.5.0). The generated
[command inventory](inventory/cli-commands.md) is the authoritative list of commands and of the
flags the parser accepts; this page explains them. `comforge capabilities --json` prints the
same at runtime, and `comforge <command> --help` prints one command's usage.

## Global flags

| Flag | Effect |
|---|---|
| `--json` | deterministic, indented JSON on stdout; errors as JSON on stderr |
| `--compact` | with `--json`: the same content on one line |
| `--summary` | with `--json`: a bounded first look (scalars stay; an array becomes its count and first item) |
| `--cwd DIR` | run as if started in `DIR` (the primary clone) |
| `--help` | usage of the command (or of all commands) |
| `--version` | the package version |

Every command that writes to GitHub is a dry run without `--execute`; `init` writes only with
`--write`. IDs are a ticket (`ACME-101`) or a phase of one (`ACME-101.b`, its own branch and
checkout under the same specification). Run lifecycle commands from the primary clone; the
work happens in the initiative's checkout.

## Setup and discovery

| Command and flags | Does | Writes |
|---|---|---|
| `init [--write] [--force]` | detects conventions; previews `comforge.config.json`. `--write` writes it; `--force` overwrites an existing one | the file, with `--write` |
| `doctor` | environment, configuration, credential and ledger checks | nothing |
| `capabilities` | commands, exit and error codes, what the CLI never does | nothing |
| `context [--task TEXT]` · `context check` | the one routing category a task matches (files, guidance, validation); `check` validates the manifest | nothing |
| `schema <config\|capabilities>` | a versioned JSON Schema | nothing |

## Lifecycle

| Command and flags | Does | Writes |
|---|---|---|
| `start <ID> [--issue N] [--expect-digest HEX] [--no-provision] [--reopen]` | verifies the specification on issue `N` (and its digest, with `--expect-digest`); clones an isolated checkout from the fetched base and runs `checkout.provision` unless `--no-provision`. `--reopen` starts the next attempt of a cleaned-up initiative | local checkout, state |
| `revise <PR> [--reviewed-head SHA] [--no-provision]` | resumes the initiative of an open pull request: re-creates a missing checkout, fast-forwards, reports divergence. `--reviewed-head` refuses if the pull request moved past the head a review was about | state |
| `status [ID]` | local state of one or every initiative | nothing |
| `verify <ID> [--commit SHA] [--with NAME[,NAME]] [--keep]` | runs the trusted validation commands on the clean, committed head (or `--commit`); `--with` adds named `verification.optional` commands; `--keep` keeps the snapshot directory | state |
| `publish <ID> --title TEXT [--draft] [--closes N] [--grant FILE] [--execute]` | runs `publication.checks`, pushes the validated head, creates or updates its pull request; `--draft` opens it as a draft, `--closes N` adds a closing reference | push, pull request |
| `complete --result FILE [--grant FILE] [--execute]` | publishes a completion record as one issue comment, linked from the pull request | comment, PR body |
| `deliver <ID> --title TEXT --result FILE [--no-pr] [--draft] [--closes N] [--grant FILE] [--execute]` | `publish`, then `complete`, then reads both back; `--no-pr` for a result that needs no pull request; every attempt is recorded | as both |
| `recover <ID> [--abandon] [--grant FILE] [--execute]` | settles this initiative's unresolved writes from GitHub; `--abandon` gives up a write a complete search did not find | write ledger |
| `cleanup <PR\|ID> [--allow-missing-completion] [--grant FILE] [--execute]` | after the merge reached the base: removes the checkout, runs `cleanup` steps, resumably; refuses while a write is unresolved or a completion is missing (unless `--allow-missing-completion`) | checkout, state, branch if configured |
| `migrate [--rollback] [--wait SECONDS] [--execute]` | imports an earlier lifecycle's state (`state.legacy`); waits up to `--wait` seconds (default 30) for its writers to stop; `--rollback` undoes an import nothing changed since | local state |

`--grant FILE` is an owner-signed grant, required in `owner-grant` mode for every write (see
[authorization](../security/authorization-and-trust.md) and
[recipe 5](../recipes/05-owner-grants.md)).

## Owner grants

| Command and flags | Does |
|---|---|
| `grant template <ID> [--hours N] [--command cleanup]` | an unsigned grant for the initiative's current head, valid `N` hours (default 24, 1–168); `--command cleanup` scopes it to cleanup of the merged pull request |
| `grant sign <ID\|-> --grant FILE --key FILE` | signs a template with an Ed25519 private key; `-` signs a governance grant (specification or review publication), which has no initiative |

Sign on the owner's machine. Grants write nothing.

## Governance and reads

| Command and flags | Does | Writes |
|---|---|---|
| `spec publish <TICKET> --title T --body-file FILE [--issue N] [--key K] [--grant FILE] [--execute]` | publishes a specification issue with a digest marker; `--issue N` replaces one; `--key K` sets the idempotency key (default: ticket and digest); idempotent and read back | one issue |
| `review publish --review-file FILE [--grant FILE] [--execute]` | publishes an advisory review comment bound to the reviewed head (never a native review, never of one's own pull request) | one comment |
| `review list <PR>` | a pull request's advisory reviews with integrity, provenance and staleness | nothing |
| `comments <ISSUE\|PR>` | every comment, as bounded untrusted text | nothing |
| `prs [--state open\|closed\|all]` | the repository's pull requests | nothing |
| `artifact <COMMIT> <PATH>` | a file at an exact commit, only under `artifacts.readable` | nothing |

## Exit codes

`0` done · `1` refused by a governance check · `2` usage or configuration · `3` environment
failure (rerun may succeed) · `4` incomplete (rerun the same command). Every error code and its
exit status: [errors](errors.md).

## Known gap

The command table's usage lines (what `--help` and `capabilities` print) omit four flags the
parser accepts: `start --reopen`, `publish --closes`, `deliver --closes` and `grant --command`.
They work as documented here; the usage strings are corrected in the next CLI release.
