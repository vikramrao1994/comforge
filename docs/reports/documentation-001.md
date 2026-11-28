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

## B–G — What changed

Commits on `docs/documentation-001` (base `ea51507`); 23 documentation pages before,
54 after; about 5,070 lines added and 210 removed across docs, tooling, tests and evidence. No
package source, public API, release record or security boundary changed.

### Before and after

| Before | After |
|---|---|
| `docs/*.md` (17 flat pages) + decisions | sections: `getting-started/`, `concepts/`, `recipes/`, `integrations/`, `reference/` (+ generated `inventory/`), `benchmarks/`, `security/`, `troubleshooting/`, `contributing/`, `decisions/`, `reports/` |
| `commands-and-tools.md` | `reference/tool-selection.md` (interface choice, step → tool, rules for agents) |
| `configuration.md` | `reference/configuration.md` (every section and key) + generated key inventory |
| `runtimes-and-platforms.md` | `reference/compatibility.md` (runtimes, platforms, package versions, formats) |
| `examples.md` | `recipes/README.md` (recipes, then the examples) |
| — | `reference/cli.md`, `mcp.md`, `errors.md`, `api.md`; 11 recipes; 4 integration guides; benchmark method and summary; troubleshooting by symptom |
| README: package table and two commands | positioning, when not to use, a first workflow, interfaces, architecture, recipes, benchmark highlights, trust model, compatibility, limitations and roadmap |

Moved pages kept their content; every link in docs, skills, routing, `CLAUDE.md`, `llms.txt`,
workflows and tooling was rewritten to the new paths (`bun run validate docs`).

### Recipe execution matrix (`evidence/documentation-001/recipes.json`)

| Recipe | World | Project | Blocks | Result |
|---|---|---|---|---|
| 1 First governed initiative | synthetic GitHub | Makefile | 7 | PASS |
| 2 MCP for coding agents | synthetic GitHub | Makefile | 3 | PASS |
| 3 Parallel initiatives | synthetic GitHub | Makefile | 6 | PASS |
| 4 Interrupted handover and recovery | synthetic GitHub, 2 injected faults | Makefile | 7 | PASS |
| 5 Owner grants | synthetic GitHub | Makefile | 7 | PASS |
| 6 Specification, review, revision | synthetic GitHub | Makefile | 6 | PASS |
| 7 Embedded host services | synthetic GitHub | TypeScript | 2 | PASS |
| 8 File and SQLite persistence | none | JavaScript | 2 | PASS |
| 9 Non-TypeScript project | synthetic GitHub | Python | 5 | PASS |
| 10 Governed npm release | this repository | — | 1 (+ rehearsal by its own CI job) | PASS |
| 11 Context routing | this repository | — | 2 | PASS |

Every block runs against the published harness (`@comforge/cli` 0.5.0, `@comforge/mcp` 0.3.0) in
`tests/docs/recipes.test.ts`, in every CI test job (about 30 s). Writing the recipes found and
documented real behaviour: a single lost answer is reconciled inside the same run (recipe 4
needed two faults to stop one); an unfound write stays `indeterminate` and `recover --execute`
exits 4 until it is abandoned; lifecycle commands must run from the primary clone; Python's
bytecode cache can make a same-size, same-second fix look unfixed (`python3 -B`); a write without
`--grant` in owner-grant mode is `authorization-required`, not `unauthorized`.

### Reference coverage (`evidence/documentation-001/coverage-after.json`)

| Contract | Total | Before | After |
|---|---|---|---|
| CLI commands | 21 | 21 | 21 |
| CLI command flags (parser allowlist) | 50 | 50 | 50 |
| CLI global flags | 6 | 4 | 6 |
| CLI error codes | 25 | 25 | 25, each with cause and fix |
| MCP tools / profiles / launch flags | 18 / 4 / 4 | 18 / — / 4 | 18 / 4 / 4 |
| MCP error codes | 11 | 7 | 11 |
| Configuration sections and keys | 72 | 71 | 72 |
| Runtime exports (16 subpaths) | 238 | 142 | 238 in the generated inventory (115 with a source summary; 61 explained by hand) |

The inventories are generated from the contracts (`bun run docs:generate`); `bun run validate`
fails when they are stale, when a handwritten page misses a contract item, or when any document
names a command, flag or tool the contracts do not declare.

### Benchmark provenance (`evidence/benchmarks/`, [summary](../benchmarks/summary.md))

