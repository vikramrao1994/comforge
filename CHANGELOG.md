# Changelog

## 0.4.0

- Exports reviewProtocol and REVIEW_LIMITS (the advisory-review protocol a trusted configuration defines) and moves to @comforge/github 0.6.0.

## 0.3.0

- Depends on @comforge/core 0.2.0 (command scopes) and @comforge/github 0.5.0 (evidence reads); released only after both are published, read back and pinned.
- Opt-in --compact (one-line deterministic JSON) and --summary (bounded projection) output; default JSON unchanged. grant sign - signs governance command grants. Cleanup compares real paths, so checkouts under symlinked directories are recognised.
- Governance services and commands: spec publish (idempotent, read back), review publish/list (advisory comment bound to the reviewed head, never native, not one's own PR), comments, prs, artifact (trusted artifacts.readable). Owner-grant needs a scoped command grant; dry runs print its template.
- Trusted host policy for embedders (checkout parent, prepare and remove hooks, validation), start --reopen as a new attempt keeping earlier ones, writes authorized by @comforge/core command scopes (cleanup needs its own scoped grant), revokedGrants, grant template --command cleanup.
- StartResult declares the attempt number a reopened start returns (type only; the value was already returned).
- Trusted-policy commands refuse a working config naming another base than the base revision's; artifact paths and readable entries must be canonical and unique; moving evidence.reportDir under the default policy is a trusted change; snapshots use the host's prepare and remove hooks.

## 0.2.0

- cleanup proves the merge reached the base (stricter than 0.1.0), removes only an isolated, fully published clone, refuses unresolved writes, and runs journalled, resumable steps: leased remote branch deletion (branches:delete), local branch, primary fast-forward, after hooks.
- deliver records every attempt (running, complete, incomplete or uncertain) before its first side effect and completes only after reading back the completion record and the pull request link from GitHub.
- Host-adapter writes (pulls:ready, pulls:assign) are recorded before they run and settled by what GitHub shows, reconciling a dead run instead of retrying; a push is verified by reading the remote; ready requires the published head.
- comforge migrate imports an earlier lifecycle's state (state.legacy) with dry run, backup, journal, restart and guarded rollback; writes keep their identities in a shared ledger (state.writeLedgerDirectory); cancellable, injectable context.
- migrate fences the earlier lifecycle: after its sentinel it waits for registered writers to end (--wait), fails closed on live or foreign ones, takes its inventory only then, and checkpoints every stage; a grant spent on cleanup is never shared with a publication.
- publish runs trusted publication.checks before any push, can take its body from a trusted publication.bodyCommand (checked), adds --closes and a publication marker, and can create a draft then mark it ready with the pulls:ready host adapter.
- deliver fills issue, ticket and specification digest from the initiative and keeps pullRequest.reason (or publication.reportPullRequestReason) for report PRs; the completion-link block follows publication.linkMarkerNamespace and refuses ambiguous bodies.
- createLifecycleServices: the lifecycle as injected, transport-neutral services (repository, credential provider, state and write ledger, cancellation) returning typed values or structured errors; the CLI runs through them.
- verify can validate a fresh, provisioned clone of the exact commit (verification.snapshot), records UNAVAILABLE apart from FAIL, a size-bounded summary artifact, optional commands (--with) and --keep.
- Provisioning commands may report a checked comforge-provision-result/v1; start gains a remote preflight, a primary-checkout report and phase prerequisites; revise re-creates a missing checkout, fast-forwards only and reports divergence.
- A write another process still holds is refused as conflict (as in 0.1.0), an unresolved one as ambiguous.
- Lifecycle services never accept a caller-supplied authorization: it is always established from the trusted configuration inside the call.

## 0.1.0

- First release: the comforge executable for a governed agent lifecycle in any GitHub repository (init, doctor, start, revise, status, verify, publish, complete, deliver, recover, cleanup, context, capabilities, schema) on exact published core, github and ledger.
- Writes need an authorization in the trusted configuration (none refuses, owner-signed grants, or explicit operator mode); undone pull request updates take a new identity; explicit routing ambiguity; current-result selection.
- Owner-grant attempts are spent atomically across processes before the first remote side effect; recover verifies a grant without spending one; documented error codes and authorization contract.
- An update refused as stale in a race no longer blocks the same valid update later: a failed record without retry counts as finished when choosing the next identity.

## Unreleased

- First release candidate: `comforge` commands `init`, `doctor`, `start`, `revise`, `status`, `verify`, `publish`, `complete`, `deliver`, `recover`, `cleanup`, `context`, `capabilities` and `schema`, with a versioned, schema-validated `comforge.config.json`, trusted configuration from the base revision, stable exit codes and deterministic JSON.
