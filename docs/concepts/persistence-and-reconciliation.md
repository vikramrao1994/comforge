# Persistence, concurrency and reconciliation

Status: published (`@comforge/ledger` 0.1.0, `@comforge/cli` ≥ 0.2.0).

- **State** lives in `.git/comforge/` of the primary checkout, outside every commit.
- **The write ledger** records each external write before it is sent (prepared → sent →
  confirmed | indeterminate). File and SQLite adapters pass the same conformance suite
  (`@comforge/ledger/conformance`); the file adapter needs hard links.
- **Concurrency**: one writer per initiative; competing processes are serialized by
  compare-and-set on the record version (tested with real processes in `tests/ledger`).
- **No exactly-once claim**: a write whose answer was lost becomes `indeterminate` and is never
  resent automatically. `comforge recover` searches GitHub for it and settles it;
  `recover --abandon` gives it up only after a complete search found nothing.
- **Retention**: finished operations are minimized to a digest; identities are never removed.
