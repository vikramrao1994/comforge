# Visual identity and presentation assets

Comforge presents itself as a developer library: restrained, readable in light and dark themes,
and honest about what each picture shows. Every visual asset is generated from code in this
repository and checked in CI, so none of them can drift from its source.

## Identity

| Element | Decision | Why |
|---|---|---|
| Mark | an accent tile with a prompt chevron and cursor bar | Comforge is used from a terminal and by agents that run commands; the mark says "developer tool" without borrowing any product's symbol |
| Wordmark | lowercase `comforge`, geometric monoline strokes drawn as paths | renders identically with no font installed (on GitHub, npm and in the social card) |
| Tagline | *Build with agents. Govern with code.* | the two halves of the product: agents do the work, deterministic code decides every permission |
| Palette | ink `#0f1720` / `#e6edf3`, muted `#4b5563` / `#9aa4b2`, accent `#0b7285` / `#3bc9db` (light / dark) | one accent only; every text pairing has a contrast ratio of at least 4.5:1 |
| Counterexample colour | amber `#b45309` / `#f59e0b`, charts only | marks a result where Comforge is larger, so it is never mistaken for a saving |

## Assets and their sources

| Asset | Source | Regenerate | Checked by |
|---|---|---|---|
| `docs/assets/brand/comforge-logo-{light,dark}.svg`, `comforge-mark.svg`, `social-preview.svg` | `tooling/brand/brand.ts` | `bun run brand` | `bun run validate brand` |
| `docs/assets/brand/social-preview.png` (1280×640) | rasterized from `social-preview.svg` | `bun tooling/brand/social.ts` (needs agent-browser) | presence only |
| `docs/assets/diagrams/*.svg` | `tooling/brand/diagrams.ts` | `bun run brand` | `bun run validate brand` |
| `docs/assets/charts/*.svg` | `tooling/benchmarks/charts.ts`, from `evidence/benchmarks/*.json` | `bun run benchmarks:summary` | `bun run validate benchmarks` |
| `docs/demos/*.md`, `docs/assets/demos/*.svg` | `tooling/demos/demos.ts`, by running each scenario | `bun run demos` | `bun run validate demos` (re-records) |
| output shown in the root README | copied from a demo transcript | — | `bun run validate excerpts` |

Rules for new assets:

- **Generated, not drawn by hand.** Add a generator and a check, as above.
- **Own background.** Diagrams and charts draw their own panel and switch palette with
  `prefers-color-scheme`, so they stay legible on either GitHub theme and on npm.
- **Accessible.** Every SVG has a `<title>` and a `<desc>` that states its content in words;
  Markdown images have alt text; every demo has a text transcript.
- **Small.** SVG over raster; the only raster image is the social preview GitHub requires.
- **Honest.** A demo shows recorded output only, names its synthetic GitHub and lists every
  normalized value. A chart reads every number from evidence and names its unit, versions and
  kind of comparison.

## Package READMEs

Each package README has the same sections in the same order: install, quick example, what it
provides, compatibility, limitations, documentation. npm renders a README without the
repository, so package READMEs use absolute links and images only (`bun run validate links`
enforces this). A README is part of the package: a change reaches npm with that package's next
release, and published releases are never rewritten.

## Repository metadata (prepared; applied by the owner)

Repository settings are changed by the owner, not by a pull request. Prepared values:

- **About:** Governed lifecycle for coding agents: isolated checkouts, exact-commit validation,
  recoverable GitHub writes and verifiable pull requests. CLI and MCP.
- **Website:** `https://github.com/vikramrao1994/comforge/tree/main/docs`
- **Topics:** `ai-agents`, `coding-agents`, `mcp`, `model-context-protocol`, `github`,
  `pull-requests`, `developer-tools`, `cli`, `governance`, `typescript`
- **Social preview:** upload `docs/assets/brand/social-preview.png` (Settings → General →
  Social preview).
