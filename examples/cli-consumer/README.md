# @comforge/cli example consumer

`npm install && npm start` (or `bun demo.mjs`) creates a throwaway Makefile project with a local
bare remote in a temporary directory and runs the installed `comforge` executable through the
offline part of the lifecycle: `init` (preview, write, idempotent rerun), `doctor`, `start`,
`verify` (PASS, then FAIL after a breaking commit), `status`, `context` and `capabilities`. It
prints one JSON line of checks and exits non-zero if any failed.

GitHub is not contacted: the configuration names no specification, so `start` needs no issue.
Publication and completion are exercised against a synthetic GitHub in the Comforge
repository's own tests.