| Result | Historical (earlier candidates, tokenizer) | Now (0.5.0 / 0.3.0, characters) |
|---|---|---|
| Compact MCP discovery | 39–45% fewer tokens | reproduced: 38.9–45.5% fewer characters; identical discovery sizes |
| CLI `--compact` | 15.7–20.3% | reproduced: 24.0–30.1% (characters weigh whitespace more) |
| Summary-first reads (not equivalent) | 69–80% | reproduced: 33.3–80.0% |
| MCP vs CLI, equivalent content | MCP 14–19% larger than indented CLI | **different now:** MCP 10.8% smaller than indented, 27.5% larger than compact CLI |
| MCP vs raw GitHub: PRs ~54%, comments ~32.3% | measured on live GitHub | not reproduced (needs live GitHub); kept historical |
| Onboarding machine time | 0.5–2.6 s per example | not reproduced (needs the npm registry); kept historical |
| End-to-end agent cost, competitive comparison | — | **pending**; no measurement exists |

### Agent integrations (`evidence/documentation-001/integrations.json`)

Claude Code 2.1.276 and codex-cli 0.144.6: registration verified with their own `mcp add`
commands (in a throwaway repository and a temporary `CODEX_HOME`); their sessions were not run
(a session runs a model; Claude Code project servers also need interactive approval). Cursor:
not installed, guide marked untested. The server handshake, discovery per profile and a tool
call are verified in CI by the MCP SDK client (recipe 2).

### Disclosure review

`bun run disclosure`: clean. No private ticket ids, previous-repository names, private paths,
personal identifiers or credentials. Historical benchmark figures are numbers, versions and
methods only; the synthetic token used by the fixtures never appears in recipe output (the
runner fails a recipe that prints it). Commits carry the repository's noreply identity.

### Validation and CI

See `evidence/documentation-001/validation.json` for the exact commands and results. The branch
was not pushed in this initiative, so no GitHub CI run exists yet; the new checks run in the
existing `ci.yml` jobs (validators in "Lint, types, repository validators, security"; recipes
and drift tests in every "Tests" job).

### Remaining limitations

- The CLI's usage lines omit four accepted flags (`start --reopen`, `publish --closes`,
  `deliver --closes`, `grant --command`); documented, to be fixed in the next CLI release.
- Client sessions (Claude Code, Codex, Cursor) are not verified; end-to-end agent benchmarks,
  live raw-GitHub comparisons and onboarding timings are pending.
- The routing evaluation cases (26) are written with the manifest: a regression check, not an
  independent benchmark.
- Recipe 10's rehearsal block is executed by CI's dedicated rehearsal job, not by the recipe test.
- During this work a local shell mistake created and then removed an unpushed commit on this
  branch (a nested heredoc ended early; a push to `main` was attempted and rejected because the
  local `main` was behind). Nothing reached GitHub, and the configuration was untouched.

## Presentation — visual identity, demonstrations and charts

A second review direction asked the project to look and read like a mature open-source
library, not a set of internal reports, without unsupported claims. Delivered as a separate pull
request after the first one merged.

### Audit (before any change)

| Finding | Evidence |
|---|---|
| The root README opened with a definition and four tables; install came fifth; no logo, badges or navigation | `rendering/before-*.jpg` (github.com, light/dark, 1280 and 390 px) |
| Package READMEs ran 174–427 lines with report-style version history, hardcoded versions and relative links that break on npm | line counts below |
| **Defect:** the MCP quickstart and the setup skill configured `comforge-mcp` with `--repo`; the published 0.3.0 binary accepts only `--repository` and exits `unknown option --repo` | reproduced against the npm package; fixed, and the `invented` check now reads MCP `args` arrays |
| Twelve links pointed at package-README anchors that no longer existed (after the README rewrite) | caught by the new `links` check, retargeted to the reference |
| The mcp changelog repeated, as "Unreleased", two items already shipped in 0.3.0 | confirmed in the published tarball's `dist/http.js`; section removed |
| Known limitations still called self-hosted publication "planned" | the publisher switch-over is complete; reworded |
| A first draft of the package READMEs failed three existing gates: hand-written core examples (the documentation test), and `raw.githubusercontent.com` image URLs (the release disclosure scan) | caught by the full test suite before the pull request; fixed as described below, gates unchanged |
| The cited historical numbers (2587/1191, 1431/969, 11019/6759, 1543/1230) | each matches `evidence/benchmarks/historical.json` and the original measurement record field for field |

### What changed

