---
name: comforge-embedded-host
description: Embed Comforge services in your own server: host services, protocol services, runtime authority.
category: consumer
---

# comforge-embedded-host

Embed Comforge services in your own server: host services, protocol services, runtime authority.

## When to use

- The task builds a service or product that calls Comforge in-process instead of the CLI or MCP server.

## Prerequisites

- `@comforge/mcp` and `@comforge/cli` as dependencies; your own authentication and storage.

## Examples

```sh
import { createEngineeringHost, sqliteOperationStore } from "@comforge/mcp/host";
import { createProtocolServices } from "@comforge/cli/protocols";
import { createRuntimeAuthority, ed25519Signer } from "@comforge/cli/authority";
const host = createEngineeringHost({ repository: { owner: "acme", name: "widgets" }, transport });
```

## Decision rules

- Without `writes` the host is read-only; inject `writes` only in a trusted host with its own `authorize`.
- Use a compatibility profile only to keep verifying records published under an older identity.

## Security boundaries

- Your application owns authentication, principals and the decision to write; the services never take them from a caller.
- Keep runtime authority keys separate from lifecycle grant keys (`separateFrom`).

## Validation

```sh
Run tests/mcp/twoPackageConsumer.test.ts as a template: a host that depends on exactly cli and mcp.
```

## Failure and recovery

- `capability-denied`: the host is read-only or the capability is not injected.
- `HostServiceError` codes are stable; map them, never parse messages.

## References

- [docs/concepts/host-services.md](../../docs/concepts/host-services.md)
- [docs/concepts/protocols-and-authority.md](../../docs/concepts/protocols-and-authority.md)
- [packages/mcp/README.md#host-services](../../packages/mcp/README.md#host-services)
- [docs/recipes/07-embedded-host-services.md](../../docs/recipes/07-embedded-host-services.md)
- [docs/reference/api.md](../../docs/reference/api.md)
