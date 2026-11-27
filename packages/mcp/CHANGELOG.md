# Changelog

## 0.3.0

- New subpath @comforge/mcp/host: createEngineeringHost (evidence reads, advisory reviews, trusted configuration, governed writes; read-only without injected writes) and sqliteOperationStore; the server's reads use the same services. Depends on @comforge/cli 0.5.0 and @comforge/ledger 0.1.0.
- serverInfo reports the package version (it said 0.1.0 in 0.2.0); createHttpHandler forwards remoteRepositories and remote, so checkout-free repositories can be served over HTTP with the same read-only, profile and session rules.

## Unreleased

- `createHttpHandler` forwards `remoteRepositories` and `remote`, so an HTTP host serves checkout-free repositories (evidence reads only) with the same authentication, Host and Origin checks, profile checks, session binding and refusal of executing tools. Constructing it with remote bindings and no remote host throws.
- `serverInfo.version` reports the package version (it reported 0.1.0 in 0.2.0); a test fails if the constant differs from package.json.
- README: quickstart, install-one-interface guidance, recovery and concurrency notes, measured onboarding evidence; "candidate" labels removed for shipped features.

## 0.2.0

- Checkout-free repositories (remoteRepositories + remote host): GitHub evidence reads under a host-supplied trusted configuration verified against GitHub's bytes, pin, age and identity; reviews carry authorAssociation, commentUrl, updatedAt.

## 0.1.0

- Depends on @comforge/core 0.2.0, @comforge/github 0.5.0 and @comforge/cli 0.3.0; textContent summary option (--summary-text) so structured results are not sent twice.
- First release: comforge-mcp, the @comforge/cli lifecycle as an MCP server: intent-oriented tools (eighteen as of 0.2.0), four profiles, a repository allowlist, strict versioned schemas, stdio and Streamable HTTP; no remote execution without host isolation; cleanup plans only.
- New tools over @comforge/cli 0.3.0 services: comforge_prs, comforge_comments, comforge_reviews (advisory, never approvals), comforge_artifact, comforge_publish_review (reviewer), comforge_publish_specification (publisher); comforge_cleanup executes under a cleanup-scoped grant; host policy hook.
- Before the first release: sessions bound to the principal's fingerprint (role change ends a session, revocation and authenticator errors are 401), isolation providers validated and failing closed, comforge_issue lists issues, compactDiscovery option.
- comforge_artifact inherits the CLI's trusted-base artifact policy: non-canonical paths and an uncommitted wider configuration are refused before any contents request (regression tests over stdio and Streamable HTTP).
