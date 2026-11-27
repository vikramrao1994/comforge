# Recipe 11 — route a task to the right context

<!-- recipe: {"world": "repository"} -->

An agent asks which files, skill, documents and validation a task needs, instead of loading the
whole repository. Routing is guidance only: no command reads it to decide a permission.
`@comforge/cli` 0.5.0 (published) over this repository's own manifest
([`context/routing.json`](../../context/routing.json)).

**How this page is tested.** CI runs the blocks in a checkout of this repository.

```sh recipe
comforge context --task "change how the ledger stores operations" --json
```
<!-- recipe-expect: {"json": {"match.id": "ledger"}} -->

```sh recipe
comforge context check --json
```
<!-- recipe-expect: {"exit": 0} -->

`context check` validates the manifest: unique triggers, existing files and skills. The same
routing runs through MCP as `comforge_context`, and in this repository as
`bun tooling/route.ts "<task>"`.

**Side effects:** none; both commands only read.
