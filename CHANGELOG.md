# Changelog

## 0.4.0

- Depends on @comforge/cli 0.6.0, the release whose checkout-free governance (createRemoteGovernance) the server's remote publication tools call.
- registerComforgeTools composes the native tools into an existing McpServer (collisions refused before anything is registered). RemoteHost.governance serves publish_specification, publish_review and the new publish_comment without a checkout. Needs the next @comforge/cli minor.
- package.json names the package's directory in the Comforge repository (repository.directory), its README (homepage) and the issue tracker (bugs).

## 0.3.0

- New subpath @comforge/mcp/host: createEngineeringHost (evidence reads, advisory reviews, trusted configuration, governed writes; read-only without injected writes) and sqliteOperationStore; the server's reads use the same services. Depends on @comforge/cli 0.5.0 and @comforge/ledger 0.1.0.
- serverInfo reports the package version (it said 0.1.0 in 0.2.0); createHttpHandler forwards remoteRepositories and remote, so checkout-free repositories can be served over HTTP with the same read-only, profile and session rules.

## 0.2.0

- Checkout-free repositories (remoteRepositories + remote host): GitHub evidence reads under a host-supplied trusted configuration verified against GitHub's bytes, pin, age and identity; reviews carry authorAssociation, commentUrl, updatedAt.

## 0.1.0

- Depends on @comforge/core 0.2.0, @comforge/github 0.5.0 and @comforge/cli 0.3.0; textContent summary option (--summary-text) so structured results are not sent twice.
- First release: comforge-mcp, the @comforge/cli lifecycle as an MCP server: intent-oriented tools (eighteen as of 0.2.0), four profiles, a repository allowlist, strict versioned schemas, stdio and Streamable HTTP; no remote execution without host isolation; cleanup plans only.
- New tools over @comforge/cli 0.3.0 services: comforge_prs, comforge_comments, comforge_reviews (advisory, never approvals), comforge_artifact, comforge_publish_review (reviewer), comforge_publish_specification (publisher); comforge_cleanup executes under a cleanup-scoped grant; host policy hook.
- Before the first release: sessions bound to the principal's fingerprint (role change ends a session, revocation and authenticator errors are 401), isolation providers validated and failing closed, comforge_issue lists issues, compactDiscovery option.
- comforge_artifact inherits the CLI's trusted-base artifact policy: non-canonical paths and an uncommitted wider configuration are refused before any contents request (regression tests over stdio and Streamable HTTP).
