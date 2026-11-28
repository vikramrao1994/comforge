# Programmatic API

Status: published, at the versions in each heading. This page explains the entry points you
are most likely to call; the generated [API inventory](inventory/api.md) lists **every** runtime
export of every published subpath (238 across 16 subpaths), with the first sentence of its
source documentation. Types ship in each package's `dist/*.d.ts`. Consumers normally depend on
`@comforge/cli` and `@comforge/mcp` only; the three libraries are their dependencies and are
usable directly.

## `@comforge/cli` 0.5.0

| Entry point | Subpath | Use |
|---|---|---|
| `createLifecycleServices({ runtime, repository, credentials?, state?, writeLedger?, signal?, host? })` | `@comforge/cli` | every lifecycle, governance and read command as a function resolving to `{ ok: true, value, exit }` or `{ ok: false, error: { code, message, detail, exit } }` ([recipe 7](../recipes/07-embedded-host-services.md)) |
| `defaultRuntime()` | `@comforge/cli` | the process-backed runtime the `comforge` executable uses (spawn, clock, file system, environment) |
| `parseConfig`, `configJsonSchema`, `ConfigSchema` | `@comforge/cli/config` | read and validate `comforge.config.json` |
| `routeTask`, `checkManifest`, `RoutingManifestSchema` | `@comforge/cli/routing` | context routing over a manifest |
| `createProtocolServices(profile)`, `profileFromConfig` | `@comforge/cli/protocols` | specification, advisory-review and completion protocols under an explicit, versioned profile |
| `createRuntimeAuthority(options)`, `ed25519Signer`, `keyIdFor` | `@comforge/cli/authority` | execution grants and validation receipts for a host that runs work itself; refuses every command grant |

`HostPolicy` (passed as `host`) is trusted supervisor code: `checkoutParent`,
`prepareCheckout`, `remove`, `validation`. See [host services](../concepts/host-services.md).

## `@comforge/mcp` 0.3.0

| Entry point | Subpath | Use |
|---|---|---|
| `createComforgeMcpServer(options)` | `@comforge/mcp` | the MCP server over repository bindings |
| `serveStdio(options)` | `@comforge/mcp` | the stdio transport (`comforge-mcp`) |
| `createHttpHandler(options)` | `@comforge/mcp` | Streamable HTTP with authentication, allowlists, limits and per-principal sessions |
| `createEngineeringHost({ repository, transport, writes? })` | `@comforge/mcp/host` | engineering services in your own server: `evidence`, `advisoryReviews`, `trustedConfig`, `confirmTrustedConfig`, optional `writes` |
| `fetchTransport(options)`, `sqliteOperationStore(options)` | `@comforge/mcp/host` | the read transport, and a SQLite store for host writes' operation records |

## `@comforge/core` 0.2.0

Pure contracts, no I/O. `createSpecificationProtocol`, `createGrantProtocol`,
`createReceiptProtocol`, `createReviewProtocol`, `createCompletionProtocol` and
`evaluateLifecycleAction`, each also on its own subpath (`/specification`, `/grant`, `/receipt`,
`/review`, `/completion`, `/lifecycle`). Records produced under the same identities are byte
identical across hosts. See [protocols and authority](../concepts/protocols-and-authority.md)
and [`examples/core-consumer`](../../examples/core-consumer/).

## `@comforge/github` 0.6.0

`createFetchTransport` (credential, timeout, body limit), `createGitHubEvidence` (complete or
refuse reads at exact commits), `createGitHubWriter` (caller-authorized writes: each operation
descriptor is authorized separately, within the configured capabilities), `listAdvisoryReviews`,
`latestAdvisoryReview` and `readSpecificationIssue`. Errors are `GitHubAdapterError` with codes
in `GITHUB_ERROR_CODES`. See [`examples/github-consumer`](../../examples/github-consumer/).

## `@comforge/ledger` 0.1.0

`createMemoryLedger`, `createFileLedger` (`/file`), `createSQLiteLedger` with
`ledgerTableStatements` and `statementDriver` (`/sqlite`), and `ledgerConformance` (`/conformance`)
to test your own adapter ([recipe 8](../recipes/08-file-and-sqlite-persistence.md)). Errors are
`LedgerError` (`isLedgerError`).

