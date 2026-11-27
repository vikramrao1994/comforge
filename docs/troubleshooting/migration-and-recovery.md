# Migration and recovery

Status: published.

- **Importing earlier state**: `comforge migrate` (dry run) then `--execute` imports an earlier
  lifecycle's records named by `state.legacy`; it is journaled, resumable and keeps a backup.
  `--rollback` restores the earlier state while nothing was written after the import.
- **Interrupted delivery**: rerun the same `deliver`; recorded stages are skipped and an
  uncertain write goes through `recover`.
- **Lost checkout**: `revise <PR>` re-creates it from the PR head.
- **A cleaned-up initiative**: `start --reopen` begins a new attempt.
- **Upgrading Comforge**: pin exact versions; read the package CHANGELOG; `comforge doctor`
  checks the result.
