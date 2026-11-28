<p align="center">
  <a href="https://github.com/vikramrao1994/comforge">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://github.com/vikramrao1994/comforge/raw/main/docs/assets/brand/comforge-logo-dark.svg">
      <img alt="Comforge" src="https://github.com/vikramrao1994/comforge/raw/main/docs/assets/brand/comforge-logo-light.svg" height="40">
    </picture>
  </a>
</p>

# @comforge/mcp

Agent integration for the governed lifecycle: the `comforge-mcp` server exposes it over the [Model Context Protocol](https://modelcontextprotocol.io) on stdio or Streamable HTTP. It calls the lifecycle services of `@comforge/cli` in process, so governance, state and authorization are never duplicated, and it never merges, deploys, approves, requests a review, closes an issue or runs an arbitrary command.

[![npm](https://img.shields.io/npm/v/@comforge/mcp?label=npm&color=0b7285)](https://www.npmjs.com/package/@comforge/mcp)
[![CI](https://github.com/vikramrao1994/comforge/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/vikramrao1994/comforge/actions/workflows/ci.yml)
[![License](https://img.shields.io/npm/l/@comforge/mcp?color=0b7285)](https://github.com/vikramrao1994/comforge/blob/main/LICENSE)
[![Node](https://img.shields.io/node/v/@comforge/mcp?color=0b7285)](https://github.com/vikramrao1994/comforge/blob/main/docs/reference/compatibility.md)

## Install

```sh
npm install --save-exact @comforge/mcp      # or: bun add --exact @comforge/mcp
```

It brings `@comforge/cli`, `@comforge/core`, `@comforge/github` and `@comforge/ledger`; do not install them separately for this. You need a repository whose base branch carries `comforge.config.json` ([configuration](https://github.com/vikramrao1994/comforge/blob/main/docs/reference/configuration.md)).

## Quick example

Serve a repository to a local agent over stdio. The default profile is `read-only`; add profiles to expose more tools.

```sh
npx comforge-mcp --repository . --profile executor --profile publisher
```

Or mount the Streamable HTTP handler in your own server:

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

## What it provides

Tools are grouped into four profiles. A principal can hold several, discovers only the tools its profiles permit, and every call checks the profile again. Write tools plan with `execute: false` and act with `execute: true`.

| Profile | Tools |
|---|---|
| `read-only` | `comforge_capabilities`, `comforge_context`, `comforge_status`, `comforge_evidence`, `comforge_issue`, `comforge_pr`, `comforge_prs`, `comforge_comments`, `comforge_reviews`, `comforge_artifact` |
| `reviewer` | Adds patches and full review bodies to reads, and `comforge_publish_review` |
| `executor` | `comforge_start`, `comforge_revise`, `comforge_verify` |
| `publisher` | `comforge_deliver`, `comforge_recover`, `comforge_cleanup`, `comforge_publish_specification`, `comforge_publish_comment` |

Results are versioned and bounded (about 48,000 characters), paginated with `cursor` and `pageSize`, and redacted. Untrusted issue, comment and pull request text is excerpted. `--compact-discovery` leaves output schemas out of `tools/list`, and `--summary-text` reduces each result's text content to one line.

| Export | Subpath | Use |
|---|---|---|
| `createComforgeMcpServer` | `@comforge/mcp` | An `McpServer` over your repository bindings, for any transport |
| `serveStdio` | `@comforge/mcp` | The stdio transport the executable uses |
| `createHttpHandler` | `@comforge/mcp` | Streamable HTTP with authentication, `Host` and `Origin` allowlists, limits and per-principal sessions |
| `registerComforgeTools` | `@comforge/mcp` | The native tools on an application's existing `McpServer`, next to its own tools (unreleased) |
| `createEngineeringHost`, `sqliteOperationStore`, `fetchTransport` | `@comforge/mcp/host` | The same engineering services for an application's own server |

Composition: `registerComforgeTools(server, options)` registers exactly the tools `createComforgeMcpServer` would, with the same schemas and handlers, onto a server you already have. A name the server already holds is refused before anything is registered; comforge never renames a tool. Checkout-free repositories (`remoteRepositories`) serve evidence reads, and with `remote.governance` also `comforge_publish_specification`, `comforge_publish_review` and `comforge_publish_comment`, under the host's per-command write credential, durable operation store and authorization (operator-mode repositories only; owner-grant repositories need a checkout). A host can limit a repository's publications with `governance(...).commands`; a command outside it is refused as `operation-not-served`, and `comforge_capabilities` lists only those per repository.

Reads report GitHub's refusal of the server's own read credential as `credential-rejected` (401) or `credential-forbidden` (403), never as `unauthorized`, which is a write's authorization refusal. `comforge_pr` with `include: ["checks"]` returns an explicit aggregate over the head commit's check runs: `state` (`passing`, `failing`, `pending`, `neutral`, `none`), `ok` (`state === "passing"`), per-conclusion `counts`, and `required: {evaluated: false}`, because commit statuses and required checks are not read. A `passing` state is what the observed check runs say, never merge readiness: it does not mean branch protection, required checks or commit statuses are satisfied.

Credentials stay server-owned and are never returned. Writes are authorized by the repository's trusted configuration in `@comforge/cli` (an owner-signed grant or operator mode), never by the server or a tool input. Over HTTP, tools that run repository commands are neither listed nor callable unless the host supplies an `IsolationProvider`.

## Compatibility

- Node.js 22.18 or later, or Bun 1.4 or later; Git on `PATH`.
- macOS and Linux (the same platforms as `@comforge/cli`).
- Any MCP client that supports stdio or Streamable HTTP; integration notes exist for several agents (see Documentation).

Details: [compatibility](https://github.com/vikramrao1994/comforge/blob/main/docs/reference/compatibility.md).

## Limitations

- **No sandbox.** Repository commands run synchronously and block the server process; over HTTP, remote execution belongs on host-operated workers behind an `IsolationProvider`.
- **Per-process limits.** Rate, concurrency and session limits live in one process; a multi-instance deployment needs sticky sessions and limits enforced in front.
- **Advisory reviews are marked comments**, not native reviews or approvals, and need the repository's trusted `review` configuration section.
- Initiative state is a file ledger with compare-and-swap: a concurrent writer on the same checkout is refused, and an interrupted delivery is settled by `comforge_recover`.

See [security model, HTTP deployment and limits](https://github.com/vikramrao1994/comforge/blob/main/docs/reference/mcp.md#security-model).

## Documentation

- [Repository README](https://github.com/vikramrao1994/comforge#readme)
- [MCP reference](https://github.com/vikramrao1994/comforge/blob/main/docs/reference/mcp.md), [tool selection](https://github.com/vikramrao1994/comforge/blob/main/docs/reference/tool-selection.md), [errors](https://github.com/vikramrao1994/comforge/blob/main/docs/reference/errors.md)
- [Recipe: MCP for coding agents](https://github.com/vikramrao1994/comforge/blob/main/docs/recipes/02-mcp-for-coding-agents.md) and [embedded host services](https://github.com/vikramrao1994/comforge/blob/main/docs/recipes/07-embedded-host-services.md)
- [Agent integrations](https://github.com/vikramrao1994/comforge/tree/main/docs/integrations)
- [Architecture](https://github.com/vikramrao1994/comforge/blob/main/docs/concepts/architecture.md)
- [Runnable example](https://github.com/vikramrao1994/comforge/tree/main/examples/mcp-consumer)
- [Changelog](https://github.com/vikramrao1994/comforge/blob/main/packages/mcp/CHANGELOG.md)
- [License (Apache-2.0)](https://github.com/vikramrao1994/comforge/blob/main/LICENSE)
