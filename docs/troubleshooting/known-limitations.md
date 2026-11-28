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
- **Self-hosted publication** from this repository is implemented but not yet the active
  publisher (planned switch-over; [release publisher transition](../contributing/release-transition.md)).
