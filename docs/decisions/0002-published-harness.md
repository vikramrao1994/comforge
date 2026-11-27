# 0002 — The repository is governed by a published release, never by its candidates

Status: accepted.

This repository develops Comforge with Comforge. The release that governs it is installed from
npm in `harness/` with its own lockfile, outside the workspace; the workspace packages are
candidates and never resolve as the harness. A candidate therefore cannot change the governance
that validates and publishes it. Upgrading the harness is a reviewed change to
`harness/package.json` and its lockfile.

## Verification

`bun tooling/dogfood.ts` (also `tests/repository/dogfood.test.ts`) drives the harness's own
executable through a governed initiative against the synthetic GitHub of the package tests:
specification-verified start, exact-commit verify, a publication whose answer is lost after the
pull request was created (one POST, reconciled), recover, deliver with its completion record, an
advisory review by a separate reviewer identity and its verified read-back. **Status:
experimental** — synthetic only. The same operations on this repository's real GitHub need the
owner's `security.authorization` choice and a credential, and have not been run.
