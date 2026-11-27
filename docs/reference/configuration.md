# Configuration

`comforge.config.json` at the repository root, committed to the base branch. Status: published.
The full JSON Schema is printed by `comforge schema config`; the reference is
[CLI › Configuration](../../packages/cli/README.md#configuration). The sections:

| Section | Decides |
|---|---|
| `repository` | `owner`, `name`, `baseBranch`, `remote`, optional `apiOrigin` (GitHub Enterprise) |
| `tickets` | the ticket id `pattern` and the agent `branchPrefix` |
| `checkout` | where isolated checkouts go and the `provision` commands run in each |
| `validation` | the trusted `commands` `verify` runs, and their timeout |
| `verification` | snapshot verification, optional named checks (`--with`), the summary file |
| `publication` | checks before a push, the PR body command, draft-first, markers |
| `completion` | the completion record scheme, marker namespace, runner identity |
| `specification` | whether a published specification is required, and its digest scheme |
| `review` | the advisory review scheme and its trusted authors |
| `security` | capabilities, `authorization` (`operator` or `owner-grant`), credentials, ledger namespace |
| `state` | the write-ledger directory and an optional earlier lifecycle to migrate from |
| `cleanup` | remote/local branch deletion and post-cleanup commands |
| `context` | the routing manifest `comforge context` reads |
| `artifacts` | paths `comforge artifact` may read at an exact commit |

Trust: the CLI reads the configuration **from the base branch at the fetched revision**, never
from the working tree, so a candidate cannot change the rules that govern its own validation and
publication. A candidate that changes it is refused at `publish` with `untrusted-config-change`.
