# Changelog

## 0.2.0

- Additive read-only evidence: compareCommits(base, head) for two exact commits, optional bounded patch text with an explicit patch status on pull request files, startedAt on check runs, and listWorkflowRuns(sha) for credentials without check-run access.

## 0.1.0

- First release: a GET-only fetch transport with typed refusals; exact-SHA evidence for issues, pull requests, changed files, reviews and check runs; published-specification reading and idempotent reconciliation through @comforge/core.
