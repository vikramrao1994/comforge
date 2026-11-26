# @comforge/cli

`comforge` runs a governed agent lifecycle in any Git repository hosted on GitHub. It gives each
ticket its own checkout and branch, checks that the work is based on a published specification,
runs your validation commands on the exact commit, and publishes the pull request and a
verifiable completion record. It writes to GitHub only through
[`@comforge/github`](https://www.npmjs.com/package/@comforge/github), and makes those writes
idempotent with [`@comforge/ledger`](https://www.npmjs.com/package/@comforge/ledger).

It never merges, deploys, approves, requests a review or closes an issue. Those stay with people.

## Requirements, support and limits

| | |
|---|---|
| Runtimes | Node.js 22.18 or later (tested: 22, 24, 26), Bun 1.4 or later |
| Platforms | macOS and Linux. Windows is refused (`unsupported-platform`). |
| Git | 2.30 or later on `PATH` |
| GitHub | github.com, or GitHub Enterprise through `repository.apiOrigin` |
| Optional | `gh`, only for assigning pull requests (`security.delivery.assignee`) or the `gh` credential source |
| Your project | Any language: validation and provisioning are commands you configure |

Limits you should know:

- **It is not a sandbox.** `verify` runs your validation commands, which run the candidate's code.
  The CLI removes the GitHub credential and the `gh` login from that environment, but candidate
  code still runs as you. Run untrusted work in a container or VM.
- **It governs only what goes through it.** Someone with write access can still push or merge by
  other means. Use branch rulesets for enforcement.
- **No exactly-once claim.** A write whose answer was lost is held as `indeterminate` and never
  sent again automatically: `comforge recover` looks for it, and `--abandon` gives it up after a
  complete search found nothing.
- Local state lives in `.git/comforge/` (outside every commit). The file ledger needs a
  filesystem with hard links (not FAT, exFAT or some network mounts).

## Install

```sh
npm install --save-dev @comforge/cli      # or: bun add -d @comforge/cli
npx comforge --version                    # or: bunx comforge --version
```

## Quick start

```sh
npx comforge init                # preview the configuration it would write
npx comforge init --write        # write comforge.config.json (never overwrites without --force)
git add comforge.config.json && git commit -m "chore: configure comforge"   # merge it to your base branch
npx comforge doctor              # read-only checks

export GITHUB_TOKEN=…            # only where GitHub commands run; see "Credentials"
npx comforge start ACME-101 --issue 42      # verify the spec, create ../<repo>-agents/acme-101
cd ../widgets-agents/acme-101 && …          # work, commit with "Ticket: ACME-101"
npx comforge verify ACME-101                # run validation on the exact commit
npx comforge deliver ACME-101 --title "…" --result result.json            # dry run
npx comforge deliver ACME-101 --title "…" --result result.json --execute  # PR + completion
# …review and merge on GitHub (people do that)…
npx comforge cleanup 17 --execute           # after the merge
```

`publish`, `complete`, `deliver`, `recover`, `cleanup` and `init` change nothing unless you pass
`--execute` (or `--write`). Every command takes `--json` and prints deterministic JSON.

## Commands

| Command | What it does | Writes |
|---|---|---|
| `init [--write] [--force]` | Detects conventions; previews or writes `comforge.config.json` | the config file, with `--write` |
| `doctor` | Environment, configuration, credential and ledger checks | nothing |
| `capabilities` | Commands, exit codes, error codes, what it never does | nothing |
| `context [--task TEXT]` / `context check` | The one routing category a task matches | nothing |
| `schema config` | The configuration's JSON Schema | nothing |
| `start <ID> [--issue N] [--expect-digest HEX] [--no-provision]` | Verifies the specification; clones an isolated checkout from the fetched base | local checkout, state |
| `revise <PR> [--reviewed-head SHA]` | Resumes an initiative for a revision of its open PR | state |
| `status [ID]` | Local state of one or all initiatives | nothing |
| `verify <ID> [--commit SHA]` | Runs the trusted validation commands on the clean, committed head | state |
| `publish <ID> --title T [--draft] [--grant FILE] [--execute]` | Pushes the validated head; creates or updates its PR | git push, PR |
| `complete --result FILE [--execute]` | Publishes a completion record as one issue comment, linked from the PR | comment, PR body |
| `deliver <ID> --title T --result FILE [--no-pr] [--draft] [--execute]` | `publish`, then `complete` | as both |
| `recover <ID> [--abandon] [--grant FILE] [--execute]` | Reconciles unresolved writes of this initiative | write ledger |
| `grant template <ID>` / `grant sign <ID> --grant FILE --key FILE` | Owner grants (see Authorization) | nothing |
| `cleanup <PR or ID> [--allow-missing-completion] [--execute]` | After a merge, removes the checkout | local checkout, state |

`<ID>` is a ticket (`ACME-101`) or a phase of one (`ACME-101.b`), which gets its own branch
(`agent/acme-101.b`) and checkout and must keep its ticket's specification.

## Exit codes and errors

| Exit | Meaning |
|---|---|
| 0 | Done |
| 1 | Refused by a governance check (nothing unsafe happened) |
| 2 | Usage or configuration error |
| 3 | Environment failure (git, GitHub, file system); a rerun may succeed |
| 4 | Incomplete: a multi-stage command stopped part-way; rerun the same command |

Errors go to stderr as `{"error": "<code>", "message": "…", "detail": {…}}`. Codes are stable:
`comforge capabilities --json` lists them with their exit status.

| Exit | Codes |
|---|---|
| 1 | `untrusted-config-change`, `not-found`, `conflict`, `stale`, `policy-denied`, `validation-missing`, `validation-failed`, `specification-invalid`, `evidence-missing`, `dirty-checkout`, `credential-missing`, `authorization-required`, `unauthorized`, `would-overwrite` |
| 2 | `usage`, `config-missing`, `config-invalid`, `unsupported-platform` |
| 3 | `git-failed`, `github-failed`, `ambiguous`, `ledger`, `io` |
| 4 | `incomplete` |

## Configuration

`comforge.config.json` is strict JSON (`comforge schema config` prints its JSON Schema). Unknown
keys and unknown versions are refused.

```json
{
  "schema": "comforge-config/v1",
  "repository": { "owner": "acme", "name": "widgets", "baseBranch": "main", "remote": "origin" },
  "tickets": { "pattern": "^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+$", "branchPrefix": "agent/" },
  "checkout": { "provision": [["npm", "ci"]] },
  "validation": { "commands": [{ "name": "test", "run": ["npm", "test"] }], "timeoutSeconds": 3600 },
  "evidence": { "reportDir": "docs/comforge" },
  "commits": { "trailer": "Ticket" },
  "specification": { "required": true, "digestScheme": "acme-spec/v1", "markerNamespace": "acme-spec", "publisherName": "Acme Specs", "publishToolName": "acme_create_issue" },
  "completion": { "scheme": "acme-completion/v1", "markerNamespace": "acme-lifecycle", "runner": { "id": "my-agent", "label": "my agent" } },
  "context": { "manifest": "routing.json" },
  "security": {
    "capabilities": ["pulls:create", "pulls:update", "issues:comment"],
    "ledgerNamespace": "writes",
    "markerNamespace": "comforge-cli",
    "credentials": { "source": "env", "variable": "GITHUB_TOKEN" },
    "delivery": { "assignee": "acme-owner" }
  }
}
```

Commands are argument vectors, never shell strings. `specification` and `completion` name the
[`@comforge/core`](https://www.npmjs.com/package/@comforge/core) protocols; a repository that
configures the same names produces byte-identical records.

### Trust

Configuration is repository text and grants nothing. `repository`, `tickets`, `validation`,
`specification`, `completion` and `security` are read from the base revision the initiative
started from (what the owner already merged), never from the working tree. If a candidate changes
any of them, `publish` refuses with `untrusted-config-change`; the owner merges such a change by
other means. Instructions, skills and `context` output are guidance: no command reads them to
decide a permission.

### Authorization

Holding the CLI and a GitHub credential is not authority. `security.authorization` in the trusted
configuration decides who may cause a GitHub write:

| Setting | Meaning |
|---|---|
| absent (default) | Every write (`publish`, `complete`, `deliver`, `recover` with `--execute`) is refused with `authorization-required`. Local commands work. |
| `{"mode": "owner-grant", "grantScheme": "acme-grant/v1", "trustedKeys": [...]}` | Each write needs `--grant FILE`: an owner-signed grant (Ed25519, the `@comforge/core` grant protocol) bound to this repository, the ticket and its issue, the unedited specification digest, the base commit, the exact commit and branch, with an expiry (at most 7 days) and a number of attempts. Reuse past its attempts is refused as a replay. |
| `{"mode": "operator"}` | Whoever runs the CLI with the credential decides. An explicit owner choice with no independent authorization: policy, not enforcement. |

Two different checks guard a write. The **owner authorization** above decides whether this run
may write at all. Inside the run, the `@comforge/github` writer authorizes **each operation**
separately: only the exact descriptor the command prepared, for 60 seconds, within the
configured capabilities. The second never replaces the first.

Attempts: `publish`, `complete` and `deliver` each spend one attempt of a grant before their first
remote side effect (`git push`, a pull request create or update, a comment, an assignment).
Attempts are counted in the initiative's local state by compare-and-swap, so concurrent runs can
never spend more than `maxAttempts` between them, and a spent attempt is not given back: a run
that dies needs another attempt, and its earlier write is then answered from the write ledger, not
sent again. `recover` verifies the grant but spends nothing, because it writes nothing remote
(reconciliation reads; abandoning is local). When the attempts are gone, the owner signs a new
grant.

Because the setting is trusted configuration, a candidate cannot add a key or switch the mode,
and an uncommitted working copy is ignored. `comforge grant template <ID>` prints an unsigned
grant for the current head; `comforge grant sign <ID> --grant FILE --key FILE` signs it. Sign on
the owner's machine: an agent that can read a trusted private key can authorize itself, which
no CLI can prevent. Keep keys, credentials and the agent in separate places (external
enforcement), and use branch rulesets so GitHub, not the CLI, decides what can merge.

Assigning a pull request is the one write outside the SDK (`gh pr edit --add-assignee`). It runs
only with the `pulls:assign` capability, only for the configured assignee, and only on the pull
request just published.

### Credentials

`security.credentials` names where a token comes from: an environment variable, or the `gh`
login (`{"source": "gh"}`). The token is read per process, held in memory and never written,
logged, or passed to a child process. Use a fine-grained token limited to the one repository with
Pull requests and Issues write access.

## Completion results

`complete` and `deliver` take a JSON result that matches your `completion.scheme`. It is checked
against the specification on the issue (unedited, same digest), every evidence file must be
committed at a commit on the remote, and an implementation's PR must be this initiative's, at a
head that `verify` passed and `publish` published. The same result is never posted twice; a
changed result supersedes the previous one in a new comment.

## For agents

Run `comforge capabilities --json` once, then `comforge status --json`. Every command returns
deterministic JSON with `--json`, and a refusal is a stable `error` code you can branch on.

- **Claude Code:** add to `CLAUDE.md`: "Use `npx comforge <command> --json` for the ticket
  lifecycle. Never push or open PRs by hand. Dry-run before `--execute`."
- **Codex (`AGENTS.md`) and Cursor (`.cursor/rules`):** the same three sentences.
- **Any agent:** `comforge context --task "<task>" --json` returns the one routing category, its
  files and validation commands, with its size in approximate tokens.

These are guidance. The CLI's checks do not depend on an agent following them.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `config-missing` on `start` | The config is not committed on the base branch. Merge it first. |
| `untrusted-config-change` | The candidate edits a trusted section. Revert it, or have the owner merge it separately. |
| `credential-missing` | The configured variable is unset, or `gh` has no login. |
| `authorization-required` / `unauthorized` | No `security.authorization`, no `--grant`, or the grant does not match this commit, branch, specification, repository, key or time. |
| `validation-missing` on `publish` | `verify` has not passed on this exact head. |
| `dirty-checkout` | Commit or remove local changes. |
| exit 4 with `ambiguous` | A write's answer was lost. Run `comforge recover <ID> --execute`; if it still cannot find it, `--abandon`, then rerun. |
| `unsafe-path` / `ledger` | `.git/comforge` is a symlink, owned by someone else, or open to other users. |

## Upgrading

The configuration has a schema version. A future incompatible version is refused until you
migrate it; `comforge doctor` tells you. Local state records are versioned the same way.

## License

Apache-2.0
