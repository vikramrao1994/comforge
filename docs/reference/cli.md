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

## Requirements and limits

| | |
|---|---|
| Runtimes | Node.js 22.18 or later, Bun 1.4 or later ([compatibility](compatibility.md)) |
| Platforms | macOS and Linux; Windows is refused (`unsupported-platform`) |
| Git | 2.30 or later on `PATH` |
| GitHub | github.com, or GitHub Enterprise through `repository.apiOrigin` |
| Optional | `gh`, only for assigning pull requests (`security.delivery.assignee`) or the `gh` credential source |
| Your project | any language: validation and provisioning are commands you configure |

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

## Output modes

| Flag | Output |
|---|---|
| `--json` | deterministic, indented JSON |
| `--json --compact` | the same content on one line (fewer bytes and tokens) |
| `--json --summary` | a bounded first look: scalars stay, an array becomes its count and its first item's scalar fields. The full result is one call without the flag. Very small results can grow by the `summary` marker |

Measured on one repository, `--compact` lowered every initiative's status from 3,701 to 3,120
tokens. These are per-call tokenizer counts; no end-to-end saving is claimed.

## Trust and configuration sections

Configuration is repository text and grants nothing. The sections `repository`, `tickets`,
`validation`, `specification`, `completion`, `security`, `state`, `lifecycle`, `verification`,
`publication`, `cleanup`, `review` and `artifacts` are read from the base revision the initiative
started from (what the owner already merged), never from the working tree. If a candidate changes
any of them, `publish` refuses with `untrusted-config-change`; the owner merges such a change by
other means. Instructions, skills and `context` output are guidance: no command reads them to
decide a permission.

The sections beyond the original set (`state`, `lifecycle`, `verification`, `publication`,
`cleanup`, `review`, `artifacts`) change nothing until you set them. While a section equals its
default it is left out of the trusted digest, so initiatives started under an earlier release keep
working. A future incompatible configuration version is refused until you migrate it;
`comforge doctor` tells you. Local state records are versioned the same way.

## Authorization details

Holding the CLI and a GitHub credential is not authority. `security.authorization` in the trusted
configuration decides who may cause a GitHub write:

| Setting | Meaning |
|---|---|
| absent (default) | every write (`publish`, `complete`, `deliver`, `recover` with `--execute`) is refused with `authorization-required`; local commands work |
| `{"mode": "owner-grant", "grantScheme": "acme-grant/v1", "trustedKeys": [...], "revokedGrants": [...]}` | each write needs `--grant FILE`: an owner-signed grant (Ed25519, the `@comforge/core` grant protocol) bound to this repository, the ticket and its issue, the unedited specification digest, the base commit, the exact commit and branch, with an expiry (at most 7 days) and a number of attempts (`maxAttempts`). Reuse past its attempts is refused as a replay |
| `{"mode": "operator"}` | whoever runs the CLI with the credential decides: an explicit owner choice with no independent authorization, so policy, not enforcement |

`revokedGrants` lists grant ids the owner revoked. It is trusted configuration, so a candidate
cannot un-revoke one, and a listed grant is refused even while valid.

**Command scopes.** Writes are authorized by `authorizeCommand` of `@comforge/core` (see
[protocols and authority](../concepts/protocols-and-authority.md)). A grant without a command scope
keeps its meaning for `publish`, `complete`, `deliver` and `recover`, and is never valid for
`cleanup`. `cleanup` with owner grants needs a command grant scoping cleanup of the merged pull
request: `comforge grant template <ID> --command cleanup` prints it, and a cleanup grant is never
spent on a publication. Governance grants (specification and review publication) have no
initiative, so they are signed with `comforge grant sign - --grant FILE --key FILE`;
`spec publish` and `review publish` print their template in the dry run.

**Two checks guard a write.** The owner authorization above decides whether this run may write at
all. Inside the run, the `@comforge/github` writer authorizes each operation separately: only the
exact descriptor the command prepared, for 60 seconds, within the configured capabilities. The
second never replaces the first.

**Attempts.** `publish`, `complete` and `deliver` each spend one attempt of a grant before their
first remote side effect (`git push`, a pull request create or update, a comment, an assignment).
Attempts are counted in the initiative's local state by compare-and-swap, so concurrent runs can
never spend more than `maxAttempts` between them, and a spent attempt is not given back: a run that
dies needs another attempt, and its earlier write is then answered from the write ledger, not sent
again. `recover` verifies the grant but spends nothing, because it writes nothing remote
(reconciliation reads; abandoning is local). When the attempts are gone, the owner signs a new
grant.

Because the setting is trusted configuration, a candidate cannot add a key or switch the mode, and
an uncommitted working copy is ignored. `comforge grant template <ID>` prints an unsigned grant
for the current head; `comforge grant sign <ID> --grant FILE --key FILE` signs it. Sign on the
owner's machine: an agent that can read a trusted private key can authorize itself, which no CLI
can prevent. Keep keys, credentials and the agent in separate places, and use branch rulesets so
GitHub, not the CLI, decides what can merge.

