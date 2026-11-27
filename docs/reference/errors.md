# Errors, exit codes and troubleshooting

Status: published. Every refusal is a stable `error` code an agent can branch on. CLI errors go
to stderr as `{"error": "<code>", "message": "…", "detail": {…}}`; MCP refusals are
`{"schema": "comforge-mcp-error/v1", "code", "message", "exit", "retryable", "hint"?}`. The
generated tables are authoritative for the code lists: [CLI](inventory/cli-errors.md),
[MCP](inventory/mcp-errors.md).

| Exit | Class | What to do |
|---|---|---|
| 0 | ok | — |
| 1 | refused | a governance check said no and nothing unsafe happened: fix the cause, rerun |
| 2 | usage | bad arguments or configuration: fix and rerun |
| 3 | failed | the environment failed (git, GitHub, file system): a rerun may succeed |
| 4 | incomplete | a multi-stage command stopped part-way: rerun the same command |

## CLI error codes

| Code | Exit | Cause | Fix |
|---|---|---|---|
| `usage` | 2 | unknown command or flag, missing value | `comforge <command> --help` |
| `config-missing` | 2 | no `comforge.config.json` on the base branch | commit and push it to the base branch |
| `config-invalid` | 2 | the configuration fails the schema, or a required section is missing for this command | `comforge schema config`; `comforge doctor` |
| `unsupported-platform` | 2 | Windows | run on macOS or Linux (WSL counts as Linux) |
| `untrusted-config-change` | 1 | the candidate changes a trusted configuration section | revert it in the initiative; the owner merges such a change separately |
| `not-found` | 1 | no such initiative, issue, pull request or file | check the id; `comforge status` |
| `conflict` | 1 | another process holds the initiative, a branch or PR already exists, or a concurrent change won | wait and rerun; use `revise` or a phase |
| `stale` | 1 | the issue is closed, the pull request moved, or a recorded state is older than required | re-read; start a new phase or attempt |
| `policy-denied` | 1 | a commit-contract, publication-check or review rule refused | read `detail`; fix the commit or the check |
| `validation-missing` | 1 | no `PASS` of `verify` on this exact head | `comforge verify <ID>` |
| `validation-failed` | 1 | the latest validation of the head is not `PASS` | fix the code, commit, verify |
| `specification-invalid` | 1 | the issue's specification is missing, edited or does not match its digest | publish a new specification |
| `evidence-missing` | 1 | a completion result's `sourceRevision` or evidence file is not committed on the remote | push the commit and the evidence |
| `dirty-checkout` | 1 | uncommitted or unignored files in the checkout | commit, remove or `.gitignore` them |
| `credential-missing` | 1 | the configured token variable is unset, or `gh` has no login | export it where GitHub commands run |
| `authorization-required` | 1 | no `security.authorization`, or (owner-grant) no `--grant` | the owner configures authorization; pass a grant |
| `unauthorized` | 1 | a grant that does not match repository, ticket, issue, specification, head, branch, key or time, or has no attempts left | the owner signs a new grant for this head |
| `would-overwrite` | 1 | `init --write` over a different configuration, or `start` where the checkout directory already exists | `--force` after reading the preview; remove or rename the directory |
| `git-failed` | 3 | a git command failed | read `detail`; check the remote and disk |
| `github-failed` | 3 | GitHub refused or did not answer | rerun; check the token's permissions and rate limits |
| `ambiguous` | 3 | a write's outcome is unknown | `comforge recover <ID> --execute` |
| `ledger` | 3 | the local state or write ledger is unreadable or unsafe (symlink, foreign owner, open permissions) | fix `.git/comforge` permissions; never delete it |
| `io` | 3 | a file could not be read or written | check paths and permissions |
| `incomplete` | 4 | a multi-stage command stopped part-way | rerun the same command |
| `cancelled` | 4 | an embedding caller aborted between stages | call again to continue |

## MCP error codes

The MCP server returns every CLI code above plus its own:

| Code | Cause | Fix |
|---|---|---|
| `unknown-repository` | the repository id is not allowlisted for this principal | use an id from `comforge_capabilities` |
| `repository-mismatch` | the trusted configuration names another repository | fix the binding or the configuration |
| `profile-denied` | the principal's profiles do not include this tool | launch with the needed `--profile` |
| `execution-unavailable` | over HTTP, no host-provided isolation for repository commands | use stdio locally, or a host with an `IsolationProvider` |
| `command-scope-unsupported` | the grant format cannot scope a grant to this command | run cleanup through the CLI with a command grant |
| `result-too-large` | the result would exceed the bound | page with `cursor` and `pageSize`, or read one section |
| `unavailable` | the published dependency does not provide this read | upgrade the package |
| `checkout-required` | the tool needs a checkout; this repository is served without one | serve it from a checkout |
| `config-missing` | the host supplied no trusted configuration | the host provides `trustedConfig` |
| `config-stale` | the host's configuration snapshot is too old (retryable) | retry; the host refreshes it |
| `config-mismatch` | the configuration is not the pinned one, or not GitHub's bytes at its revision | the host fixes the pin or the source |

More by symptom: [troubleshooting](../troubleshooting/troubleshooting.md).
