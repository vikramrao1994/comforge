# Changelog

## 0.1.0

- First release: the comforge executable for a governed agent lifecycle in any GitHub repository (init, doctor, start, revise, status, verify, publish, complete, deliver, recover, cleanup, context, capabilities, schema) on exact published core, github and ledger.
- Writes need an authorization in the trusted configuration (none refuses, owner-signed grants, or explicit operator mode); undone pull request updates take a new identity; explicit routing ambiguity; current-result selection.
- Owner-grant attempts are spent atomically across processes before the first remote side effect; recover verifies a grant without spending one; documented error codes and authorization contract.
- An update refused as stale in a race no longer blocks the same valid update later: a failed record without retry counts as finished when choosing the next identity.

## Unreleased

- First release candidate: `comforge` commands `init`, `doctor`, `start`, `revise`, `status`, `verify`, `publish`, `complete`, `deliver`, `recover`, `cleanup`, `context`, `capabilities` and `schema`, with a versioned, schema-validated `comforge.config.json`, trusted configuration from the base revision, stable exit codes and deterministic JSON.
