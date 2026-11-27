---
name: contributor-security-changes
description: Change authorization, trust boundaries, credentials handling or disclosure rules safely.
category: contributor
---

# contributor-security-changes

Change authorization, trust boundaries, credentials handling or disclosure rules safely.

## When to use

- The change touches grants, receipts, authorization modes, capabilities, credential sources, the disclosure scan or release authorization.

## Prerequisites

- docs/security/authorization-and-trust.md; the adversarial tests of the touched package.

## Examples

```sh
bun test --isolate packages/cli/test/authorization.test.ts packages/mcp/test/adversarial.test.ts tests/release/releaseAuthorization.test.ts
```

## Decision rules

- Fail closed: an unknown mode, scheme, key or field is refused, never ignored.
- Add an adversarial test for every new refusal.
- Separate authorities stay separate (lifecycle grants, runtime grants, release authorizations).

## Security boundaries

- Never log or return a credential; never widen a default capability; never make an agent able to approve its own work.

## Validation

```sh
bun run test && bun run disclosure
```

## Failure and recovery

- A security test fails after a refactor: treat as a regression, not a test to update.

## References

- [docs/security/authorization-and-trust.md](../../docs/security/authorization-and-trust.md)
- [docs/decisions/0001-deterministic-governance.md](../../docs/decisions/0001-deterministic-governance.md)
