# Changelog

## 0.2.0

- Checkout-free repositories (remoteRepositories + remote host): GitHub evidence reads under a host-supplied trusted configuration verified against GitHub's bytes, pin, age and identity; reviews carry authorAssociation, commentUrl, updatedAt.

## 0.1.0

- Depends on @comforge/core 0.2.0, @comforge/github 0.5.0 and @comforge/cli 0.3.0; textContent summary option (--summary-text) so structured results are not sent twice.
- First release: comforge-mcp, the @comforge/cli lifecycle as an MCP server: twelve intent-oriented tools, four profiles, a repository allowlist, strict versioned schemas, stdio and Streamable HTTP; no remote execution without host isolation; cleanup plans only.
- New tools over @comforge/cli 0.3.0 services: comforge_prs, comforge_comments, comforge_reviews (advisory, never approvals), comforge_artifact, comforge_publish_review (reviewer), comforge_publish_specification (publisher); comforge_cleanup executes under a cleanup-scoped grant; host policy hook.
- Before the first release: sessions bound to the principal's fingerprint (role change ends a session, revocation and authenticator errors are 401), isolation providers validated and failing closed, comforge_issue lists issues, compactDiscovery option.
- comforge_artifact inherits the CLI's trusted-base artifact policy: non-canonical paths and an uncommitted wider configuration are refused before any contents request (regression tests over stdio and Streamable HTTP).

## Unreleased

- First release candidate: `comforge-mcp`, the governed lifecycle of `@comforge/cli` as an MCP server. Twelve intent-oriented tools (`comforge_capabilities`, `comforge_context`, `comforge_status`, `comforge_evidence`, `comforge_issue`, `comforge_pr`, `comforge_start`, `comforge_revise`, `comforge_verify`, `comforge_deliver`, `comforge_recover`, `comforge_cleanup`) over the published lifecycle services and GitHub reads, with read-only, reviewer, executor and publisher profiles, a repository allowlist, strict versioned schemas, summary-first paginated results, stdio and Streamable HTTP. Remote execution is off unless the host supplies isolation; executing cleanup is refused.
