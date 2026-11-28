# Host services

Status: published (`@comforge/mcp/host`, 0.3.0). For an application that runs its own server,
sessions and storage and needs the engineering services in-process. Reference:
[MCP › Host services](../reference/mcp.md#host-services-comforgemcphost).

```ts
import { createEngineeringHost, sqliteOperationStore } from "@comforge/mcp/host";

const host = createEngineeringHost({ repository: { owner: "acme", name: "widgets" }, transport });
await host.evidence.getPullRequest(42);
await host.trustedConfig({ branch: "main" });
```

- **Read-only** unless you inject `writes`: then `writes.prepare/execute/reconcile/abandon`
  refuse with `capability-denied` before any request exists.
- **Governed writes** with `writes` (`token`, `capabilities`, `authorize(descriptor)`,
  `operations`, `clock`): each write is sent at most once per operation id, only within the
  injected capabilities and only after your `authorize` allows that exact descriptor.
- `sqliteOperationStore` is a durable operation store over your own SQLite handle; it adopts an
  existing table and never removes an operation identity.

Your application keeps authentication, principals, admission and the decision to write.

## Composing the native tools into an application server

Status: unreleased (the next `@comforge/mcp` and `@comforge/cli` minors). For an application that
already serves its own MCP tools and wants the native comforge tools on the same endpoint, with
one connection and no second server.

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerComforgeTools } from "@comforge/mcp";
import { sqliteOperationStore } from "@comforge/mcp/host";

const server = new McpServer({ name: "acme-app", version: "1.0.0" }); // one per principal
server.registerTool("acme_search", { /* the application's own tool */ }, handler);
registerComforgeTools(server, {
  repositories: [],
  remoteRepositories: [{ id: "widgets", owner: "acme", name: "widgets", configSha256 }],
  remote: {
    trustedConfig: (binding) => snapshotFromGitHub(binding), // verified against GitHub again
    credentials: (binding) => readTokens[binding.id],        // read credential, per repository
    governance: (binding, principal) => ({                    // omit: reads only
      credentials: (command) => writeTokens[binding.id]?.[command],
      operations: sqliteOperationStore({ database, repository: binding.id }),
      authorize: (request) => policy(principal, request),     // scopes, switches, rate limits
    }),
  },
  host: { runtime: () => { throw new Error("no checkout"); } },
  principal: { id: principal.id, profiles: profilesFor(principal), repositories: ["widgets"] },
  transport: "http",
});
```

- **One registration, the same contract.** `createComforgeMcpServer` is this call on a new
  server; schemas, handlers, profile checks, allowlist, redaction and audit are shared, never
  copied.
- **Collisions** are refused before anything is registered: a server that already has a tool of
  a native name is left unchanged. Native tools are all `comforge_*`; keep application tools out
  of that prefix.
- **Isolation.** The native handlers close over these options only; the application's tools
  never see their credentials, and capability discovery (`comforge_capabilities`) describes the
  native tools only.
- **Authorization is never weaker than the repository's.** Without a checkout, governed
  publication needs an operator-mode trusted configuration and your `authorize`; owner-grant
  repositories refuse it (a command grant is spent in checkout state). Each write is planned
  with `execute: false`, authorized once, reconciled against GitHub before it is sent, and read
  back.
- **Separate credentials.** `governance.credentials(command)` is asked per command, so a review
  credential that cannot open issues, and one repository's token, never serve another.

Tested example: [`packages/mcp/test/composition.test.ts`](../../packages/mcp/test/composition.test.ts)
(an application tool next to the native tools, collisions, two repositories with separate
credentials and ledgers, a lost response, refused authorization, discussion comments).