- **Identity** (`docs/assets/brand/`, [design rationale](../contributing/visual-identity.md)):
  an original prompt-glyph mark, a stroke-drawn wordmark that needs no font, light and dark
  logos, a 1280×640 social preview (SVG and PNG). One accent; text contrast ≥ 4.5:1.
- **Root README:** logo, tagline, value proposition, navigation, dynamic badges (npm, CI,
  license, Node — no hardcoded version or status), install and a first workflow with **recorded**
  output, benefits, demos, diagrams, examples, recipes, one chart, then links. Content it no
  longer carries moved to the overview and known-limitations pages.
- **Package READMEs:** one structure for all five (install, quick example, what it provides,
  compatibility, limitations, documentation), absolute links for npm. cli 427→99, mcp 273→98,
  core 387→129, github 174→82, ledger 207→78 lines; their detail moved, not
  deleted, into the reference and concept pages. The core README's examples stay verbatim
  regions of the executed example consumer; its full walkthrough and export reference moved to
  [`docs/reference/core.md`](../reference/core.md), and `tests/release/documentation.test.ts`
  checks both pages. Package images use `github.com/<repository>/raw/main/`, the only
  owner-named host the release disclosure scan admits in shipped files.
- **Terminal demonstrations** (`docs/demos/`, `docs/assets/demos/`): first governed workflow,
  parallel agents, interrupted-agent recovery — each recorded by running the scenario against
  the published harness and a local synthetic GitHub, with a text transcript. Commit time and
  server port are fixed so SHAs reproduce; only the temp directory, timestamps and durations are
  normalized, and each page says so. VHS/asciinema were not used: a static SVG rendered from the
  recorded transcript needs no extra tool and is checked byte for byte.
- **Diagrams** (`docs/assets/diagrams/`): architecture and lifecycle, generated from code.
- **Charts** (`docs/assets/charts/`): retrieval, compaction, the MCP-larger counterexample and
  the current-release measurements, read from the evidence JSON and written with the summary.
  Each names its unit, versions and kind; the summary states these are distinct
  component-level baselines, distinguishes selective retrieval from compact encoding, and
  claims no end-to-end saving.
- **Repository metadata:** About text, topics, website and the social preview are prepared in
  the visual-identity page; applying them is a repository setting for the owner.

### Checks added (all in `bun run validate`, so in CI and pre-push)

| Check | Fails when |
|---|---|
| `links` | a relative or absolute repository link, image or `#anchor` does not resolve; a package README uses a relative link; a badge names an unknown package or workflow |
| `excerpts` | a `console` block in the README is not, line for line, in a recorded transcript |
| `brand` | a logo or diagram differs from its generator, or the social PNG is missing |
| `demos` | re-recording any demo produces different text or SVG |
| `benchmarks` (extended) | a chart differs from the evidence |
| `invented` (extended) | an MCP client configuration's `args` names a flag `comforge-mcp` lacks |

Reproduce: `bun run brand`, `bun run demos`, `bun run benchmarks:summary`,
`bun tooling/brand/social.ts` (PNG, needs agent-browser), and for the rendering evidence
`agent-browser` with `set media light|dark` and viewports 1280×900 / 390×844 against the
README's github.com URL.

### Rendering evidence (`evidence/documentation-001/presentation/rendering/`)

Full-page captures of the actual github.com rendering, before (`main` at the first
documentation merge) and after (this branch), each in light and dark at 1280 px and 390 px.
The README reflows at 390 px; the diagrams scale down with the column, so their small text is
best read after opening the image. Package READMEs reference their logo on `main`, so their
logos render on GitHub and npm only after the merge; npm rendering was not checked (nothing is
published by this change).

### Release governance

README and changelog edits change shipped files. Every package already has a reviewed patch
intent (repository metadata), so these changes ship with those patch releases; nothing was
versioned or published, and no historical release was rewritten. `bun run release:plan`
passes.

### Validation (local, before the pull request)

| Check | Result |
|---|---|
| `bun run test` (Node and Bun runtimes) | 1,165 pass, 6 skip, 0 fail (86 files) |
| `bun run validate` | 15 of 15 PASS, including the new `links`, `excerpts`, `brand`, `demos` |
| `bun run lint` / `bun run typecheck` | no errors (27 warnings, all in files this change does not touch) / 6 projects |
| `bun run release:plan` | exit 0; README changes ride the pending patch intents |
| README install commands against npm | pass (`evidence/documentation-001/presentation/presentation.json`) |

CI on the pull request is the authoritative run.
