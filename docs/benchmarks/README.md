# Benchmarks

**What exists:** component-level measurements of how much text an agent reads from one call of
one Comforge interface, and regression suites for routing, concurrency and recovery. **What
does not exist yet:** any measurement of an agent's end-to-end cost, of a whole session's
saving, of task success, or against another tool. Those are **pending** and nothing here
should be read as one of them. Comforge is governance infrastructure, not a token-compression
product; the numbers below describe overheads and options, not a promise.

The numbers: [summary](summary.md) (generated from the evidence; CI fails if they differ).

## How to read a number

| Label | Meaning |
|---|---|
| **equivalent** | both sides carry the same information |
| **summary** | the smaller side carries *less* information (a first look); the saving exists only for an agent that needs less than everything |
| **approximate tokens** | `ceil(characters / 4)`; no tokenizer was run. Ratios are reliable, absolute counts are not |
| **tokenizer tokens** | counted by a real tokenizer (historical results only; named with each) |
| **synthetic** | measured against the synthetic GitHub fixture, not github.com |
| **historical** | measured on earlier versions, before this repository existed; kept with its original versions and never attributed to the current releases |

## Provenance and reproduction

| Result | Versions | Method | Reproduced with current releases? | Reproduce |
|---|---|---|---|---|
| Compact MCP discovery (`--compact-discovery`) | 0.3.0 | characters of `tools/list` | **yes** — 38.9–45.5% fewer characters; historical tokenizer counts gave 39–45% | `bun run benchmarks:measure` |
| CLI `--compact` | 0.5.0 | characters of stdout | **yes** — 24–30% fewer characters (historical tokenizer: 15.7–20.3%; whitespace is a larger share of characters than of tokens) | same |
| Summary-first reads | 0.5.0 / 0.3.0 | characters | **yes** — 33–80% smaller, **not equivalent** (historical: 69–80%) | same |
| MCP vs CLI for equivalent content | 0.5.0 / 0.3.0 | characters | **yes, and it differs:** MCP is 10.8% smaller than indented CLI JSON but **27.5% larger than compact CLI JSON** (historical: MCP 14–19% larger than indented CLI) | same |
| MCP vs raw GitHub, pull requests (~54%) and comments (~32.3%) | earlier candidates | tokenizer | **no** — needs live GitHub; the synthetic server returns fewer fields than github.com | pending (needs an authorized live run) |
| Onboarding machine time (install + example checks, seconds) | cli 0.4.0, mcp 0.2.0 | wall clock | **no** — needs the npm registry with an empty cache | pending |
| Context routing | — | exact-match cases | regression check in CI (this repository's own evaluation set) | `bun run validate routing` |
| Concurrency, interruption and recovery | current sources | test suites | in CI on every pull request | `bun run test` |

## Where MCP uses more than the CLI

- **Discovery.** An MCP client pays for `tools/list` once per session (about 2,000–6,400
  approximate tokens for 10–17 tools; less with `--compact-discovery`). A CLI agent pays for the
  help it chooses to read.
- **Equivalent content.** Reading every record through MCP is larger than the CLI's compact JSON
  (the result envelope and one call per record).
- **The wire.** MCP results carry text and `structuredContent`; a client usually gives the model
  one of them. `--summary-text` shrinks the text to one line but leaves the structured content.

## Running the measurements

```sh
bun install --frozen-lockfile && bun run harness:install
bun run benchmarks:measure     # writes evidence/benchmarks/component-measurements.json
bun run benchmarks:summary     # regenerates docs/benchmarks/summary.md
bun run benchmarks:check       # what CI runs: the page matches the evidence
```

The measurement uses the published harness (`harness/`), the synthetic GitHub on 127.0.0.1 and
twelve synthetic initiatives; it needs no credential, no network and no model. Absolute
character counts vary by a few characters between runs (temporary paths and timestamps).
The reusable benchmark library for agent experiments is [`benchmarks/`](../../benchmarks/);
it has a dry-run self-check and publishes no results.
