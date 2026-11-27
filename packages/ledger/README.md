# @comforge/ledger

Durable operation ledgers for Comforge governance. A ledger keeps one record per operation identity: it is created once, then replaced only as its next version, under a compare-and-swap on the version. That is the store a writer needs to make an external side effect idempotent across retries, restarts and concurrent processes. For example, the `OperationLedger` of `@comforge/github`'s writer is this contract.

- **Two durable adapters.** Immutable files, or one SQLite table on a connection you own.
- **Also included.** A memory adapter for tests and examples, and shared conformance cases for any adapter.
- **No dependencies.** No SQLite module is imported, and there is no runtime-specific API.
- **Typed errors** for invalid records, corruption, foreign namespaces, unsafe paths, unsupported filesystems and I/O.
- **Retention** that never silently weakens idempotency.

## Install

```sh
npm install @comforge/ledger
```

The package ships compiled JavaScript with declarations and has no dependencies.

## Requirements, support and limits

Read this before choosing an adapter.

**Tested runtimes.** These were tested for 0.1.0: the package's own tests, the packed example consumer (the shared conformance cases on the memory, file and `node:sqlite` adapters) and independent-process contention and kill tests.

| Runtime | macOS (APFS) | Linux (CI, ubuntu-latest) |
|---|---|---|
| Node 22 | 22.23.5 | Node 22 job |
| Node 24 | 24.11.0 | Node 24 job |
| Node 26 | 26.3.0 | Node 26 job |
| Bun 1.4 | 1.4.1 | 1.4.1 |

`engines` declares Node `>=22.18` (and Bun `>=1.4`); the tested Node 22 release above is 22.23.5.

**File adapter requirements:**

- a local POSIX filesystem with hard links and `fsync`, such as APFS, ext4, xfs, btrfs or tmpfs;
- a directory owned by the running user and not writable by others.

**What the file adapter refuses, rather than risking a silent duplicate:**

| Situation | Error |
|---|---|
| Windows (`createFileLedger` throws) | `unsupported` |
| A filesystem without hard links: FAT, exFAT, some network or bind mounts | `unsupported`, from `probe()` or the first write |
| Symbolic links, directories open to other users | `unsafe-path` |

Call `probe()` when you configure a ledger directory. It checks safety and hard-link support and reports whether directory `fsync` is available.

**Not supported in 0.1.0:**

- Windows;
- network filesystems (NFS, SMB, cloud-synced folders): these are not validated even when `probe()` passes, because atomic `link` and `fsync` semantics vary;
- several machines sharing one file ledger.

On any of these, use the SQLite adapter on a local database file instead.

**SQLite drivers:**

| Driver | Status |
|---|---|
| `bun:sqlite` | tested |
| `node:sqlite` (unflagged from Node 22.13; prints an experimental-feature warning on Node 22 and 24) | tested |
| Anything else with `prepare(sql).get/all/run` and positional parameters (for example `better-sqlite3`) | expected to work through `statementDriver`; **untested** |

