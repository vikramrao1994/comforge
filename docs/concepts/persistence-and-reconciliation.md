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

## `@comforge/ledger` adapter requirements

A ledger keeps one record per operation identity: it is created once, then replaced only as its
next version, under a compare-and-swap on the version. A record's first version is always 1.
`create` and `replace` return `false` when another writer got there first and leave the stored
record unchanged; they throw `LedgerError` for anything else. Records are JSON and `get` returns a
copy. Every adapter accepts a `validate(record)` callback, run on every write and every read; throw
from it to refuse a record.

**File adapter requirements.** A local POSIX filesystem with hard links and `fsync` (APFS, ext4,
xfs, btrfs, tmpfs), and a directory owned by the running user and not writable by others. It
refuses, rather than risk a silent duplicate:

| Situation | Error |
|---|---|
| Windows (`createFileLedger` throws) | `unsupported` |
| A filesystem without hard links: FAT, exFAT, some network or bind mounts | `unsupported`, from `probe()` or the first write |
| Symbolic links, directories open to other users | `unsafe-path` |

Call `probe()` when you configure a ledger directory: it checks safety and hard-link support and
reports whether directory `fsync` is available. Not supported: Windows; network filesystems (NFS,
SMB, cloud-synced folders), which are not validated even when `probe()` passes because atomic `link`
and `fsync` semantics vary; and several machines sharing one file ledger. On any of these use the
SQLite adapter on a local database file.

**File layout and writes.** Records live at
`<directory>/<namespace>/<sha256(operationId)>/<version>.json`, one file per version. Each version
is written to a private temp file, flushed with `fsync`, then hard-linked into place. `link` fails
when the name exists, so creating a version is atomic and exclusive across processes, and `replace`
is the exclusive creation of version n + 1, attempted only while n is the highest version. There
are no locks and no timed lock takeover, so a stalled writer can only lose. Namespace and operation
directories are created 0700 and refused as `unsafe-path` when they are symbolic links, owned by
another user or open to other users; version files are opened without following links, and an
operation id never becomes a path.

**Maintenance.** `inspect({ classify })` gives a read-only summary (operations by class, empty
operations, unreadable operations and orphaned temp files). `sweepOrphans({ olderThanMs })` removes
temp files left by writers that died, only when old and whose process no longer runs; a writer whose
temp file is removed anyway fails with `io` and publishes nothing. `compactHistory(operationId)`
rewrites superseded versions in place as small stubs: their bodies leave the disk but their names
stay taken. The current version is never rewritten, and it is safe alongside writers, readers and
other compactors. Versions are never deleted: deleting version n + 1 would let a writer that stalled
after reading n create it again.

**SQLite adapter.** Each operation is one atomic statement: `create` is
`INSERT … ON CONFLICT(operation_id) DO NOTHING`, `replace` is
`UPDATE … WHERE operation_id = ? AND version = ?`. An operation id is global in a table; an id held
by another namespace is refused as `foreign` and never read or written. You may keep an existing
table with your own name and namespace column: `fixedColumns` lists columns a replacement may not
change, and `encode` sets the stored form (for example a body digest once an operation is finished).
The connection, its pragmas (WAL, `busy_timeout`), transactions and migrations stay yours.

| Driver | Status |
|---|---|
| `bun:sqlite` | tested |
| `node:sqlite` (unflagged from Node 22.13; prints an experimental-feature warning on Node 22 and 24) | tested |
| anything else with `prepare(sql).get/all/run` and positional parameters (for example `better-sqlite3`) | expected to work through `statementDriver`; untested |

**Durability** (file adapter; SQLite is as durable as your connection's journal and synchronous
settings). A version appears complete or not at all. After a process crash (including `SIGKILL`
mid-write or mid-compaction) the ledger stays consistent, and at most an orphaned temp file remains
(tested). On power loss it is only as durable as the platform's `fsync`: on macOS `fsync` does not
flush the drive cache (no `F_FULLFSYNC`), so the last version can be lost and readers see the one
before it (not tested). A ledger makes a retried side effect safe to reconcile; it does not make the
side effect itself atomic.

**Retention.**

| | Keeps the identity | Idempotency |
|---|---|---|
| File `compactHistory` | yes | unlimited |
| SQLite `compact({ updatedBefore, limit, select, rewrite })` | yes: same id and version, smaller record | unlimited |
| SQLite `purge({ updatedBefore, limit, select })` | no: the row is deleted | ends at `updatedBefore`: a later `create` of that id succeeds |

`select` decides what may change; only what it accepts is compacted or purged. Select only finished
operations: never compact or purge an unresolved one (reserved, sending, indeterminate). Unreadable
rows and other namespaces are never touched. A compaction that races a replacement never writes over
the newer version. With `@comforge/github`, a compacted record keeps everything a replay needs
(identity, version, state, fingerprint, descriptor except the body, authorization reference, marker,
outcome with the written resource, failure and timestamps): it replays with no request, also from a
new process, and a different request under the same identity is refused as `conflict`. After
`purge` that ends for the purged identity, so use it only when operation ids are never reused after
the horizon you choose.

**Conformance and errors.** `ledgerConformance(open)` runs in one process and covers empty reads
and copy isolation, exclusive create and the initial version, the compare-and-swap with stale and
skipped versions, concurrent creators and replacers, long chains and namespace isolation.
Contention between processes, crashes and filesystem faults are adapter-specific; test them with
real processes. `LedgerError.code`:

| Code | Meaning |
|---|---|
| `invalid-record` | the request breaks the contract; nothing was stored |
| `corrupt` | a stored record cannot be read as this operation's |
| `foreign` | another namespace holds the id |
| `unsafe-path` | a link, a wrong file type, or a path open to other users |
| `unsupported` | for example, no hard links |
| `io` | storage failed |

After an `io` error from `create` or `replace`, the write may have taken effect, exactly as after a
crash; `detail.published` is `true` when a file version was linked but its directory flush failed.
