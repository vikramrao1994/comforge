# Troubleshooting

By symptom. Every error code with its cause and fix: [errors](../reference/errors.md).

| Symptom | Likely cause | Fix |
|---|---|---|
| `config-missing` on `start` | the configuration is committed but not on the base branch | push it to the base branch first |
| `untrusted-config-change` on `publish` | the candidate edits a trusted configuration section | revert it in the initiative; the owner merges such a change separately |
| `not-found` "has no local state" | a lifecycle command ran inside the initiative's checkout | run lifecycle commands from the primary clone (or `--cwd`) |
| `dirty-checkout` after `verify` | the validation wrote files (`__pycache__/`, build output) | add them to `.gitignore` |
| `validation-missing` on `publish` | no `PASS` on this exact head (a new commit needs a new `verify`) | `comforge verify <ID>` |
| `verify` reports `UNAVAILABLE` (exit 3) | the environment could not validate (a tool missing, snapshot failed) | fix the environment; it is not a test failure |
| exit 4 on `deliver` | it stopped part-way | rerun the same command |
| `ambiguous` | a write's answer was lost | `comforge recover <ID> --execute`; if a write stays `indeterminate` after checking GitHub, `recover --abandon --execute` |
| `authorization-required` | no `security.authorization`, or no `--grant` in owner-grant mode | the owner configures authorization or signs a grant |
| `unauthorized` | the grant is for another head, expired or used up | the owner signs a new grant for the current head |
| `credential-missing` | the token variable is unset in this shell | export it where GitHub commands run |
| `profile-denied` (MCP) | the server was launched without the tool's profile | add `--profile executor` / `publisher` / `reviewer` |
| `ledger` / `unsafe-path` | `.git/comforge` is a symlink, foreign-owned or world-writable | fix ownership and permissions; never delete it |
| hard-link probe fails | the filesystem has no hard links (FAT, exFAT, some network mounts) | move the repository, or give the host a SQLite ledger |
| `unsupported-platform` | Windows | macOS or Linux (WSL) |

Recovery procedures: [migration and recovery](migration-and-recovery.md) and
[recipe 4](../recipes/04-interrupted-handover-and-recovery.md). What Comforge does not do:
[known limitations](known-limitations.md).
