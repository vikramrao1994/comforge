# MCP reference — `@comforge/mcp`

Status: published (`@comforge/mcp` 0.3.0). The generated [tool inventory](inventory/mcp-tools.md)
is authoritative for tools, profiles, launch flags and the remote read set; the package
The [security model](#security-model) is below.

## Transports

| Transport | Entry | Trust boundary | Executing tools |
|---|---|---|---|
| stdio | `comforge-mcp` executable, or `serveStdio(options)` | the local user; no authentication | available (commands run as you) |
| Streamable HTTP | `createHttpHandler(options)` mounted by your server | your `authenticate(request)`; `Host`/`Origin` allowlists, body, rate and concurrency limits, sessions bound to their principal | listed and callable only with a host `IsolationProvider` |
| in process | `createComforgeMcpServer(options)` with your own transport | your code | as you wire it |

### `comforge-mcp` launch flags

| Flag | Effect |
|---|---|
| `--repository DIR` | serve this repository (repeatable); default: the current directory's |
| `--profile read-only\|reviewer\|executor\|publisher` | grant this profile (repeatable); default `read-only` |
| `--compact-discovery` | leave output schemas out of `tools/list` (smaller discovery; results unchanged) |
| `--summary-text` | each result's text content is one summary line; `structuredContent` unchanged |

The repository id a tool takes is the configured `repository.name`, lowercased.

## Profiles

| Profile | Adds |
|---|---|
| `read-only` | the ten reads: capabilities, context, status, evidence, issue, pr, prs, comments, reviews, artifact |
| `reviewer` | full review bodies and patches in reads; `comforge_publish_review` |
| `executor` | `comforge_start`, `comforge_revise`, `comforge_verify` |
| `publisher` | `comforge_deliver`, `comforge_recover`, `comforge_cleanup`, `comforge_publish_specification`, `comforge_publish_comment` |

A principal can hold several. It discovers only the tools its profiles permit, and every call
checks the profile again.

## Tools

| Tool | Profile | CLI equivalent | Writes |
|---|---|---|---|
| `comforge_capabilities` | all | `capabilities` | nothing |
| `comforge_context` | all | `context` | nothing |
| `comforge_status` | all | `status` | nothing |
| `comforge_evidence` | all | `status <ID>` (one section) | nothing |
| `comforge_issue` | all | — (issue and specification verification) | nothing |
| `comforge_pr` | all | — (one pull request, checks, files, native reviews) | nothing |
| `comforge_prs` | all | `prs` | nothing |
| `comforge_comments` | all | `comments` | nothing |
| `comforge_reviews` | all | `review list` | nothing |
| `comforge_artifact` | all | `artifact` | nothing |
| `comforge_start` | executor | `start` | checkout, state |
| `comforge_revise` | executor | `revise` | state |
| `comforge_verify` | executor | `verify` | state |
| `comforge_deliver` | publisher | `deliver` | push, pull request, comment (`execute: true`) |
| `comforge_recover` | publisher | `recover` | write ledger |
| `comforge_cleanup` | publisher | `cleanup` | checkout, state, branch |
| `comforge_publish_specification` | publisher | `spec publish` | one issue |
| `comforge_publish_review` | reviewer | `review publish` | one comment |
| `comforge_publish_comment` | publisher | — (library: `publishComment`) | one comment |

Write tools plan with `execute: false` and act with `execute: true`. An owner grant goes in
`grant`, as the signed envelope.

## Results

```text
success  {schema:"comforge-mcp/v1", tool, ok:true, exit, summary, data, page?}
refusal  {schema:"comforge-mcp-error/v1", code, message, exit, retryable, hint?, detail?}
```

Inputs are strict: an unknown field, a forged `authorized` flag, a path, a URL or a credential
is refused before a handler runs. Results are bounded (about 48,000 characters), paginated with
`cursor` and `pageSize`, redacted, and untrusted text (issue, comment and pull request text) is
excerpted unless a reviewer asks for detail. Error codes: [errors](errors.md).

## Programmatic entry points

| Export | Use |
|---|---|
| `createComforgeMcpServer(options)` | the MCP server over your repository bindings and host services |
| `serveStdio(options)` | stdio transport, as `comforge-mcp` uses |
| `createHttpHandler(options)` | Streamable HTTP handler (`authenticate`, `allowedHosts`, `allowedOrigins`, limits, optional `remoteRepositories` + `remote` for checkout-free reads) |
| `@comforge/mcp/host` `createEngineeringHost(options)` | the same engineering services for your own server ([recipe 7](../recipes/07-embedded-host-services.md)) |

Every runtime export: [API inventory](inventory/api.md#comforgemcp-040).

## Security model

- **Credentials are server-owned.** The host provides them per repository and principal, or they
  come from the repository's trusted `security.credentials` source. They are never returned.
- **Authorization stays in `@comforge/cli`.** Writes need the repository's trusted
  `security.authorization`: owner grants or operator mode. A caller passes an owner-signed grant
  envelope in `grant`, and the CLI verifies it against the trusted keys, ticket, specification,
  head and branch. The server cannot authorize anything itself.
- **Cleanup needs its own authority.** `comforge_cleanup` with `execute:true` runs under operator
  mode, or under an owner grant that scopes the command to cleanup of the merged pull request
  (`authorizeCommand` in `@comforge/core`). A grant signed to publish is never valid for cleanup.
  With a grant format that cannot name a command, `execute:true` is refused with
  `command-scope-unsupported`; run cleanup through the `comforge` CLI.
- **Repository isolation.** Each principal has an allowlist. An unknown or foreign id gets the same
  refusal, and the trusted configuration must name the bound GitHub repository.
- **Local stdio.** The trust boundary is the local user. The operator picks the repositories and
  profiles at launch, and there is no authentication. Repository commands run in the server's
  process environment, as `comforge` would.
- **Streamable HTTP.** The host mounts `createHttpHandler(options)` and authenticates each request,
  returning a principal or `null`. Before any MCP message is parsed, the handler checks the `Host`
  allowlist, the `Origin` allowlist, the method, the body size, authentication (with a
  `WWW-Authenticate` challenge on 401) and the per-principal rate and concurrency limits. Sessions
  are created by `initialize`, bound to their principal and expire when idle. Any other principal
  presenting the session id is refused.
- **Remote execution is off by default.** Over HTTP, the tools that run repository commands
  (start, revise, verify, deliver, recover, cleanup) are neither listed nor callable unless the host
  passes an `IsolationProvider`. That is the host's attestation that its runtime runs every command
  inside an isolation boundary it operates. A flag cannot stand in for it. This package implements
  no sandbox and claims none.
- **Remote publication is not remote execution.** The reads, `comforge_publish_review`,
  `comforge_publish_specification` and `comforge_publish_comment` run no repository command, so
  over HTTP they are available without an `IsolationProvider`. They still need the principal's
  profile and the repository's trusted authorization.
- **Discussion comments.** `comforge_publish_comment` comments on an open issue that verifies as
  a published specification, never on another issue or a pull request. It needs the trusted
  `discussion` section and `issues:comment`; one key publishes one comment (same key and text:
  replayed; same key, other text: `conflict`). Evidence only. Owner-grant repositories refuse it:
  no grant can be scoped to a comment.
- **Checkout-free publication (unreleased).** For a `remoteRepositories` binding, the three
  publication tools exist only when `remote.governance(binding, principal)` returns governance:
  a per-command write credential, a durable operation store and the host's `authorize`. The
  repository must be in `operator` mode; the result records `{mode: "host", authority,
  principal}`. Without governance the binding stays read-only (`checkout-required`).
- **Composition (unreleased).** `registerComforgeTools(server, options)` registers the same tools
  onto an existing `McpServer`; a name the server already holds is refused before anything is
  registered.
- **Host policy.** `HostServices.hostPolicy(binding)` hands the CLI's `HostPolicy` (checkout
  parent, worker preparation and removal, validation) to the lifecycle for one repository. It is
  host code; no tool input reaches it.
- **Cancellation** is checked between the CLI's stages, never in the middle of a write. An
  interrupted delivery is recorded and settled by `comforge_recover`.

## Deploying the HTTP handler

- **Terminate TLS in front of it.** The handler checks the `Host` header against `allowedHosts` and
  the `Origin` header against `allowedOrigins`. It never reads `X-Forwarded-*`. A reverse proxy must
  forward the original `Host`, and the host's `authenticate` must not trust client-supplied identity
  headers that the proxy does not set.
- **Each request is authenticated,** including session reuse, the SSE `GET` and `DELETE`. A session
  belongs to the principal that initialized it; a different principal is refused. If the same
  principal comes back with other profiles or repositories, the session ends and the client starts a
  new one. A revoked principal gets 401 at once. An authenticator that throws is treated as no
  principal.
- **Limits are per process.** Rate, concurrency and session limits and the session table live in
  one process, so a multi-instance deployment needs sticky sessions and limits enforced in front
  (or one instance per limit domain).
- **Repository commands are synchronous.** They run through the CLI's runtime and block the process
  for their duration, so a long validation holds the server. Remote execution belongs on
  host-operated workers that the `IsolationProvider` stands for.
- `compactDiscovery: true` (or `--compact-discovery`) leaves the output schemas out of
  `tools/list`. Measured: 39-45% fewer discovery tokens (17 tools: 11,019 to 6,759). The results
  keep the same versioned envelope.
- `textContent: "summary"` (`--summary-text`; default `"full"`) makes each result's text content
  one summary line and leaves `structuredContent` unchanged. A model that is given
  `structuredContent` reads the same tokens; the wire shrinks to about the structured size. A client
  that reads only text sees just the summary line, so it is opt-in.

Measurements are per-call tokenizer counts on one repository. Equivalent initiative state still
costs more through MCP than through the CLI (4,224 vs 3,701 tokens for every initiative's status);
for the new reads MCP is the smallest equivalent form (pull requests 1,191 vs CLI 1,617 vs raw
GitHub 2,587). Discovery is the largest fixed cost of an MCP session. No end-to-end saving is
claimed.

## Repositories without a checkout

A host that has no checkout (a web app that answers MCP over HTTP) can still serve the GitHub
evidence reads: `comforge_capabilities`, `comforge_issue`, `comforge_pr`, `comforge_prs`,
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
  // authenticate, allowedHosts, ... as for any handler
});
```

- The host supplies the trusted configuration; a caller never can. The server refuses a snapshot
  whose revision is not a full SHA (`config-invalid`), that is older than `configMaxAgeMs` or from
  the future (`config-stale`, retryable), that differs from the pin or from GitHub's bytes at that
  revision read with the server's credential (`config-mismatch`), or that names another repository
  (`repository-mismatch`). A source that throws is `config-missing`.
- Whether the revision is the base branch head is the host's statement; the server verifies the
  bytes at that revision, not branch membership.
- Every other tool is refused for such a repository with `checkout-required`, with or without an
  `IsolationProvider`: loading a configuration never enables execution or writes. A server with only
  checkout-free repositories does not list those tools at all.
- The handler keeps every check above for these repositories: authentication, the `Host` and
  `Origin` allowlists, profile checks on every call and per-principal sessions. Constructing the
  handler with `remoteRepositories` and no `remote` throws.

## Host services (`@comforge/mcp/host`)

`createEngineeringHost` is for an application that serves its own tools, sessions and storage and
needs the same engineering services in its own process, without a subprocess or a loopback HTTP
call. The MCP server of this package uses the same services for its evidence reads.

```ts
import { createEngineeringHost } from "@comforge/mcp/host";

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
`inspect()` and `compact({ before, limit })` are the only retention operations and never remove an
identity. Every refusal is a `HostServiceError` with a stable `code`.

