<p align="center">
  <a href="https://github.com/vikramrao1994/comforge">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://github.com/vikramrao1994/comforge/raw/main/docs/assets/brand/comforge-logo-dark.svg">
      <img alt="Comforge" src="https://github.com/vikramrao1994/comforge/raw/main/docs/assets/brand/comforge-logo-light.svg" height="40">
    </picture>
  </a>
</p>

# @comforge/github

Typed, governed GitHub operations: reads that return complete evidence for an exact commit or refuse, and an opt-in writer that sends only what your own policy authorizes. Every response is verified, and a successful response is never an authorization.

[![npm](https://img.shields.io/npm/v/@comforge/github?label=npm&color=0b7285)](https://www.npmjs.com/package/@comforge/github)
[![CI](https://github.com/vikramrao1994/comforge/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/vikramrao1994/comforge/actions/workflows/ci.yml)
[![License](https://img.shields.io/npm/l/@comforge/github?color=0b7285)](https://github.com/vikramrao1994/comforge/blob/main/LICENSE)
[![Node](https://img.shields.io/node/v/@comforge/github?color=0b7285)](https://github.com/vikramrao1994/comforge/blob/main/docs/reference/compatibility.md)

## Install

```sh
npm install --save-exact @comforge/github @comforge/core zod      # or: bun add --exact ...
```

`@comforge/core` supplies the specification protocol's types, and `zod` validates responses.

## Quick example

```ts
import { createFetchTransport, createGitHubEvidence } from "@comforge/github";

const transport = createFetchTransport({ token: () => process.env.GITHUB_TOKEN ?? "" });
const github = createGitHubEvidence({ transport, repository: { owner: "acme", name: "widgets" } });

const pr = await github.getPullRequest(7);
const checks = await github.getChecks(pr.head.sha, ["Validate"]);
const files = await github.listPullRequestFiles(7, pr.head.sha); // refuses if the head moves
if (!checks.ok) throw new Error("required checks are not green for this exact commit");
```

A runnable consumer with a fake GitHub transport: [examples/github-consumer](https://github.com/vikramrao1994/comforge/tree/main/examples/github-consumer).

## What it provides

| Export | Use |
|---|---|
| `createFetchTransport` | A GET-only transport pinned to one API origin: no redirects, timeouts, size limits, credential never repeated in an error, no retries |
| `createGitHubEvidence` | Issues, pull requests with exact base and head commits, changed files of an exact head, reviews, check runs, comments, files and bytes at a commit. Incomplete listings throw `incomplete`; a moved head throws `stale` |
| `listAdvisoryReviews`, `latestAdvisoryReview` | Advisory review comments with integrity, provenance and staleness decided through `@comforge/core` |
| `readSpecificationIssue`, `reconcileSpecification` | Read a published specification and its verification; reconcile before publishing so a retry never duplicates an issue |
| `createGitHubWriter` | Opt-in writes: issues, comments, reviews, pull requests and updates, each authorized as one exact descriptor and recorded in your ledger before it is sent |
| `bodyDigest`, `WRITE_CAPABILITIES`, `GITHUB_ERROR_CODES`, `GitHubAdapterError` | Digest for expected-state checks, the vocabularies, and the typed error |

Person-written text (titles, bodies, review text) is returned as `{ text, truncated, trust: "untrusted" }`, never as an instruction. The writer sends nothing unless your `authorize(descriptor)` allows the digest of that exact descriptor for at most 15 minutes. A write whose answer is lost is searched for once by a correlation marker and otherwise held as `indeterminate`, never resent automatically.

## Compatibility

- Node.js 22.18 or later, or Bun 1.4 or later.
- github.com, or GitHub Enterprise through `apiOrigin`.
- Depends on `@comforge/core` and `zod`. The writer's `ledger` is structurally a `@comforge/ledger` ledger.
- The TypeScript API may still change before 1.0.

Details: [compatibility](https://github.com/vikramrao1994/comforge/blob/main/docs/reference/compatibility.md).

## Limitations

- Evidence reads perform no writes and grant nothing; the writer is a separate object you construct only where you mean to write.
- Expected-state checks on updates are not compare-and-swap: GitHub has no conditional write for these endpoints, so a concurrent edit between the check and the write can be overwritten.
- Nothing is exactly-once. A write can still be duplicated if it becomes visible only after you abandon it.
- Not supported by design: merging, tags and releases, workflow dispatch, deletion, inline review comments, pending reviews and cross-repository pull requests.

See [writer semantics, outcomes and errors](https://github.com/vikramrao1994/comforge/blob/main/docs/reference/api.md#comforgegithub-in-detail).

## Documentation

- [Repository README](https://github.com/vikramrao1994/comforge#readme)
- [API reference](https://github.com/vikramrao1994/comforge/blob/main/docs/reference/api.md), [errors](https://github.com/vikramrao1994/comforge/blob/main/docs/reference/errors.md)
- [Persistence and reconciliation](https://github.com/vikramrao1994/comforge/blob/main/docs/concepts/persistence-and-reconciliation.md) and [recipes](https://github.com/vikramrao1994/comforge/tree/main/docs/recipes)
- [Architecture](https://github.com/vikramrao1994/comforge/blob/main/docs/concepts/architecture.md)
- [Runnable example](https://github.com/vikramrao1994/comforge/tree/main/examples/github-consumer)
- [Changelog](https://github.com/vikramrao1994/comforge/blob/main/packages/github/CHANGELOG.md)
- [License (Apache-2.0)](https://github.com/vikramrao1994/comforge/blob/main/LICENSE)