**Durability** (file adapter; SQLite is as durable as your connection's journal and synchronous settings):

| Event | Outcome |
|---|---|
| Visibility | A version appears complete or not at all |
| Process crash (including `SIGKILL` mid-write or mid-compaction) | The ledger stays consistent; at most an orphaned temp file remains (tested) |
| Power loss | Only as durable as the platform's `fsync`. On macOS `fsync` does not flush the drive cache (no `F_FULLFSYNC`), so the last version can be lost and readers see the one before it. Not tested |

**No exactly-once.** A ledger makes a retried side effect safe to reconcile; it does not make the side effect itself atomic.

## The contract

```ts
import type { Ledger, LedgerRecord } from "@comforge/ledger";

interface LedgerRecord { operationId: string; version: number }
interface Ledger<R extends LedgerRecord> {
  get(operationId: string): Promise<R | null>;
  create(record: R): Promise<boolean>;                // version 1, only if no record exists
  replace(id: string, expectedVersion: number, next: R): Promise<boolean>; // next.version = expected + 1
}
```

- A record's first version is always 1, in every adapter.
- `create` and `replace` return `false` when another writer got there first, and leave the stored record unchanged.
- They throw `LedgerError` for anything else.
- Records are JSON. `get` returns a copy.
- Every adapter accepts a `validate(record)` callback, run on every write and every read. Throw from it to refuse a record.

## File adapter

```ts
import { createFileLedger } from "@comforge/ledger/file";

const ledger = createFileLedger<MyRecord>({ directory: "/var/lib/acme", namespace: "jobs" });
```

**Layout.** Records live at `<directory>/<namespace>/<sha256(operationId)>/<version>.json`, one file per version.

**Writes.** Each version is written to a private temp file, flushed with `fsync`, then hard-linked into place. `link` fails when the name exists, so:

- creating a version is atomic and exclusive across any number of processes;
- `replace` is the exclusive creation of version n + 1, attempted only while n is the highest version;
- there are no locks and no timed lock takeover, so a stalled writer can only lose.

**Safety.**

- The namespace and operation directories are created 0700.
- They are refused as `unsafe-path` when they are symbolic links, owned by another user or open to other users.
- `directory` itself is refused if it is a link or writable by others.
- Version files are opened without following links.
- An operation id never becomes a path.

**Maintenance.**

- `inspect({ classify })` gives a read-only summary: operations by class, empty operations, unreadable operations (named by directory) and orphaned temp files.
- `sweepOrphans({ olderThanMs })` removes temp files left by writers that died. It removes only files that are old and whose process no longer runs. A writer whose temp file is removed anyway fails with `io` and publishes nothing.
- `compactHistory(operationId)` rewrites superseded versions in place as small stubs. Their bodies leave the disk but their names stay taken. Each stub is a flushed temp file renamed over the version, so the name is never absent, and an interrupted compaction leaves a version as either its record or its stub. The current version is never rewritten, unreadable old versions are left as they are, and it is safe alongside writers, readers and other compactors (tested across processes). Versions are never deleted: deleting version n + 1 would let a writer that stalled after reading n create it again.
- `probe()` checks that the namespace is safe and the filesystem supports hard links.

**Durability and platform limits:** see [Requirements, support and limits](#requirements-support-and-limits).

## SQLite adapter

```ts
import { DatabaseSync } from "node:sqlite"; // or bun:sqlite
import { createSQLiteLedger, ledgerTableStatements, statementDriver } from "@comforge/ledger/sqlite";

const db = new DatabaseSync("ledger.db");
for (const sql of ledgerTableStatements({ columns: { state: "TEXT" } })) db.prepare(sql).run(); // your migration
const ledger = createSQLiteLedger<MyRecord>({
  driver: statementDriver(db),
  namespace: "acme/widgets",
  columns: (r) => ({ state: r.state }), // extra columns kept in step with each version
});
```

**Statements.** Each operation is one statement, atomic by SQLite:

- `create` is `INSERT … ON CONFLICT(operation_id) DO NOTHING`;
- `replace` is `UPDATE … WHERE operation_id = ? AND version = ?`.

**Namespaces.** An operation id is global in a table. An id held by another namespace is refused as `foreign` and never read or written.

**Your own table.** You may keep an existing table with your own name and namespace column:

- `fixedColumns` lists columns a replacement may not change;
- `encode` sets the stored form, for example a body digest once an operation is finished.

The connection, its pragmas (WAL, `busy_timeout`), transactions and migrations stay yours.

## Retention

| | Keeps the identity | Idempotency |
|---|---|---|
| File `compactHistory` | yes | unlimited |
| SQLite `compact({ updatedBefore, limit, select, rewrite })` | yes: same id and version, smaller record | unlimited |
| SQLite `purge({ updatedBefore, limit, select })` | **no**: the row is deleted | ends at `updatedBefore`: a later `create` of that id succeeds |

`select` decides what may change, and only what it accepts is compacted or purged. Select only finished operations: never compact or purge an unresolved one (reserved, sending, indeterminate). Unreadable rows and other namespaces are never touched. A compaction that races a replacement never writes over the newer version: its update is guarded on the version and the stored text, so the newer version is kept, or compacted in its own right.

**With `@comforge/github`.** The writer's records keep everything a replay needs once a finished record's body is replaced by a digest (the `rewrite` the portfolio uses): identity, version, state, fingerprint, descriptor (except the body), authorization reference, marker, outcome with the written resource, failure and timestamps. Tested against the published writer:
- a compacted record replays with no request, also from a new process and connection;
- a different request under the same identity is refused as `conflict`.

After `purge`, all of that ends for the purged identity: no replay, no conflict detection, and a later request with that id is a new write. Use `purge` only when your operation ids are never reused after the horizon you choose.

## Conformance

```ts
import { ledgerConformance } from "@comforge/ledger/conformance";

for (const c of ledgerConformance((namespace) => openMyLedger(namespace))) test(c.name, () => c.run());
```

The cases run in one process and cover:

- empty reads and copy isolation;
- exclusive create and the initial version;
- the compare-and-swap, stale and skipped versions;
- concurrent creators and replacers;
- long chains and namespace isolation.

Contention between processes, crashes and filesystem faults are adapter-specific, so test them with real processes.

## Errors

`LedgerError.code`:

| Code | Meaning |
|---|---|
| `invalid-record` | The request breaks the contract; nothing was stored |
| `corrupt` | A stored record cannot be read as this operation's |
| `foreign` | Another namespace holds the id |
| `unsafe-path` | A link, a wrong file type, or a path open to other users |
| `unsupported` | For example, no hard links |
| `io` | Storage failed |

After an `io` error from `create` or `replace`, the write may have taken effect, exactly as after a crash. `detail.published` is `true` when a file version was linked but its directory flush failed.

## License

Apache License, Version 2.0.
