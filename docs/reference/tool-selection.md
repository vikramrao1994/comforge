# Commands, capabilities and tool profiles

Status: published. Authoritative tables: [CLI commands](../../packages/cli/README.md#commands) and
[MCP tools](../../packages/mcp/README.md#tools). `comforge capabilities` prints the same at runtime,
including what the CLI never does.

| Lifecycle step | CLI | MCP tool | Profile | Writes |
|---|---|---|---|---|
| Discover | `capabilities`, `context`, `doctor` | `comforge_capabilities`, `comforge_context` | all | nothing |
| Read evidence | `status`, `comments`, `prs`, `artifact`, `review list` | `comforge_status`, `comforge_evidence`, `comforge_issue`, `comforge_pr`, `comforge_prs`, `comforge_comments`, `comforge_reviews`, `comforge_artifact` | read-only | nothing |
| Start / revise | `start`, `revise` | `comforge_start`, `comforge_revise` | executor | local checkout, state |
| Verify | `verify` | `comforge_verify` | executor | state |
| Deliver | `publish`, `complete`, `deliver` | `comforge_deliver` | publisher | push, one PR, one comment |
| Recover | `recover` | `comforge_recover` | publisher | write ledger |
| Clean up | `cleanup` | `comforge_cleanup` | publisher | checkout, state, branch |
| Specifications | `spec publish` | `comforge_publish_specification` | publisher | one issue |
| Advisory reviews | `review publish` | `comforge_publish_review` | reviewer | one PR comment |
| Owner grants | `grant template`, `grant sign` | — | — | nothing (the owner signs offline) |

Profiles: `read-only`, `reviewer`, `executor`, `publisher`. Every call re-checks the profile.
