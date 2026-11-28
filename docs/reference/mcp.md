# MCP reference — `@comforge/mcp`

Status: published (`@comforge/mcp` 0.3.0). The generated [tool inventory](inventory/mcp-tools.md)
is authoritative for tools, profiles, launch flags and the remote read set; the package
[README](../../packages/mcp/README.md) has the full security model.

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
| `publisher` | `comforge_deliver`, `comforge_recover`, `comforge_cleanup`, `comforge_publish_specification` |

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

Every runtime export: [API inventory](inventory/api.md#comforgemcp-030).
