# Changelog

## 0.6.0

- Additive reads: page-window listings (issues, PRs, comments, events, reviews, inline review comments), attribution fields, single comment by id, exact file bytes at a commit, PR commit membership, and review URL/updatedAt/markerPrNumber.

## 0.5.0

- Accepts @comforge/core ^0.1.2 || ^0.2.0, so a consumer of core 0.2.0 command scopes shares one core copy with github.
- Additive read-only evidence: listIssueComments, listPullRequests, getFileAtCommit (40-hex commit, strict path, bounded text) and listAdvisoryReviews/latestAdvisoryReview that verify advisory review markers through the core protocol.

## 0.4.0

- Source compatibility: WriteOperation, WriteKind and WRITE_CAPABILITIES gain pull.update and pulls:update, so an exhaustive TypeScript switch over them needs the new case. Verification now also requires the read-back to be the written resource's own number or id.
- Write outcomes carry the matched verification read as response (never on replay, accepted or indeterminate; never stored), so no second GET is needed. New pull.update (pulls:update) replaces a pull request body under an expected body digest and optional head SHA.

## 0.3.0

- Opt-in createGitHubWriter: caller-authorized issue, comment, review and pull-request creates and expected-state issue/comment updates, bound to a digested descriptor, recorded in a consumer-owned ledger, with typed verified/accepted/indeterminate outcomes. Read APIs unchanged.

## 0.2.0

- Additive read-only evidence: compareCommits(base, head) for two exact commits, optional bounded patch text with an explicit patch status on pull request files, startedAt on check runs, and listWorkflowRuns(sha) for credentials without check-run access.

## 0.1.0

- First release: a GET-only fetch transport with typed refusals; exact-SHA evidence for issues, pull requests, changed files, reviews and check runs; published-specification reading and idempotent reconciliation through @comforge/core.
