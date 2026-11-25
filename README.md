# @comforge/github

**Comforge — An open, verifiable software factory for coding agents.** `@comforge/github` is its GitHub evidence adapter.

[`@comforge/core`](https://www.npmjs.com/package/@comforge/core) decides; it performs no I/O. This package fetches what core needs to decide from GitHub, as typed evidence:

- issues, and published specifications verified through core's specification protocol;
- pull requests with their exact base and head commits, and the changed files of an exact head;
- reviews, optionally only those submitted on an exact commit;
- check runs recorded for an exact commit, judged against the check names you require.

The evidence API **performs no writes** and grants nothing. A separate, opt-in writer (`createGitHubWriter`, [below](#caller-authorized-writes)) performs a fixed set of GitHub writes only when your own policy authorizes each exact request. GitHub is an external evidence source: a successful response is never an authorization, and every person-written text field (titles, bodies, review text) is returned as `{ text, truncated, trust: "untrusted" }` data, never as an instruction or a proof.

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

A complete, runnable consumer with a fake GitHub transport: [examples/factory-github-consumer](https://github.com/vikramrao1994/comforge/tree/github/v0.3.0/examples/factory-github-consumer/).

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

Publishing the issue is not part of the specification protocol: `@comforge/core` has no authorization that covers creating an issue. If you publish with this package's writer, the authority is your own `authorize` policy, not core.

## Caller-authorized writes

`createGitHubWriter` is separate from everything above: the read transport and evidence objects have no write method and never gain one. Construct a writer only where you mean to write.

```ts
import { createGitHubWriter } from "@comforge/github";

const writer = createGitHubWriter({
  repository: { owner: "acme", name: "widgets" },
  token: () => mintInstallationToken(),          // yours; never stored, logged or returned
  capabilities: ["issues:comment"],               // the only writes this writer performs
  authorize: (descriptor) => myPolicy(descriptor), // yours: allow one exact descriptor, briefly
  ledger: myDurableLedger,                         // yours: atomic create + version-checked replace
  clock: Date.now,
  expectedAuthor: "acme-bot[bot]",                 // the login the token writes as
});

const outcome = await writer.execute({
  kind: "issue.comment", operationId: "acme-2026-0042-c1", issueNumber: 42, body: "Thanks.",
});
// outcome.status: "verified" | "accepted" | "indeterminate"
```

**Operations and capabilities.** Each operation needs exactly one capability; none implies another, and none is inferred from what the token permits.

| `kind` | Capability | GitHub request | Checked before the write |
|---|---|---|---|
| `issue.create` | `issues:create` | `POST /repos/{o}/{r}/issues` | — |
| `issue.comment` | `issues:comment` | `POST …/issues/{n}/comments` | the thread is an issue (or `thread: "pull-request"`), open, not locked |
| `pull.review` | `pulls:review` (COMMENT), `pulls:review:approve`, `pulls:review:request-changes` | `POST …/pulls/{n}/reviews` with `commit_id` | open, head is exactly `expectedHeadSha` |
| `pull.create` | `pulls:create` | `POST …/pulls` (same-repository head, `maintainer_can_modify: false`) | head (and optionally base) branch at the expected commit; no open PR for head and base |
| `issue.update` | `issues:update` | `PATCH …/issues/{n}` | `updatedAt`, and optionally body digest and state, unchanged |
| `comment.update` | `issues:comment:update` | `PATCH …/issues/comments/{id}` | on the expected issue; `updatedAt`, optionally body digest and author, unchanged |

Not supported, by design: merging, tags and releases, workflow dispatch, deletion, inline review comments, pending reviews and cross-repository pull requests.

**Authorization is yours and is bound to bytes.** `prepare(op)` returns the frozen `OperationDescriptor` (repository, target, capability, exact JSON payload, preconditions, and a `sha256:` digest of all of them) without sending anything. `execute(op)` builds the same descriptor and calls `authorize(descriptor)`. The decision must be `{ allow: true, descriptorDigest, expiresAt }`, with the digest of exactly this descriptor and an expiry no more than 15 minutes ahead (`limits.maxAuthorizationTtlMs`). Anything else, including a thrown error, is `authorization-denied` and nothing is sent; the expiry is checked again just before sending. The request body is derived from the descriptor only, so changing your input object after authorization changes nothing. A callback that returns `allow` is your policy, not evidence that a person approved anything.

**The ledger is what makes retries safe.** GitHub offers no idempotency key and no compare-and-swap for these endpoints, so the writer records every operation in your `OperationLedger` before sending: `reserved` → `sending` → `succeeded` | `failed` | `indeterminate` | `abandoned`. It relies on two atomic primitives — insert-if-absent (`create`) and replace-if-version (`replace`) — so two processes sharing the store cannot both send one operation. A process-local map gives that only within one process.

- The same `operationId` with the same content replays the recorded outcome without a request; with other content it is a `conflict`.
- Created bodies end with a correlation marker (`<!-- comforge-op v1 ns=… op=… fp=… -->`, digests only). A write whose answer is lost (timeout, network, 5xx, 408, unreadable 2xx) is searched for once by that marker, within `limits.reconcileMaxPages`. Found: the outcome is `recovered`. Not found: `indeterminate`, never resent automatically. Only markers by `expectedAuthor` count, since anyone with write access can copy one.
- `reconcile(operationId)` searches again; `abandon(operationId, reason)` ends the operation by your decision. A retry after a rate limit waits for `retry-after` and searches before its one resend.
- Updates carry no marker: reconciliation compares the target with the requested change.

Nothing here is exactly-once: a write can still be duplicated if it becomes visible only after you abandon it, and an expected-state check reads before it writes, so a change in between is not prevented (an edit within the same second as `updatedAt` is not even detected — pass `bodyDigest`, from `bodyDigest(body)`, to narrow that).

**Outcomes.** `verified`: a fresh read shows exactly what was authorized. `accepted`: the resource exists but differs or could not be re-read (`mismatches`, e.g. labels GitHub silently dropped for a caller without push access, or a branch that moved during a pull-request create). `indeterminate`: unknown; reconcile. Refusals throw a `GitHubAdapterError` and mean nothing was written.

**Permissions** (fine-grained token or GitHub App installation token; the writer cannot verify a token's permissions and does not try): Issues write for issue writes and issue comments; Pull requests write for reviews, pull requests and comments on pull requests; plus read access to issues, pull requests and contents (branch refs) for the checks.

## Errors

Every refusal is a `GitHubAdapterError` with a `code`: `invalid-input`, `unapproved-origin`, `not-found`, `unauthorized` (401), `forbidden` (403), `rate-limited` (429, or 403 with `retry-after` / an exhausted rate limit; `detail.retryAfterSeconds` when GitHub said), `http-error`, `timeout`, `network`, `too-large`, `malformed-response`, `incomplete`, `stale`, `wrong-target`, `conflict`; and from the writer, refused before anything was sent: `capability-denied`, `authorization-denied`, `ledger-failure`.

## License

[Apache License, Version 2.0](LICENSE).
