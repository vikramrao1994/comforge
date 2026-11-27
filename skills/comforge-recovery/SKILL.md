---
name: comforge-recovery
description: Recover from interrupted writes, lost checkouts and partial deliveries without repeating a write.
category: consumer
---

# comforge-recovery

Recover from interrupted writes, lost checkouts and partial deliveries without repeating a write.

## When to use

- A command failed mid-write, the network dropped, or `status` shows unresolved operations.

## Prerequisites

- The initiative id; the primary checkout that holds `.git/comforge/`.

## Examples

```sh
npx comforge status ACME-101 --json
npx comforge recover ACME-101              # report what is uncertain
npx comforge recover ACME-101 --execute    # settle from GitHub
npx comforge revise 34                     # re-create a lost checkout from the PR
```

## Decision rules

- Never resend an uncertain write by hand: `recover` searches GitHub first.
- `--abandon` only after `recover` reports a complete search that found nothing.

## Security boundaries

- Recovery never widens capabilities or skips authorization.

## Validation

```sh
npx comforge status ACME-101 --json   # 0 unresolved operations
```

## Failure and recovery

- `ledger-locked`: another process holds the initiative; wait or find it.
- Repeated `indeterminate`: check GitHub availability, then rerun `recover`.

## References

- [docs/persistence-and-reconciliation.md](../../docs/persistence-and-reconciliation.md)
- [docs/migration-and-recovery.md](../../docs/migration-and-recovery.md)