## `@comforge/github` in detail

`@comforge/github` fetches what `@comforge/core` needs to decide, as typed evidence. The evidence
API performs no writes and grants nothing. GitHub is an external evidence source: a successful
response is never an authorization, and every person-written text field (titles, bodies, review
text) is returned as `{ text, truncated, trust: "untrusted" }` data, never as an instruction or a
proof. It depends on `@comforge/core` for the specification protocol's types and on `zod` for
response validation, and needs no core code at runtime.

### The transport

`createFetchTransport({ token, fetchImpl?, apiOrigin?, timeoutMs?, maxBodyBytes?, userAgent? })`
returns a `GitHubTransport` with one method, `get(path, query)`. It sends GET only, to one origin
fixed at construction (`https://api.github.com` by default), and refuses anything that is not an API
path; never follows a redirect, times out every request (8 s) and refuses bodies over 5 MB;
attaches the credential and never repeats it in an error; and retries nothing: what to do after a
refusal is your policy. Bring your own `GitHubTransport` (a `gh`-CLI runner, a test fake, a cache)
by implementing `get`.

### Evidence reads

`createGitHubEvidence({ transport, repository, limits? })`:

| Method | Returns | Refuses |
|---|---|---|
| `getIssue(n)` | `IssueEvidence` | `not-found`, `malformed-response` |
| `listIssues({ state })` | issues only, oldest first | `incomplete` beyond `maxPages × perPage` |
| `getPullRequest(n, { expectedHeadSha? })` | `PullRequestEvidence` with base and head SHAs | `stale` when the head is not `expectedHeadSha` |
| `listPullRequestFiles(n, headSha)` | files of exactly that head | `stale` if the head differs before or after the read; `incomplete` |
| `listReviews(n, { commitSha? })` | reviews, optionally of one commit | `incomplete` |
| `getChecks(sha, required)` | every check run on exactly `sha`; `ok` when each required name has a successful run | `incomplete`, `malformed-response` for a run of another commit |
| `listIssueComments(n, { since? })` | every comment of an issue or pull request, oldest first | `incomplete` beyond `maxPages × perPage` |
| `listPullRequests({ state?, base? })` | pull request summaries, newest first (`state` default `open`) | `incomplete`; `invalid-input` for an unsafe `base` ref name |
| `getFileAtCommit(commitSha, path, { maxBytes? })` | `{ commitSha, path, blobSha, size, kind, text? }`; `kind` is `text`, `binary` (NUL or not UTF-8) or `too-large` (over `maxBytes`, default 262 144) | `invalid-input` unless `commitSha` is a 40-hex SHA and `path` is a plain relative path (1 to 1024 chars), checked before any request; `wrong-target` for a directory, symlink, submodule or an answer for another path |

`ok` is false when `required` is empty: no requirement proves nothing. Incompleteness is never
silent: a listing that does not fit in `maxPages` pages throws `incomplete`; there is no partial
result. Titles, bodies and file text are bounded `UntrustedText` (`maxTextChars`, `truncated`); raw
base64 is never returned. A field GitHub did not send is `null` (or `""` for `authorAssociation`).
App attribution says which App made a request, never that anyone approved anything.

**Page windows and exact reads**, for callers with their own paging or byte-exact needs:

