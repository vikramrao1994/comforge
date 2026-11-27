# @comforge/mcp

`comforge-mcp` serves the governed agent lifecycle of [`@comforge/cli`](https://www.npmjs.com/package/@comforge/cli)
over the [Model Context Protocol](https://modelcontextprotocol.io). It calls the CLI's published
lifecycle services and `@comforge/github`'s reads in process. It never shells out to `comforge`,
parses its output, or keeps a second copy of its governance, state or authorization.

This README describes the source in this repository. Capabilities marked "candidate" depend on
unreleased candidates of `@comforge/core`, `@comforge/github` and `@comforge/cli`, and on this
package's own unreleased changes; `package.json` still says 0.1.0 until the version PR.

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
| `comforge_prs` (candidate) | all | a page of the repository's pull requests (`state` open, closed or all) |
| `comforge_comments` (candidate) | all | a page of an issue's or pull request's comments; text is untrusted |
| `comforge_reviews` (candidate) | all | a pull request's advisory reviews, with integrity and provenance |
| `comforge_artifact` (candidate) | all | one file at an exact commit, only under the repository's trusted `artifacts.readable` paths |
| `comforge_start` | executor | verifies the specification, creates the isolated checkout |
| `comforge_revise` | executor | reuses or re-creates a pull request's checkout and syncs it |
| `comforge_verify` | executor | trusted validation of an exact commit in a clean snapshot |
| `comforge_deliver` | publisher | push, one pull request, one completion record, read back; `execute:false` plans |
| `comforge_recover` | publisher | settles uncertain writes from GitHub; `execute:false` reports |
| `comforge_cleanup` | publisher | plans a cleanup; executing needs operator mode or a cleanup-scoped command grant (candidate; below) |
| `comforge_publish_review` (candidate) | reviewer | publishes one advisory review comment bound to the reviewed head; `execute:false` plans |
| `comforge_publish_specification` (candidate) | publisher | publishes a specification issue (idempotent, read back); `execute:false` plans |

The candidate contracts total 18 tools. Advisory reviews are marked comments, never native
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
- **Cleanup needs its own authority (candidate).** `comforge_cleanup` with `execute:true` runs
  under operator mode, or under an owner grant that scopes the command to cleanup of the merged
  pull request (`authorizeCommand` in [`@comforge/core`](https://www.npmjs.com/package/@comforge/core)). A grant signed
  to publish is never valid for cleanup. With the published `@comforge/core` 0.1.x grant format,
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
- **Remote publication is not remote execution (candidate).** The reads, `comforge_publish_review`
  and `comforge_publish_specification` run no repository command, so over HTTP they are available
  without an `IsolationProvider`. They still need the principal's profile and the repository's
  trusted authorization. Only the executing tools need the provider.
- **Host policy (candidate).** `HostServices.hostPolicy(binding)` hands the CLI's `HostPolicy`
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
- `textContent: "summary"` (candidate; `--summary-text`; default `"full"`) makes each result's text
  content one summary line and leaves `structuredContent` unchanged. Measured: a model that is
  given `structuredContent` reads the same tokens; the wire shrinks to about the structured size.
  A client that reads only text sees just the summary line, so it is opt-in.

Measurements are per-call tokenizer counts on one repository. Equivalent initiative state still costs more through MCP
than through the CLI (4,224 vs 3,701 tokens for every initiative's status); for the new reads MCP
is the smallest equivalent form (pull requests 1,191 vs CLI 1,617 vs raw GitHub 2,587). Discovery
is the largest fixed cost of an MCP session. These are per-call counts; no end-to-end saving is
claimed.

## Repositories without a checkout (candidate)

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

## Signed command scope (candidate)

`@comforge/core` adds an optional signed `commands` list to a grant, and `@comforge/cli` checks it:
- a grant **without** the field keeps its meaning for publish, complete, deliver and recover;
- such a grant is **never** valid for cleanup;
- a grant **with** the field is valid only for the commands it lists.

`comforge_cleanup` executes under operator mode or such a scoped grant, once these candidates are
released and pinned. The grant format is documented in the
[`@comforge/core` README](https://www.npmjs.com/package/@comforge/core).

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
- **Advisory reviews need the candidates.** Advisory reviews (marked comments) are not readable
  through the published `@comforge/github`; with it, `comforge_pr` returns native GitHub reviews
  only and says so. `comforge_reviews` and `comforge_publish_review` need the `@comforge/github`
  and `@comforge/cli` candidates and the repository's `review` configuration section.
- **Limits are per process.** Rate and session limits live in one process, so run one instance
  per limit domain.
