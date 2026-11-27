# Release intents

One JSON file per reviewed statement of how a change affects a releasable Comforge package (`@comforge/core` today). The release planner (`bun run comforge:release:plan`) reads only committed intents added since the last verified release, and they are the only input it accepts as a version bump. Commit types and scopes are never read as a bump.

```json
{
  "schema": "comforge-release-intent/v1",
  "package": "@comforge/core",
  "bump": "patch",
  "summary": "One changelog line, written for the package's consumers.",
  "breaking": null,
  "covers": []
}
```

- `bump`: `none`, `patch`, `minor` or `major`. `breaking` is required exactly for `major`: say what breaks and how to migrate. Below 1.0.0 both `minor` and `major` raise the minor version.
- `covers`: full SHAs of earlier commits since the last release that changed the package without an intent of their own, for example squashed, bulk, agent-produced or legacy commits.
- An intent is immutable once committed. The planner refuses an edited one, so a correction is a new file.
- `bun commit` offers a deterministic suggestion when a staged change touches what a package ships. It records nothing without your answer, and `--yes` never records one.

Process and policy: [docs/engineering/factory-core-distribution.md](../docs/engineering/factory-core-distribution.md), "Release automation".
