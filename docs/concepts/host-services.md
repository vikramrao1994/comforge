# Host services

Status: published (`@comforge/mcp/host`, 0.3.0). For an application that runs its own server,
sessions and storage and needs the engineering services in-process. Reference:
[MCP › Host services](../../packages/mcp/README.md#host-services).

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
