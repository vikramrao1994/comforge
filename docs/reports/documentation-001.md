# Documentation 001 — developer experience, recipes, reference and public benchmarks

Report of the documentation initiative tracked in the previous repository's issue tracker
(digest `629fa6d7…3578`). Reviewed revision: `ea51507` (this repository's `main`). Evidence:
[`evidence/documentation-001/`](../../evidence/documentation-001/).

## A — Audit (recorded before implementation)

Method: `tooling/docs/contracts.ts` reads every public contract from source — the CLI's command
table, the argument parser's per-command flag allowlist and the global flags, CLI and MCP error codes, MCP tool contracts, profiles and launch flags,
the configuration JSON Schema, and the runtime exports of every published subpath. Coverage
counts a name or flag as documented when it appears in `README.md`, `docs/**` or a package
README. Full inventory and decisions: [`audit.json`](../../evidence/documentation-001/audit.json).

| Contract | Total | Documented before | Gap |
|---|---|---|---|
| CLI commands | 21 | 21 | — |
| CLI command flags (parser allowlist) | 50 | 50 | — |
| CLI global flags | 6 | 4 | `--cwd`, `--help` |
| CLI error codes | 25 | 25 | — |
| MCP tools | 18 | 18 | — |
| MCP launch flags | 4 | 4 | — |
| MCP error codes | 11 | 7 | `unknown-repository`, `profile-denied`, `execution-unavailable`, `result-too-large` |
| Configuration sections and keys | 72 | 71 | `repository.webOrigin` |
| Runtime exports (16 subpaths) | 238 | 142 | 96, mostly constants and schemas |

Findings:
- **Broken links:** none (`bun run validate docs` already checks relative links).
- **Stale commands:** none; every documented command and flag exists.
- **Contract gap:** the CLI command table's usage lines omit four flags the parser accepts
  (`start --reopen`, `publish --closes`, `deliver --closes`, `grant --command`). They are in the
  CLI README; correcting the usage strings is a package change for the next CLI release.
- **Unsupported claims:** none found. No benchmark numbers were published in this repository.
- **Onboarding gaps:** no executed first workflow; no CLI vs MCP vs embedded guidance; no
  per-client setup; no troubleshooting by error code; no benchmark results or limits.
- **Duplication:** `docs/commands-and-tools.md` repeated the package READMEs' tables;
  `docs/examples.md` and `docs/runtimes-and-platforms.md` were thin single-purpose pages.

Decisions (summary; `audit.json` has one row per item):

| Item | Decision |
|---|---|
| Root README | improve: positioning, when not to use, first workflow, choices, trust, compatibility, roadmap |
| Package READMEs | retain: shipped in each tarball and authoritative per package; docs link, never copy |
| Getting started, concepts, security, troubleshooting, contributing pages | retain, moved into sections |
| `commands-and-tools.md` | consolidate into `reference/tool-selection.md` |
| `configuration.md` | improve into `reference/configuration.md` with a generated inventory |
| `runtimes-and-platforms.md`, `examples.md` | consolidate into `reference/compatibility.md`, `recipes/README.md` |
| CLI, MCP, configuration, API reference | generate from the contracts, with drift checks |
| Recipes, integrations, benchmarks | new |
| Skills, routing, `CLAUDE.md`, `AGENTS.md`, `llms.txt` | improve links and discovery only |

No material blocker: the work is documentation, generators, executable fixtures and checks.
