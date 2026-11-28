# Recipes and examples

Task-sized, executable walk-throughs. Every `sh recipe` block on these pages is run in CI by
`tests/docs/recipes.test.ts` (`bun tooling/docs/recipes.ts` locally) against the **published**
packages pinned in `harness/` — `@comforge/cli` 0.6.0 and `@comforge/mcp` 0.4.0 — never the
unreleased workspace sources. GitHub is a local synthetic server; no recipe needs a credential
or reaches github.com.

| Recipe | You learn | World | Project |
|---|---|---|---|
| [1 · First governed initiative](01-first-governed-initiative.md) | configure, specify, start, verify, deliver | synthetic GitHub | Makefile |
| [2 · MCP for coding agents](02-mcp-for-coding-agents.md) | register `comforge-mcp`, profiles, what an agent sees | synthetic GitHub | Makefile |
| [3 · Parallel initiatives](03-parallel-initiatives.md) | two tickets at once, separate checkouts and records | synthetic GitHub | Makefile |
| [4 · Interrupted handover and recovery](04-interrupted-handover-and-recovery.md) | a lost answer, `recover`, `--abandon`, finishing on another agent | synthetic GitHub, injected faults | Makefile |
| [5 · Owner grants](05-owner-grants.md) | `owner-grant` mode, signing, scoped grants | synthetic GitHub | Makefile |
| [6 · Specification, review, revision](06-specification-review-revision.md) | advisory reviews bound to a head, `revise`, stale reviews | synthetic GitHub | Makefile |
| [7 · Embedded host services](07-embedded-host-services.md) | `createLifecycleServices` and `createEngineeringHost` in your program | synthetic GitHub | TypeScript |
| [8 · File and SQLite persistence](08-file-and-sqlite-persistence.md) | ledgers, compare-and-swap, the conformance suite | none | JavaScript |
| [9 · Non-TypeScript project](09-non-typescript-project.md) | governing a Python package; failing validation blocks publication | synthetic GitHub | Python |
| [10 · Governed npm release](10-governed-npm-release.md) | intents, plan, rehearsal, owner authorization (repository tooling) | this repository | — |
| [11 · Context routing](11-context-routing.md) | routing a task to its files, skill and validation | this repository | — |

Writing a recipe: a page `NN-name.md` here. Declare its world on the line after the title
(`<!-- recipe: {"world": "github"} -->` or `"repository"`), fence executable blocks as
` ```sh recipe `, and put an expectation after a block when it must not simply exit 0:
`<!-- recipe-expect: {"exit": 1, "json": {"error": "validation-failed"}} -->`. Variables and the
working directory carry over between blocks. Fixture hooks before a block:
`<!-- recipe-before: {"faults": ["network-after"]} -->`, `{"login": "…"}`.
The runner's contract is the header of [`tooling/docs/recipes.ts`](../../tooling/docs/recipes.ts).

## Examples

Independent consumers with synthetic data, each shipped on its package's release branch and
exercised from the packed tarball in CI:

| Example | Shows |
|---|---|
| [`examples/core-consumer`](../../examples/core-consumer/) | specifications, grants, receipts, lifecycle decisions, reviews, completion records |
| [`examples/github-consumer`](../../examples/github-consumer/) | the GitHub transport and caller-authorized writes against a fake server |
| [`examples/ledger-consumer`](../../examples/ledger-consumer/) | the file and SQLite ledgers |
| [`examples/cli-consumer`](../../examples/cli-consumer/) | a non-TypeScript (Makefile) project governed by the CLI |
| [`examples/mcp-consumer`](../../examples/mcp-consumer/) | stdio and HTTP MCP servers for a Makefile and a TypeScript repository |
| [`tests/mcp/fixtures/two-package-consumer`](../../tests/mcp/fixtures/two-package-consumer/) | a host that depends on exactly `@comforge/cli` and `@comforge/mcp` |
