# @comforge/mcp

`comforge-mcp` serves the governed agent lifecycle of [`@comforge/cli`](https://www.npmjs.com/package/@comforge/cli)
over the [Model Context Protocol](https://modelcontextprotocol.io). It calls the CLI's published
lifecycle services and `@comforge/github`'s reads in process. It never shells out to `comforge`,
parses its output, or keeps a second copy of its governance, state or authorization.

This README describes the source in this repository, which `package.json` versions as 0.2.0
(Node >= 22.18 or Bun >= 1.4, and git). Anything marked "unreleased" is in the source but not in
a published release; the CHANGELOG's "Unreleased" entry lists it.

It never merges, deploys, approves, requests a review, closes an issue or runs an arbitrary command.

## Tools

| Tool | Profile | What it does |
|---|---|---|
| `comforge_capabilities` | all | profiles, repository ids, tools, execution availability, what the server never does |
| `comforge_context` | all | routes a task through the repository's context manifest |
| `comforge_status` | all | initiatives, summary first and paginated, or one initiative with counts |
| `comforge_evidence` | all | one section of an initiative's record (validations, publications, completions, revisions, operations), newest first |
| `comforge_issue` | all | an issue and whether its specification still verifies, or (without `number`) a page of issues; text is untrusted |
| `comforge_pr` | all | a pull request, optionally its checks, changed files and native GitHub reviews |
| `comforge_prs` | all | a page of the repository's pull requests (`state` open, closed or all) |
| `comforge_comments` | all | a page of an issue's or pull request's comments; text is untrusted |
| `comforge_reviews` | all | a pull request's advisory reviews, with integrity and provenance |
| `comforge_artifact` | all | one file at an exact commit, only under the repository's trusted `artifacts.readable` paths |
| `comforge_start` | executor | verifies the specification, creates the isolated checkout |
| `comforge_revise` | executor | reuses or re-creates a pull request's checkout and syncs it |
| `comforge_verify` | executor | trusted validation of an exact commit in a clean snapshot |
| `comforge_deliver` | publisher | push, one pull request, one completion record, read back; `execute:false` plans |
| `comforge_recover` | publisher | settles uncertain writes from GitHub; `execute:false` reports |
| `comforge_cleanup` | publisher | plans a cleanup; executing needs operator mode or a cleanup-scoped command grant (see Signed command scope) |
| `comforge_publish_review` | reviewer | publishes one advisory review comment bound to the reviewed head; `execute:false` plans |
| `comforge_publish_specification` | publisher | publishes a specification issue (idempotent, read back); `execute:false` plans |

There are 18 tools. Advisory reviews are marked comments, never native
reviews or approvals.
The four profiles are `read-only`, `reviewer` (adds patches and full review bodies to reads),
`executor` and `publisher`. A principal can hold several. A principal discovers only the tools its
profiles permit, and every call checks the profile again.

## Contracts

Every input object is strict and versioned. An unknown field is refused before a handler runs,
and so is a forged internal option such as `authorized`, a path, a URL or a credential. A
repository is named by its allowlisted id.

```text
success  {schema:"comforge-mcp/v1", tool, ok:true, exit, summary, data, page?}
refusal  {schema:"comforge-mcp-error/v1", code, message, exit, retryable, hint?, detail?}
```

`exit` is the CLI's exit class: 0 ok, 1 refused, 2 usage or configuration, 3 failed, 4 incomplete.
Results are bounded: about 48,000 characters each, and untrusted text is excerpted unless a
reviewer asks for detail. Longer lists are paginated with `cursor` and `pageSize`. Credentials
and secret-like text are redacted. Over HTTP, host paths are replaced by `<host>`.

## Security model

- **Credentials are server-owned.** The host provides them per repository and principal, or they
  come from the repository's trusted `security.credentials` source. They are never returned.
- **Authorization stays in `@comforge/cli`.** Writes need the repository's trusted
  `security.authorization`: owner grants or operator mode. A caller passes an owner-signed grant
  envelope in `grant`, and the CLI verifies it against the trusted keys, ticket, specification,
  head and branch. The server cannot authorize anything itself.
- **Cleanup needs its own authority.** `comforge_cleanup` with `execute:true` runs
  under operator mode, or under an owner grant that scopes the command to cleanup of the merged
  pull request (`authorizeCommand` in [`@comforge/core`](https://www.npmjs.com/package/@comforge/core)). A grant signed
  to publish is never valid for cleanup. With an `@comforge/core` 0.1.x grant format,
  which cannot name a command, `execute:true` is refused with `command-scope-unsupported`; run
  cleanup through the `comforge` CLI.
- **Repository isolation.** Each principal has an allowlist. An unknown or foreign id gets the same
  refusal, and the trusted configuration must name the bound GitHub repository.
- **Local stdio.** The trust boundary is the local user. The operator picks the repositories and
  profiles at launch, and there is no authentication. Repository commands run in the server's
  process environment, as `comforge` would.
- **Streamable HTTP.** The host mounts `createHttpHandler(options)` and authenticates each request,
  returning a principal or `null`. Before any MCP message is parsed, the handler checks:
  1. the `Host` allowlist;
  2. the `Origin` allowlist;
  3. the method;
  4. the body size;
  5. authentication, with a `WWW-Authenticate` challenge on 401;
  6. the per-principal rate and concurrency limits.

  Sessions are created by `initialize`, bound to their principal and expire when idle. Any other
  principal presenting the session id is refused.
- **Remote execution is off by default.** Over HTTP, the tools that run repository commands
  (start, revise, verify, deliver, recover, cleanup) are neither listed nor callable unless the
  host passes an `IsolationProvider`. That is the host's attestation that its runtime runs every
  command inside an isolation boundary it operates. A flag cannot stand in for it. This package
  implements no sandbox and claims none.
- **Remote publication is not remote execution.** The reads, `comforge_publish_review`
  and `comforge_publish_specification` run no repository command, so over HTTP they are available
  without an `IsolationProvider`. They still need the principal's profile and the repository's
  trusted authorization. Only the executing tools need the provider.
- **Host policy.** `HostServices.hostPolicy(binding)` hands the CLI's `HostPolicy`
  (checkout parent, worker preparation and removal, validation) to the lifecycle for one
  repository. It is host code; no tool input reaches it.
- **Cancellation.** It is checked between the CLI's stages, never in the middle of a write. An
  interrupted delivery is recorded and settled by `comforge_recover`.

## Deploying the HTTP handler

- **Terminate TLS in front of it.** The handler checks the `Host` header against `allowedHosts`
  and the `Origin` header against `allowedOrigins`. It never reads `X-Forwarded-*`. A reverse
  proxy must forward the original `Host`, and the host's `authenticate` must not trust
  client-supplied identity headers that the proxy does not set.
- **Each request is authenticated,** including session reuse, the SSE `GET` and `DELETE`.
  - A session belongs to the principal that initialized it.
  - A different principal is refused.
  - If the same principal comes back with other profiles or repositories, the session ends,
    and the client starts a new one. A revoked principal gets 401 at once.
  - An authenticator that throws is treated as no principal.
- **Limits are per process.** Rate, concurrency and session limits and the session table live in
  one process, so a multi-instance deployment needs sticky sessions and limits enforced in front.
- **Repository commands are synchronous.** They block the process for their duration (see
  Limits). Remote execution belongs on host-operated workers that the `IsolationProvider`
  stands for.
- `compactDiscovery: true` (or `--compact-discovery`) leaves the output schemas out of
  `tools/list`. Measured: 39-45% fewer discovery tokens (17 tools: 11,019 to 6,759). The results
  keep the same versioned envelope.
- `textContent: "summary"` (`--summary-text`; default `"full"`) makes each result's text
  content one summary line and leaves `structuredContent` unchanged. Measured: a model that is
  given `structuredContent` reads the same tokens; the wire shrinks to about the structured size.
  A client that reads only text sees just the summary line, so it is opt-in.

Measurements are per-call tokenizer counts on one repository. Equivalent initiative state still costs more through MCP
than through the CLI (4,224 vs 3,701 tokens for every initiative's status); for the new reads MCP
is the smallest equivalent form (pull requests 1,191 vs CLI 1,617 vs raw GitHub 2,587). Discovery
is the largest fixed cost of an MCP session. These are per-call counts; no end-to-end saving is
claimed.

## Repositories without a checkout

A host that has no checkout (a web app that answers MCP over HTTP) can still serve the GitHub
evidence reads. `createComforgeMcpServer` accepts `remoteRepositories` and `remote` since 0.2.0;
**unreleased:** `createHttpHandler` forwards them too. The reads are: `comforge_capabilities`, `comforge_issue`, `comforge_pr`, `comforge_prs`,
`comforge_comments`, `comforge_reviews` and `comforge_artifact` (`REMOTE_READ_TOOLS`).

```ts
createHttpHandler({
  repositories: [],
  remoteRepositories: [{ id: "widgets", owner: "acme", name: "widgets", configSha256: "<optional pin>" }],
  remote: {
    trustedConfig: async (b) => ({ revision, text, observedAt }), // host code: the base head and its comforge.config.json
    credentials: (b, principal) => serverOwnedToken,
    configMaxAgeMs: 600_000,
  },
  host: { runtime: () => { throw new Error("no runtime"); } },
  // authenticate, allowedHosts, ... as above
});
```

- The host supplies the trusted configuration; a caller never can. The server refuses a
  snapshot whose revision is not a full SHA (`config-invalid`), that is older than
  `configMaxAgeMs` or from the future (`config-stale`, retryable), that differs from the pin or
  from GitHub's bytes at that revision read with the server's credential (`config-mismatch`), or
  that names another repository (`repository-mismatch`). A source that throws is `config-missing`.
- Whether the revision is the base branch head is the host's statement; the server verifies the
  bytes at that revision, not branch membership.
- Every other tool is refused for such a repository with `checkout-required`, with or without an
  `IsolationProvider`: loading a configuration never enables execution or writes. A server with
  only checkout-free repositories does not list those tools at all.

Over HTTP the handler keeps every check above for these repositories: authentication (401 and
the challenge), the `Host` and `Origin` allowlists, profile checks on every call, per-principal
sessions (a changed principal ends the session) and a refusal of executing tools. Constructing the
handler with `remoteRepositories` and no `remote` throws.

## Host services

`@comforge/mcp/host` is for an application that serves its own tools, sessions and storage and
needs the same engineering services in its own process, without a subprocess or a loopback HTTP
call. The MCP server of this package uses the same services for its evidence reads.

```ts
import { createEngineeringHost, sqliteOperationStore } from "@comforge/mcp/host";

const host = createEngineeringHost({
  repository: { owner: "acme", name: "widgets" },
  transport: myReadTransport, // { get(path, query) }: your client, credential and limits
});
await host.evidence.getPullRequest(42);                 // exact-commit, complete-or-refuse reads
await host.advisoryReviews(reviewProtocol, { number: 42, headSha }, { trustedAuthors });
await host.trustedConfig({ branch: "main" });           // bytes at one immutable revision
```

| You inject | The services never take it from a caller |
|---|---|
| `repository` | one `owner/name`; every request stays inside it |
| `transport` | the read path: credential, limits, error mapping |
| `writes` (optional) | `token`, `capabilities`, `authorize(descriptor)`, `operations` store, `clock` |

There are two profiles. Without `writes` the host is `read-only`: `writes.prepare`, `execute`,
`reconcile` and `abandon` refuse with `capability-denied` before a request exists. This is the
profile of a checkout-free network host. With `writes` the host is `governed-writes`, for an
embedded trusted host: each write is sent once per operation id, only within `capabilities`, only
after your `authorize` allows that exact descriptor, and an uncertain write is settled by
`reconcile` against GitHub, never sent again. Your application keeps OAuth, principals, sessions,
admission and the decision to write at all. The services add no tool, no remote execution and no
lifecycle write.

`sqliteOperationStore({ database, repository, table?, repositoryColumn?, kindAndStateColumns? })`
is the durable operation store over your own SQLite handle (`prepare(sql)`): insert-if-absent,
version-checked replace, a finished record stored with a digest in place of its body, and a
malformed, foreign or state-inconsistent record refused. It adopts an existing table as it is;
`inspect()` and `compact({ before, limit })` are the only retention operations and never remove
an identity. Every refusal is a `HostServiceError` with a stable `code`.

## Signed command scope

`@comforge/core` adds an optional signed `commands` list to a grant, and `@comforge/cli` checks it:
- a grant **without** the field keeps its meaning for publish, complete, deliver and recover;
- such a grant is **never** valid for cleanup;
- a grant **with** the field is valid only for the commands it lists.

`comforge_cleanup` executes under operator mode or such a scoped grant. The grant format is documented in the
[`@comforge/core` README](https://www.npmjs.com/package/@comforge/core).

## Quick start

Install one interface and pin it exactly: `npm install --save-exact @comforge/mcp@0.2.0`. It
brings `@comforge/cli`, `@comforge/core`, `@comforge/github` and `@comforge/ledger`; do not install
them separately for this. Use either `npx comforge-mcp` (stdio, below) or embed `createHttpHandler`, not both.
You need a repository whose base branch carries `comforge.config.json`, a GitHub credential from
your host or the repository's `security.credentials` source (never a tool input) and, for any
write, the trusted `security.authorization` (an owner grant envelope or operator mode).

Measured on one machine (the source repository's onboarding evidence): the MCP example installed in 0.8 s and ran its first verified
workflow in 0.8 s on Node and 0.5 s on Bun; the CLI example installed in 1.5 s and ran in 2.6 s
on Node and 1.2 s on Bun. Human setup time (configuration, grants, credentials) was not measured.

## Run locally

```sh
npx comforge-mcp --repository . --profile executor --profile publisher
```

Repository ids are the configured repository names. The default profile is `read-only`.

## Embed

```ts
import { createHttpHandler } from "@comforge/mcp";

const handler = createHttpHandler({
  repositories: [{ id: "widgets", root: "/srv/widgets", owner: "acme", name: "widgets" }],
  host: { runtime: (b) => myRuntime(b.root), credentials: (b, p) => () => tokenFor(b, p) },
  authenticate: async (req) => principalFromBearer(req), // { id, profiles, repositories } | null
  allowedHosts: ["mcp.acme.example"],
  allowedOrigins: ["https://agents.acme.example"],
});
// Bun.serve({ fetch: (req) => handler.handle(req) }), or any web-standard Request/Response host.
```

`createComforgeMcpServer` gives you an `McpServer` for one principal, to use with any transport.
`serveStdio` connects that server to stdio.

## Limits

- **Repository commands block their process.** They run synchronously through the CLI's runtime,
  so a long validation holds the server for its duration. That is one more reason remote
  execution needs a host-operated worker.
- **Advisory reviews need configuration.** `comforge_reviews` and `comforge_publish_review` need
  the repository's trusted `review` configuration section; without it `comforge_pr` returns native
  GitHub reviews only and says so.
- **Recovery and concurrency.** Initiative state is a file ledger with compare-and-swap, so a
  concurrent writer on the same checkout is refused rather than merged. An interrupted delivery
  is settled by `comforge_recover`, which reads GitHub and never replays a write blindly.
- **Limits are per process.** Rate and session limits live in one process, so run one instance
  per limit domain.