| Method | Returns |
|---|---|
| `listIssuesPage({ state?, labels?, sort?, direction?, page?, perPage? })` | one page as GitHub windowed it: `{ items, page, perPage, hasMore, excludedPullRequests }` |
| `listPullRequestsPage({ state?, sort?, direction?, page?, perPage? })` | `{ items, page, perPage, hasMore }` |
| `listIssueCommentsPage`, `listIssueEventsPage`, `listReviewsPage`, `listReviewCommentsPage` | one page of comments, events, reviews or inline review comments |
| `getIssueComment(id)` | the comment plus the `issueNumber` it belongs to; `wrong-target` when its issue is not in this repository |
| `getFileBytesAtCommit(commitSha, path, { maxBytes? })` | `{ kind: "bytes", bytes }` exactly as stored (never decoded, so a hash over them is the file's hash), or `kind: "too-large"` |
| `pullRequestContainsCommit(n, sha, { maxCommits? })` | `{ belongs, isHead }`; a commit beyond `maxCommits` (default 250) is reported as not belonging |

A page window is one page, not the listing: `hasMore` is GitHub's page being full, and an absent
item is no evidence of absence.

### Advisory reviews and specifications

`listAdvisoryReviews(github, protocol, { number, headSha }, { trustedAuthors })` and
`latestAdvisoryReview(...)` read a pull request's conversation comments and keep those carrying the
`ReviewProtocol`'s marker. Each result has `commentUrl`, `updatedAt`, `markerPrNumber`, `integrity`
(`verified`, `mismatch` or `unreadable`, decided by `@comforge/core`), `provenance`
(`reviewProvenance` against `trustedAuthors`), `stale` (`isReviewStale` against the head you pass),
the verdict, digest and ticket, and the decoded `review` payload only when `integrity` is
`verified`. A marker copied from another pull request, an altered payload or a body cut by the text
limit never yields a payload. These are ordinary pull request comments with a hidden, unkeyed
marker: not native GitHub reviews (`listReviews`), no approval state, and no proof of who wrote them.
Act only on `verified` + `trusted_author` + `stale === false`, and even then a review is evidence,
never an authorization.

With a `SpecificationProtocol` from `@comforge/core`, `readSpecificationIssue(github, protocol, n)`
returns the issue, the marker, the delimited specification text and `verified`; a pull request is
`wrong-target` and a body cut by the text limit is `incomplete`. `reconcileSpecification(github,
protocol, { ticketId, digest, keyDigest })` reads every issue and answers `absent`, `existing` or
`replayed`; a key or ticket already used for other content is a `conflict`. Call it before
publishing so a retry never duplicates an issue. `@comforge/core` has no authorization that covers
creating an issue; if you publish with this package's writer, the authority is your own `authorize`
policy.

### Caller-authorized writes

`createGitHubWriter` is separate from everything above: the read transport and evidence objects
have no write method and never gain one.

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

Each operation needs exactly one capability; none implies another, and none is inferred from what
the token permits.

| `kind` | Capability | GitHub request | Checked before the write |
|---|---|---|---|
| `issue.create` | `issues:create` | `POST /repos/{o}/{r}/issues` | none |
| `issue.comment` | `issues:comment` | `POST …/issues/{n}/comments` | the thread is an issue (or `thread: "pull-request"`), open, not locked |
| `pull.review` | `pulls:review` (COMMENT), `pulls:review:approve`, `pulls:review:request-changes` | `POST …/pulls/{n}/reviews` with `commit_id` | open, head is exactly `expectedHeadSha` |
| `pull.create` | `pulls:create` | `POST …/pulls` (same-repository head, `maintainer_can_modify: false`) | head (and optionally base) branch at the expected commit; no open PR for head and base |
| `pull.update` | `pulls:update` | `PATCH …/pulls/{n}` with `body` only | open, not merged; body digest (required), and optionally head SHA and `updatedAt`, unchanged |
| `issue.update` | `issues:update` | `PATCH …/issues/{n}` | `updatedAt`, and optionally body digest and state, unchanged |
| `comment.update` | `issues:comment:update` | `PATCH …/issues/comments/{id}` | on the expected issue; `updatedAt`, optionally body digest and author, unchanged |

Not supported, by design: changing a pull request's title, state, base or draft status, merging,
tags and releases, workflow dispatch, deletion, inline review comments, pending reviews and
cross-repository pull requests.

**Authorization is yours and is bound to bytes.** `prepare(op)` returns the frozen
`OperationDescriptor` (repository, target, capability, exact JSON payload, preconditions, and a
`sha256:` digest of all of them) without sending anything. `execute(op)` builds the same descriptor
and calls `authorize(descriptor)`. The decision must be `{ allow: true, descriptorDigest, expiresAt }`,
with the digest of exactly this descriptor and an expiry no more than 15 minutes ahead
(`limits.maxAuthorizationTtlMs`). Anything else, including a thrown error, is `authorization-denied`
and nothing is sent; the expiry is checked again just before sending. The request body is derived
from the descriptor only, so changing your input object after authorization changes nothing. A
callback that returns `allow` is your policy, not evidence that a person approved anything.

**The ledger is what makes retries safe.** GitHub offers no idempotency key and no compare-and-swap
for these endpoints, so the writer records every operation in your `OperationLedger` before
sending: `reserved`, `sending`, then `succeeded`, `failed`, `indeterminate` or `abandoned`. It
relies on two atomic primitives, insert-if-absent (`create`) and replace-if-version (`replace`), so
two processes sharing the store cannot both send one operation; a process-local map gives that only
within one process. See [persistence and reconciliation](../concepts/persistence-and-reconciliation.md).

- The same `operationId` with the same content replays the recorded outcome without a request; with
  other content it is a `conflict`.
- Created bodies end with a correlation marker (`<!-- comforge-op v1 ns=… op=… fp=… -->`, digests
  only). A write whose answer is lost (timeout, network, 5xx, 408, unreadable 2xx) is searched for
  once by that marker, within `limits.reconcileMaxPages`. Found: the outcome is `recovered`. Not
  found: `indeterminate`, never resent automatically. Only markers by `expectedAuthor` count, since
  anyone with write access can copy one.
- `reconcile(operationId)` searches again; `abandon(operationId, reason)` ends the operation by your
  decision. A retry after a rate limit waits for `retry-after` and searches before its one resend.
- Updates carry no marker: reconciliation compares the target with the requested change.

**Expected-state checks are not compare-and-swap.** `issue.update`, `comment.update` and
`pull.update` read the target, compare it with `expected`, then write. GitHub has no conditional
write for these endpoints, so an edit by someone else between that read and the write is
overwritten, and the outcome is still `verified`: it describes your write, not what it replaced.
The check narrows the window to one round trip; it does not prevent lost updates (an edit within
the same second as `updatedAt` is not even detected: pass `bodyDigest`, from `bodyDigest(body)`, to
narrow that). Nothing here is exactly-once: a write can still be duplicated if it becomes visible
only after you abandon it.

**Outcomes.** `verified`: a fresh read shows exactly what was authorized. `accepted`: the resource
exists but differs or could not be re-read (`mismatches`, for example labels GitHub silently dropped
for a caller without push access, or a branch that moved during a pull-request create).
`indeterminate`: unknown; reconcile. Refusals throw a `GitHubAdapterError` and mean nothing was
written.

**The verified response.** When this call read the resource back and every authorized field matched
(`verification: "matched"`, after a fresh write or a recovery), the outcome carries
`response: { source: "verification-read", body }`, the resource exactly as that read returned it.
Use it instead of a second GET. A read of a different resource is a mismatch, so it is never handed
back. It is absent on a replay (the ledger keeps no response body), on `accepted` and on
`indeterminate`: GET the resource yourself there. It is bounded by `maxBodyBytes` but otherwise
untrusted JSON, so validate it with your own schema. Requests for a fresh, verified write: issue
create 2 (write, read-back); issue or pull request comment 3 (thread check, write, read-back);
review 4 (adds the pull request read that reports `headMovedDuringPublication`); pull request
create 4 to 5; pull request body edit 3.

**Source compatibility.** `pull.update` in `WriteOperation` and `WriteKind`, and `pulls:update` in
`WRITE_CAPABILITIES`, are additions to public unions. Code compiled against an earlier release
still runs, but a TypeScript `switch` that exhaustively covers `WriteKind` or `WriteCapability`
(with a `never` check) needs a `pull.update` / `pulls:update` case before it compiles again.

**Permissions** (fine-grained token or GitHub App installation token; the writer cannot verify a
token's permissions and does not try): Issues write for issue writes and issue comments; Pull
requests write for reviews, pull requests and comments on pull requests; plus read access to
issues, pull requests and contents (branch refs) for the checks.

### Errors

Every refusal is a `GitHubAdapterError` with a `code`: `invalid-input`, `unapproved-origin`,
`not-found`, `unauthorized` (401), `forbidden` (403), `rate-limited` (429, or 403 with
`retry-after` or an exhausted rate limit; `detail.retryAfterSeconds` when GitHub said),
`http-error`, `timeout`, `network`, `too-large`, `malformed-response`, `incomplete`, `stale`,
`wrong-target`, `conflict`; and from the writer, refused before anything was sent:
`capability-denied`, `authorization-denied`, `ledger-failure`.
