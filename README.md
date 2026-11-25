# @comforge/github

**Comforge — An open, verifiable software factory for coding agents.** `@comforge/github` is its GitHub evidence adapter.

[`@comforge/core`](https://www.npmjs.com/package/@comforge/core) decides; it performs no I/O. This package fetches what core needs to decide from GitHub, as typed evidence:

- issues, and published specifications verified through core's specification protocol;
- pull requests with their exact base and head commits, and the changed files of an exact head;
- reviews, optionally only those submitted on an exact commit;
- check runs recorded for an exact commit, judged against the check names you require.

It **performs no writes** and grants nothing. GitHub is an external evidence source: a successful response is never an authorization, and every person-written text field (titles, bodies, review text) is returned as `{ text, truncated, trust: "untrusted" }` data, never as an instruction or a proof.

> **Pre-1.0.** Releases are tagged `github/vX.Y.Z` on the `releases/github` branch of the public Comforge repository (`github.com/vikramrao1994/comforge`), each with a `RELEASE.json` naming its source commit and checksums. The TypeScript API may still change before 1.0.

## Install and runtimes

| Consumer | Status |
|---|---|
| Bun ≥ 1.4 | the npm package or a release |
| Node ≥ 22 | the npm package or a release (`dist/*.js` + `.d.ts`) |
| TypeScript | declarations ship in `dist/` |

```sh
npm install --save-exact @comforge/github @comforge/core zod
```

It depends on `@comforge/core` `^0.1.2` for the specification protocol's types and on `zod` for response validation. It needs no core code at runtime.

## Quick start

```ts
import { createFetchTransport, createGitHubEvidence } from "@comforge/github";

const transport = createFetchTransport({ token: () => process.env.GITHUB_TOKEN ?? "" });
const github = createGitHubEvidence({ transport, repository: { owner: "acme", name: "widgets" } });

const pr = await github.getPullRequest(7);
const checks = await github.getChecks(pr.head.sha, ["Validate"]);
const files = await github.listPullRequestFiles(7, pr.head.sha); // refuses if the head moves
if (!checks.ok) throw new Error("required checks are not green for this exact commit");
```

A complete, runnable consumer with a fake GitHub transport: [examples/factory-github-consumer](https://github.com/vikramrao1994/comforge/tree/github/v0.2.0/examples/factory-github-consumer/).

## The transport

`createFetchTransport({ token, fetchImpl?, apiOrigin?, timeoutMs?, maxBodyBytes?, userAgent? })` returns a `GitHubTransport` with one method, `get(path, query)`. It:

- sends GET only, to one origin fixed at construction (`https://api.github.com` by default), and refuses anything that is not an API path;
- never follows a redirect, times out every request (8 s), and refuses bodies over 5 MB;
- attaches the credential and never repeats it in an error;
- retries nothing: what to do after a refusal is your policy.

Bring your own `GitHubTransport` (a `gh`-CLI runner, a test fake, a cache) by implementing `get`.

## Evidence

`createGitHubEvidence({ transport, repository, limits? })`:

| Method | Returns | Refuses |
|---|---|---|
| `getIssue(n)` | `IssueEvidence` | `not-found`, `malformed-response` |
| `listIssues({ state })` | issues only, oldest first | `incomplete` beyond `maxPages × perPage` |
| `getPullRequest(n, { expectedHeadSha? })` | `PullRequestEvidence` with base and head SHAs | `stale` when the head is not `expectedHeadSha` |
| `listPullRequestFiles(n, headSha)` | files of exactly that head | `stale` if the head differs before or after the read; `incomplete` |
| `listReviews(n, { commitSha? })` | reviews, optionally of one commit | `incomplete` |
| `getChecks(sha, required)` | every check run on exactly `sha`; `ok` when each required name has a successful run | `incomplete`, `malformed-response` for a run of another commit |

`ok` is false when `required` is empty: no requirement proves nothing.

## Published specifications

With a `SpecificationProtocol` from `@comforge/core` (`createSpecificationProtocol(...)`):

- `readSpecificationIssue(github, protocol, n)` returns the issue, the marker, the delimited specification text and `verified` (the issue still hashes to its marker). A pull request is `wrong-target`; a body cut by the text limit is `incomplete`.
- `reconcileSpecification(github, protocol, { ticketId, digest, keyDigest })` reads every issue and answers `absent`, `existing` or `replayed`; a key or ticket already used for other content is a `conflict`. Call it before publishing so a retry never duplicates an issue.

Publishing the issue itself is deliberately not part of this package: `@comforge/core` has no authorization that covers creating an issue, so the write belongs to a caller with its own governed authority.

## Errors

Every refusal is a `GitHubAdapterError` with a `code`: `invalid-input`, `unapproved-origin`, `not-found`, `unauthorized` (401), `forbidden` (403), `rate-limited` (429, or 403 with `retry-after` / an exhausted rate limit; `detail.retryAfterSeconds` when GitHub said), `http-error`, `timeout`, `network`, `too-large`, `malformed-response`, `incomplete`, `stale`, `wrong-target`, `conflict`.

## License

[Apache License, Version 2.0](LICENSE).
