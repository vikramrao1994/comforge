# Contributing

```sh
bun install                 # workspace (candidates)
bun run harness:install     # the published harness, isolated in harness/
bun run hooks:install       # local pre-commit / pre-push checks
bun run validate            # everything CI runs, except the OS/runtime matrix
```

| Command | Runs |
|---|---|
| `bun run lint` | Biome |
| `bun run typecheck` | each package under its own tsconfig, then tooling and tests |
| `bun run test` | every package and repository test (`--isolate`) |
| `bun run disclosure` | the public-disclosure scan of the whole tree |
| `bun run validate` | routing, skills, docs links, boundaries, disclosure |

Rules:

- A change to a package's shipped files needs a reviewed **release intent**
  (`release-intents/*.json`); the planner refuses otherwise ([release governance](release-governance.md)).
- Public API changes follow semver; removing or renumbering an exit or error code is breaking
  (`tests/cli/contracts.test.ts`).
- Agents: start from [`CLAUDE.md`](../../CLAUDE.md) and the routed skill in `skills/`.
- Never commit credentials, personal data or private repository content; `bun run disclosure`
  and CI refuse them.
