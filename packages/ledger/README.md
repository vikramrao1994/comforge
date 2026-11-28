<p align="center">
  <a href="https://github.com/vikramrao1994/comforge">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://github.com/vikramrao1994/comforge/raw/main/docs/assets/brand/comforge-logo-dark.svg">
      <img alt="Comforge" src="https://github.com/vikramrao1994/comforge/raw/main/docs/assets/brand/comforge-logo-light.svg" height="40">
    </picture>
  </a>
</p>

# @comforge/ledger

Durable, recoverable operation storage: a write-ahead ledger that keeps one record per operation identity, replaced only as its next version under a compare-and-swap. It makes an external side effect safe to retry across restarts and concurrent processes, with memory, file and SQLite adapters and no dependencies.

[![npm](https://img.shields.io/npm/v/@comforge/ledger?label=npm&color=0b7285)](https://www.npmjs.com/package/@comforge/ledger)
[![CI](https://github.com/vikramrao1994/comforge/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/vikramrao1994/comforge/actions/workflows/ci.yml)
[![License](https://img.shields.io/npm/l/@comforge/ledger?color=0b7285)](https://github.com/vikramrao1994/comforge/blob/main/LICENSE)
[![Node](https://img.shields.io/node/v/@comforge/ledger?color=0b7285)](https://github.com/vikramrao1994/comforge/blob/main/docs/reference/compatibility.md)

## Install

```sh
npm install --save-exact @comforge/ledger      # or: bun add --exact @comforge/ledger
```

## Quick example

```ts
import type { LedgerRecord } from "@comforge/ledger";
import { createFileLedger } from "@comforge/ledger/file";

interface Job extends LedgerRecord { state: "queued" | "done"; body: string }

const jobs = createFileLedger<Job>({ directory: "/var/lib/acme", namespace: "acme-jobs" });

await jobs.create({ operationId: "j1", version: 1, state: "queued", body: "payload" }); // true
const won = await jobs.replace("j1", 1, { operationId: "j1", version: 2, state: "done", body: "payload" });   // true
const lost = await jobs.replace("j1", 1, { operationId: "j1", version: 2, state: "done", body: "other" });    // false: another writer got there first
```

Based on [examples/ledger-consumer](https://github.com/vikramrao1994/comforge/tree/main/examples/ledger-consumer), which also runs the conformance cases against all three adapters.

## What it provides

| Export | Subpath | Use |
|---|---|---|
| `Ledger`, `LedgerRecord`, `LedgerError` | `@comforge/ledger` | The contract (`get`, `create`, `replace`) and typed errors: `invalid-record`, `corrupt`, `foreign`, `unsafe-path`, `unsupported`, `io` |
| `createMemoryLedger` | `@comforge/ledger` | An in-process ledger for tests and examples |
| `createFileLedger` | `@comforge/ledger/file` | Immutable files, one per version, hard-linked into place; `probe`, `inspect`, `sweepOrphans` and `compactHistory` |
| `createSQLiteLedger`, `ledgerTableStatements`, `statementDriver` | `@comforge/ledger/sqlite` | One table on a connection you own; `compact` and `purge` for retention |
| `ledgerConformance` | `@comforge/ledger/conformance` | Shared test cases for any adapter you write |

`create` and `replace` return `false` when another writer got there first, and leave the stored record unchanged. Every adapter accepts a `validate(record)` callback run on every write and read. Retention never silently weakens idempotency: compaction keeps the identity, while SQLite `purge` ends idempotency for the purged identity.

## Compatibility

- Node.js 22.18 or later, or Bun 1.4 or later; tested on macOS and Linux.
- File adapter: a local POSIX filesystem with hard links and `fsync` (APFS, ext4, xfs, btrfs, tmpfs), in a directory owned by the running user and not writable by others.
- SQLite adapter: `bun:sqlite` and `node:sqlite` are tested; other drivers with `prepare(sql).get/all/run` are expected to work through `statementDriver` but are untested.

Details: [compatibility](https://github.com/vikramrao1994/comforge/blob/main/docs/reference/compatibility.md).

## Limitations

- Not supported: Windows, network filesystems (NFS, SMB, cloud-synced folders) and several machines sharing one file ledger. The file adapter refuses Windows and filesystems without hard links; on any of these, use the SQLite adapter on a local database file.
- Power loss is only as durable as the platform's `fsync`; on macOS the last version can be lost. Crash safety (including `SIGKILL`) is tested.
- A ledger makes a retried side effect safe to reconcile. It does not make the side effect itself atomic, and it is not an exactly-once guarantee.

See [adapter requirements, durability and retention](https://github.com/vikramrao1994/comforge/blob/main/docs/concepts/persistence-and-reconciliation.md#comforgeledger-adapter-requirements).

## Documentation

- [Repository README](https://github.com/vikramrao1994/comforge#readme)
- [Persistence and reconciliation](https://github.com/vikramrao1994/comforge/blob/main/docs/concepts/persistence-and-reconciliation.md), [API](https://github.com/vikramrao1994/comforge/blob/main/docs/reference/api.md)
- [Recipe: file and SQLite persistence](https://github.com/vikramrao1994/comforge/blob/main/docs/recipes/08-file-and-sqlite-persistence.md)
- [Architecture](https://github.com/vikramrao1994/comforge/blob/main/docs/concepts/architecture.md)
- [Runnable example](https://github.com/vikramrao1994/comforge/tree/main/examples/ledger-consumer)
- [Changelog](https://github.com/vikramrao1994/comforge/blob/main/packages/ledger/CHANGELOG.md)
- [License (Apache-2.0)](https://github.com/vikramrao1994/comforge/blob/main/LICENSE)