## Signed command scope

A grant may carry an optional signed `commands` list (the command scope of `@comforge/core`),
which `@comforge/cli` checks. A grant without the field keeps its meaning for publish, complete,
deliver and recover, and is never valid for cleanup; a grant with the field is valid only for the
commands it lists. `comforge_cleanup` executes under operator mode or such a scoped grant.

## Starting a server

Install one interface and pin it exactly (`--save-exact`). It brings `@comforge/cli`,
`@comforge/core`, `@comforge/github` and `@comforge/ledger`; do not install them separately for
this. Use either `npx comforge-mcp` (stdio) or embed `createHttpHandler`, not both. You need a
repository whose base branch carries `comforge.config.json`, a GitHub credential from your host or
the repository's `security.credentials` source (never a tool input) and, for any write, the
trusted `security.authorization` (an owner grant envelope or operator mode).

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

`createComforgeMcpServer` gives you an `McpServer` for one principal, to use with any transport;
`serveStdio` connects that server to stdio.

## Limits

- **Advisory reviews need configuration.** `comforge_reviews` and `comforge_publish_review` need
  the repository's trusted `review` configuration section; without it `comforge_pr` returns native
  GitHub reviews only and says so.
- **Recovery and concurrency.** Initiative state is a file ledger with compare-and-swap, so a
  concurrent writer on the same checkout is refused rather than merged. An interrupted delivery is
  settled by `comforge_recover`, which reads GitHub and never replays a write blindly.
- Advisory reviews are marked comments, never native reviews or approvals. The server never merges,
  deploys, approves, requests a review, closes an issue or runs an arbitrary command.
