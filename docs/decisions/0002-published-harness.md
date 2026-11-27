# 0002 — The repository is governed by a published release, never by its candidates

Status: accepted.

This repository develops Comforge with Comforge. The release that governs it is installed from
npm in `harness/` with its own lockfile, outside the workspace; the workspace packages are
candidates and never resolve as the harness. A candidate therefore cannot change the governance
that validates and publishes it. Upgrading the harness is a reviewed change to
`harness/package.json` and its lockfile.