Governance writes need the capabilities `issues:create` / `issues:update` (`spec publish`) and
`issues:comment` (`review publish`) in `security.capabilities`.

**Writes outside the SDK.** Three writes happen through one bounded host adapter each, and only
with their own capability. Each is recorded before it runs and settled by what GitHub then shows,
never by the adapter's exit status alone, so a lost answer or a dead process is reconciled, not
repeated:

- assigning the configured login to the pull request just published (`pulls:assign`, `gh pr edit --add-assignee`);
- marking that pull request ready for review (`pulls:ready`, `gh pr ready`; GitHub's REST API cannot leave draft);
- deleting the initiative's merged branch during cleanup under a lease on the published commit (`branches:delete`, `git push`).

**Credentials.** `security.credentials` names where a token comes from: an environment variable,
or the `gh` login (`{"source": "gh"}`). The token is read per process, held in memory and never
written, logged, or passed to a child process. Use a fine-grained token limited to the one
repository with Pull requests and Issues write access.

## Completion results, provisioning and verification

`complete` and `deliver` take a JSON result that matches your `completion.scheme`. It is checked
against the specification on the issue (unedited, same digest), every evidence file must be
committed at a commit on the remote, and an implementation's pull request must be this
initiative's, at a head that `verify` passed and `publish` published. The same result is never
posted twice; a changed result supersedes the previous one in a new comment.

**Provisioning.** Each `checkout.provision` command runs in a new checkout (or a verification
snapshot) without the credential, with `COMFORGE_PRIMARY`, `COMFORGE_PROVISION_PURPOSE`
(`checkout` or `snapshot`) and `COMFORGE_PROVISION_RESULT`. A command may write
`comforge-provision-result/v1` JSON (`{"schema", "steps": [{"name", "detail", "digest"?}]}`) to
that file; it must be a regular file of at most 64 KiB without secret-like text, and is recorded on
the initiative.

**Verification results.** `PASS`, `FAIL` (exit 1) or `UNAVAILABLE` (exit 3): the environment could
not validate, because the snapshot could not be prepared, a command exited with one of
`verification.unavailableExitStatuses`, or the configured summary is missing or too large. Only
`PASS` on the exact head publishes.

**Delivery and cleanup.** `deliver` records an attempt before its first remote write and completes
only after reading the completion record and the pull request link back from GitHub; a run that
stopped on an unresolved write is `uncertain`. A report delivered with its own pull request (audit,
investigation, design, experiment) needs `pullRequest.reason` in the result or
`publication.reportPullRequestReason`. The result's issue, ticket and specification digest may be
left out: they come from the initiative. `cleanup` first proves the merge reached the base branch,
refuses while a write of the initiative is unresolved, and removes only an isolated clone with
nothing unpublished. Its steps are journalled, so a rerun resumes where an interrupted cleanup
stopped.

**Reopening.** `start <ID> --reopen` turns a cleaned-up initiative into its next attempt. The
finished attempt is archived verbatim in `attempts`, and `grantUses` are kept, so a grant's
attempts are never refunded. Without `--reopen`, a cleaned initiative is refused. A concurrent
reopen fails with `conflict`; an initiative that was never started, or retired by
`migrate --rollback`, cannot be reopened.

## Migrating from an earlier lifecycle

`comforge migrate` imports records of the `agent-lifecycle/v1` format named by `state.legacy`. It
is a dry run by default. `--execute` writes a `.migrated` sentinel into the legacy directory first
(the earlier lifecycle refuses to write once it exists), backs up every record byte for byte,
imports them under a journal (an interrupted import resumes), and refuses unknown formats,
conflicts and unverified specifications. Write identities are kept by sharing the legacy write
ledger (`state.writeLedgerDirectory`); an unresolved write that belongs to no initiative refuses
the migration, and no new write is sent for an initiative until its earlier ones are resolved.
`--rollback --execute` undoes an import only while nothing changed since.

The earlier lifecycle's writers register themselves in `.writers/` of its directory for as long as
they run. After writing the sentinel, `migrate` waits (`--wait SECONDS`, default 30) until none of
them is alive, so no earlier-lifecycle process can still write while the inventory is taken; a
live writer, or one registered from another host, fails the migration closed.

## Embedding the lifecycle services

`createLifecycleServices({ runtime, repository, credentials?, state?, writeLedger?, signal?, host? })`
returns the lifecycle commands as functions that resolve to `{ ok: true, value, exit }` or
`{ ok: false, error: { code, message, detail, exit } }`, with the CLI's codes. Every dependency is
injected (no `process` access, no cwd discovery, no shared credential); `state` and `writeLedger`
take any `@comforge/ledger` (for example SQLite); `signal` cancels between stages (`cancelled`).
The services also cover the governance and read commands. Authorization is still the trusted
configuration's.

Two kinds of input meet there, and they are trusted differently:

- **Trusted host wiring** (the options of `createLifecycleServices`): the runtime, the repository,
  the credential provider, the stores and the signal. Only the embedding program supplies these; a
  service never takes them from a request.
- **Untrusted request input** (each call's options, for example from an MCP tool call): ids,
  titles, result files. It is parsed and checked like command-line input: ids must match the ticket
  pattern (no paths), unknown fields are ignored, and a caller-supplied `authorized` value is
  removed. Writes are authorized only by the trusted configuration, and with owner grants only by a
  grant file signed by a trusted key; a destructive cleanup needs a grant of its own.

A cancelled call stops at the next stage boundary, never inside a write; a delivery cancelled after
a remote write records an incomplete attempt and finishes when called again.

**Host policy.** `HostPolicy` is trusted code of the embedding supervisor, never a flag,
configuration or tool input. The `comforge` executable sets none of it.

| Field | Effect |
|---|---|
| `checkoutParent` | absolute directory for isolated checkouts, instead of `checkout.parent`; must lie outside the primary checkout and not be a filesystem root. Recorded on the initiative; cleanup removes such a checkout only under the same policy |
| `prepareCheckout(dir)` | runs after the clone and before provisioning (for example, hand the checkout to a worker user) |
| `remove(dir)` | removes a directory the lifecycle created (a checkout, a verification snapshot), for example as the user that owns the candidate's files |
| `validation` | commands for `verify`, replacing the trusted configuration's; each validation is recorded with `policy: "host"` |

**Protocol services.** `@comforge/cli/protocols` gives the specification, advisory-review and
completion protocols as typed services under an explicit, versioned profile. Use it when records
were published before the repository had a `comforge.config.json`, or under identities the
configuration does not name, and must keep verifying byte for byte.

```ts
import { createProtocolServices, PROTOCOL_PROFILE_SCHEMA } from "@comforge/cli/protocols";

const { specification, review, completion } = createProtocolServices({
  schema: PROTOCOL_PROFILE_SCHEMA, // "comforge-protocol-profile/v1"; any other value is refused
  repository: "acme/widgets",
  ticketPattern: /^[A-Z]+-\d+$/,
  specification: { digestScheme, markerNamespace, publisherName, publishToolName },
  completion: { scheme, markerNamespace, runner, publishCommand, links, detectSecrets },
});
```

A profile chooses identity only: schemes, marker namespaces, publisher names, limits and links. It
cannot weaken what may be published. The completion's and the specification's marker prefixes are
always reserved (`alsoReserved` adds, never removes), and the built-in credential detector always
runs (`detectSecrets` adds a detector). `profileFromConfig(config)` is the profile a trusted
configuration describes.

**Runtime authority.** `@comforge/cli/authority` signs and verifies execution grants and
validation receipts for a host that runs work itself. It is a separate authority from
`comforge grant` and command scopes.

```ts
import { createRuntimeAuthority, ed25519Signer, RUNTIME_AUTHORITY_SCHEMA } from "@comforge/cli/authority";

const authority = createRuntimeAuthority({
  schema: RUNTIME_AUTHORITY_SCHEMA,
  repository: "acme/widgets", ticketPattern, branchForTicket,
  grantScheme: "acme-runtime-grant/v1",
  receiptScheme: "acme-runtime-receipt/v1",
  separateFrom: [lifecycleGrantScheme], // the authority refuses to exist under one of these
});
authority.grants.authorize(envelope, trustedKeys, actionContext, new Date());
authority.receipts.verify(signedReceipt, controllerPublicKeyPem, expectation);
```

Verification takes public keys only, passed per call. Signing goes through a `Signer`
(`ed25519Signer(pem)` or your own), so a verifying process never needs the private key. The
authority refuses every command grant and every grant without a specification issue, so a
lifecycle authorization can never start an execution, and it reads no key from configuration,
files or the environment. Refusals are `AuthorityError` (`unauthorized`, `validation_failed`).

## Guidance for agents

Run `comforge capabilities --json` once, then `comforge status --json`. Every command returns
deterministic JSON with `--json`, and a refusal is a stable `error` code you can branch on. For
Claude Code, add to `CLAUDE.md`: "Use `npx comforge <command> --json` for the ticket lifecycle.
Never push or open PRs by hand. Dry-run before `--execute`." Codex (`AGENTS.md`) and Cursor
(`.cursor/rules`) take the same three sentences. `comforge context --task "<task>" --json` returns
the one routing category, its files and validation commands, with its size in approximate tokens.
These are guidance: the CLI's checks do not depend on an agent following them.

## Upgrading

The configuration has a schema version, and local state records are versioned the same way.
Moving from the first release to the second changes nothing unless you set a new section, with two
exceptions: `cleanup` now refuses until the merge is on the base branch or while a write is
unresolved, and the error code `cancelled` (exit 4) exists for embedders.
