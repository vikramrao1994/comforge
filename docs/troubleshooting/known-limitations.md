# Known limitations

- **Not a sandbox.** `verify` runs the candidate's code as the operator. Run untrusted work in a
  container or VM.
- **Governs only what goes through it.** Direct pushes and merges by other tools are outside it;
  use branch rulesets.
- **No exactly-once delivery.** Uncertain writes are reconciled, not retried.
- **Windows is not supported** (refused).
- **GitHub only** (github.com or GitHub Enterprise).
- **Operator mode is policy, not enforcement.** Use `owner-grant` for unattended agents.
- **Agent-client interoperability** is validated with synthetic process-level clients in tests;
  results from real agent clients and live benchmarks are reported separately and are not part
  of CI (experimental).
- **Releases are attended.** This repository's `release.yml` is the single publisher; every
  release still needs an owner-signed authorization and an npm approval
  ([release governance](../contributing/release-governance.md),
  [publisher transition](../contributing/release-transition.md)). No release has been published
  from it yet.

## Status and roadmap

Status labels: **published** (released on npm), **implemented** (on `main`, unreleased),
**experimental** (synthetic or rehearsal runs only), **planned**.

- **Implemented, unreleased:** repository metadata and README changes of every package
  (`release-intents/`); they reach npm with each package's next release.
- **Known gap:** the CLI's usage lines omit four accepted flags
  ([CLI reference](../reference/cli.md#known-gap)).
- **Experimental:** the reusable benchmark library (`benchmarks/`); live agent experiments are
  not run.
- **Planned:** end-to-end agent benchmarks; a live raw-GitHub comparison; per-client
  verification beyond registration.
