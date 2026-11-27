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
`--execute` (or `--write`). Every command takes `--json` and prints deterministic JSON. `--compact` prints the same JSON on
one line; `--summary` prints a bounded projection (see "Output modes").

**Candidate (unreleased) capabilities.** The sections marked "candidate" below (`start --reopen`,
command-scoped grants, the governance commands, the host policy and the output modes) are in the
source and not yet released. `package.json` still says 0.2.0; the version PR moves it.

## Commands

| Command | What it does | Writes |
|---|---|---|
| `init [--write] [--force]` | Detects conventions; previews or writes `comforge.config.json` | the config file, with `--write` |
| `doctor` | Environment, configuration, credential and ledger checks | nothing |
| `capabilities` | Commands, exit codes, error codes, what it never does | nothing |
| `context [--task TEXT]` / `context check` | The one routing category a task matches | nothing |
| `schema config` | The configuration's JSON Schema | nothing |
| `start <ID> [--issue N] [--expect-digest HEX] [--no-provision] [--reopen]` | Verifies the specification; clones an isolated checkout from the fetched base and provisions it. `--reopen` (candidate) starts a new attempt of a cleaned-up initiative | local checkout, state |
| `revise <PR> [--reviewed-head SHA] [--no-provision]` | Resumes an initiative for a revision of its open PR: re-creates a missing checkout, fast-forwards, reports divergence | state |
| `status [ID]` | Local state of one or all initiatives | nothing |
| `verify <ID> [--commit SHA] [--with NAME[,NAME]] [--keep]` | Runs the trusted validation commands on the clean, committed head (optionally in a fresh snapshot) | state |
| `publish <ID> --title T [--draft] [--closes N] [--grant FILE] [--execute]` | Runs the publication checks, pushes the validated head; creates or updates its PR | git push, PR |
| `complete --result FILE [--execute]` | Publishes a completion record as one issue comment, linked from the PR | comment, PR body |
| `deliver <ID> --title T --result FILE [--no-pr] [--draft] [--closes N] [--execute]` | `publish`, then `complete`, then reads both back; every attempt is recorded | as both |
| `recover <ID> [--abandon] [--grant FILE] [--execute]` | Reconciles unresolved writes of this initiative | write ledger |
| `grant template <ID> [--hours N] [--command cleanup]` / `grant sign <ID or -> --grant FILE --key FILE` | Owner grants (see Authorization); `--command` and `sign -` are candidate | nothing |
| `cleanup <PR or ID> [--allow-missing-completion] [--grant FILE] [--execute]` | After a merge reached the base: removes the checkout and runs the configured cleanup steps, resumably. With owner grants it needs a command grant scoping cleanup of the merged PR (candidate) | local checkout, state (and the branch, if configured) |
| `migrate [--rollback] [--execute]` | Imports an earlier lifecycle's local state (`state.legacy`) | local state |
| `spec publish <TICKET> --title T --body-file FILE [--issue N] [--key K] [--grant FILE] [--execute]` (candidate) | Publishes a specification issue (digest marker, idempotent, read back); `--issue` replaces one | one issue |
| `review publish --review-file FILE [--grant FILE] [--execute]` / `review list <PR>` (candidate) | Publishes an advisory review comment bound to the reviewed head (never a native review or approval, never of one's own PR); lists a PR's advisory reviews with integrity and provenance | one PR comment (publish) |
| `comments <ISSUE or PR>` (candidate) | Every comment, as bounded untrusted text | nothing |
| `prs [--state open\|closed\|all]` (candidate) | The repository's pull requests | nothing |
| `artifact <COMMIT> <PATH>` (candidate) | A file at an exact commit, only under the trusted `artifacts.readable` paths; never raw bytes | nothing |

`<ID>` is a ticket (`ACME-101`) or a phase of one (`ACME-101.b`), which gets its own branch
(`agent/acme-101.b`) and checkout and must keep its ticket's specification.

## Output modes (candidate)

| Flag | Output |
|---|---|
| `--json` | Deterministic, indented JSON |
| `--json --compact` | The same content on one line (fewer bytes and tokens) |
| `--json --summary` | A bounded first look: scalars stay, an array becomes its count and its first item's scalar fields. The full result is one call without the flag. Very small results can grow by the `summary` marker |

Measured on one repository: `--compact` lowered every initiative's status from 3,701 to 3,120
tokens. These are per-call tokenizer counts; no end-to-end saving is claimed.

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
| 4 | `incomplete`, `cancelled` |

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

Sections added in 0.2.0, and the candidate sections `review` and `artifacts`, change nothing until you set them; while each equals its default it is
left out of the trusted digest, so initiatives started under 0.1.0 keep working:

| Section | What it configures |
|---|---|
| `state` | `writeLedgerDirectory` (share an earlier lifecycle's write ledger), `legacy` (its state, for `migrate`) |
| `lifecycle` | `remotePreflight` (refuse a branch or PR that exists), `phaseRequiresCleanParent` |
| `verification` | `snapshot` (fresh clone of the exact commit), `unavailableExitStatuses`, `summary` (a recorded JSON artifact), `optional` (commands run with `--with`) |
| `publication` | `checks` (before any push), `bodyCommand`, `marker`, `draftFirst` (needs `pulls:ready`), `linkMarkerNamespace`, `reportPullRequestReason` |
| `cleanup` | `deleteRemoteBranch` (needs `branches:delete`), `deleteLocalBranch`, `fastForwardPrimary`, `after` (commands) |
| `review` (candidate) | The advisory-review protocol: `reviewScheme`, `markerNamespace`, `publisherName`, `publishToolName`, `trustedAuthors`. Absent: no review services |
| `artifacts` (candidate) | `readable`: repository path prefixes `artifact` may read at a commit; empty means the evidence report directory only |

Commands are argument vectors, never shell strings. `specification` and `completion` name the
[`@comforge/core`](https://www.npmjs.com/package/@comforge/core) protocols; a repository that
configures the same names produces byte-identical records.

### Trust

Configuration is repository text and grants nothing. `repository`, `tickets`, `validation`,
`specification`, `completion`, `security`, `state`, `lifecycle`, `verification`, `publication`, `cleanup`, `review` and
`artifacts` are read from the base revision the initiative started from (what the owner already
merged), never from the working tree. If a candidate changes
any of them, `publish` refuses with `untrusted-config-change`; the owner merges such a change by
other means. Instructions, skills and `context` output are guidance: no command reads them to
decide a permission.

### Authorization

Holding the CLI and a GitHub credential is not authority. `security.authorization` in the trusted
configuration decides who may cause a GitHub write:

| Setting | Meaning |
|---|---|
| absent (default) | Every write (`publish`, `complete`, `deliver`, `recover` with `--execute`) is refused with `authorization-required`. Local commands work. |
| `{"mode": "owner-grant", "grantScheme": "acme-grant/v1", "trustedKeys": [...], "revokedGrants": [...]}` | Each write needs `--grant FILE`: an owner-signed grant (Ed25519, the `@comforge/core` grant protocol) bound to this repository, the ticket and its issue, the unedited specification digest, the base commit, the exact commit and branch, with an expiry (at most 7 days) and a number of attempts. Reuse past its attempts is refused as a replay. |
| `{"mode": "operator"}` | Whoever runs the CLI with the credential decides. An explicit owner choice with no independent authorization: policy, not enforcement. |

`revokedGrants` (candidate) lists grant ids the owner revoked; it is trusted configuration, so a
candidate cannot un-revoke one, and a listed grant is refused even while valid.

**Command scopes (candidate).** Writes are authorized by `authorizeCommand` of
[`@comforge/core`](https://www.npmjs.com/package/@comforge/core) (see its README for the grant format). A grant
without a command scope keeps its meaning for `publish`, `complete`, `deliver` and `recover`, and
is never valid for `cleanup`. `cleanup` with owner grants needs a command grant scoping cleanup of
the merged pull request: `comforge grant template <ID> --command cleanup` prints it, and a
cleanup grant is never spent on a publication. Governance grants (specification and review
publication) have no initiative, so they are signed with `comforge grant sign - --grant FILE --key
FILE`; `spec publish` and `review publish` print their template in the dry run.

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

Governance writes (candidate) need the capabilities `issues:create` / `issues:update` (`spec
publish`) and `issues:comment` (`review publish`) in `security.capabilities`.

Three writes happen outside the SDK, each through one bounded host adapter and only with its own
capability (each is recorded before it runs and settled by what GitHub then shows, never by the
adapter's exit status alone, so a lost answer or a dead process is reconciled, not repeated): assigning the configured login to the pull request just published (`pulls:assign`,
`gh pr edit --add-assignee`), marking that pull request ready for review (`pulls:ready`,
`gh pr ready`; GitHub's REST API cannot leave draft), and deleting the initiative's merged branch
during cleanup under a lease on the published commit (`branches:delete`, `git push`).

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

### Provisioning

Each `checkout.provision` command runs in a new checkout (or a verification snapshot) without the
credential, with `COMFORGE_PRIMARY`, `COMFORGE_PROVISION_PURPOSE` (`checkout` or `snapshot`) and
`COMFORGE_PROVISION_RESULT`. A command may write `comforge-provision-result/v1` JSON
(`{"schema", "steps": [{"name", "detail", "digest"?}]}`) to that file; it must be a regular file of
at most 64 KiB without secret-like text, and is recorded on the initiative.

### Verification results

`PASS`, `FAIL` (exit 1) or `UNAVAILABLE` (exit 3): the environment could not validate, because the
snapshot could not be prepared, a command exited with one of `verification.unavailableExitStatuses`,
or the configured summary is missing or too large. Only `PASS` on the exact head publishes.

### Delivery and cleanup

`deliver` records an attempt before its first remote write and completes only after reading the
completion record and the pull request link back from GitHub; a run that stopped on an unresolved
write is `uncertain`. A report delivered with its own pull request (audit, investigation, design,
experiment) needs `pullRequest.reason` in the result or `publication.reportPullRequestReason`.
The result's issue, ticket and specification digest may be left out: they come from the initiative.

`cleanup` first proves the merge reached the base branch (stricter than 0.1.0), refuses while a write
of the initiative is unresolved, and removes only an isolated clone with nothing unpublished. Its
steps are journalled, so a rerun resumes where an interrupted cleanup stopped.

## Migrating from an earlier lifecycle

`comforge migrate` imports records of the `agent-lifecycle/v1` format named by `state.legacy`. It is
a dry run by default. `--execute` writes a `.migrated` sentinel into the legacy directory first (the
earlier lifecycle refuses to write once it exists), backs up every record byte for byte, imports
them under a journal (an interrupted import resumes), and refuses unknown formats, conflicts and
unverified specifications. Write identities are kept by sharing the legacy write ledger
(`state.writeLedgerDirectory`); an unresolved write that belongs to no initiative refuses the
migration, and no new write is sent for an initiative until its earlier ones are resolved.
`--rollback --execute` undoes an import only while nothing changed since.

The earlier lifecycle's writers register themselves in `.writers/` of its directory for as long as
they run. After writing the sentinel, `migrate` waits (`--wait SECONDS`, default 30) until none
of them is alive, so no earlier-lifecycle process can still write while the inventory is taken;
a live writer, or one registered from another host, fails the migration closed.

## Embedding

`createLifecycleServices({ runtime, repository, credentials?, state?, writeLedger?, signal? })`
returns the lifecycle commands as functions that resolve to `{ ok: true, value, exit }` or
`{ ok: false, error: { code, message, detail, exit } }`, with the CLI's codes. Every dependency is
injected (no `process` access, no cwd discovery, no shared credential); `state` and `writeLedger`
take any `@comforge/ledger` (for example SQLite); `signal` cancels between stages (`cancelled`).
Authorization is still the trusted configuration's. The `comforge` executable calls these same
services. The services also cover the governance and read commands above (candidate).

Two kinds of input meet there, and they are trusted differently:

- **Trusted host wiring** (`createLifecycleServices` options): the runtime, the repository, the
  credential provider, the stores and the signal. Only the embedding program supplies these; a
  service never takes them from a request.
- **Untrusted request input** (each call's options, for example from an MCP tool call): ids,
  titles, result files. It is parsed and checked like command-line input: ids must match the
  ticket pattern (no paths), unknown fields are ignored, and a caller-supplied `authorized` value is
  removed. Writes are authorized only by the trusted configuration, and with owner grants only by
  a grant file signed by a trusted key; a destructive cleanup needs a grant of its own.

A cancelled call stops at the next stage boundary, never inside a write; a delivery cancelled after
a remote write records an incomplete attempt and finishes when called again.

### Host policy (candidate)

`createLifecycleServices({ …, host })` takes a `HostPolicy` (`src/host.ts`): trusted code of the
embedding supervisor, never a flag, configuration or tool input. The `comforge` executable sets
none of it.

| Field | Effect |
|---|---|
| `checkoutParent` | Absolute directory for isolated checkouts, instead of `checkout.parent`; must lie outside the primary checkout and not be a filesystem root. Recorded on the initiative; cleanup removes such a checkout only under the same policy |
| `prepareCheckout(dir)` | Runs after the clone and before provisioning (for example, hand the checkout to a worker user) |
| `remove(dir)` | Removes a directory the lifecycle created (a checkout, a verification snapshot), for example as the user that owns the candidate's files |
| `validation` | Commands for `verify`, replacing the trusted configuration's; each validation is recorded with `policy: "host"` |

### Reopening (candidate)

`start <ID> --reopen` turns a cleaned-up initiative into its next attempt. The finished attempt is
archived verbatim in `attempts`, and `grantUses` are kept, so a grant's attempts are never
refunded. Without `--reopen`, a cleaned initiative is refused. A concurrent reopen fails with
`conflict`; an initiative that was never started, or retired by `migrate --rollback`, cannot be
reopened.

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

From 0.1.0 to 0.2.0 nothing changes unless you set a new section, with two exceptions: `cleanup`
now refuses until the merge is on the base branch or while a write is unresolved, and the error
code `cancelled` (exit 4) exists for embedders.

The configuration has a schema version. A future incompatible version is refused until you
migrate it; `comforge doctor` tells you. Local state records are versioned the same way.

## License

Apache-2.0
