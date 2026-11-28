# Recipe 8 — durable state in a file or in SQLite

<!-- recipe: {"world": "github"} -->

`@comforge/ledger` 0.1.0 (published) is the write-ahead store behind every GitHub write: each
operation is recorded before it is sent and settled by what GitHub then shows. It has three
adapters with one contract: memory, files (atomic, hard-link based) and SQLite (`node:sqlite` or
`bun:sqlite`). A host can give the lifecycle a SQLite ledger instead of the default files under
`.git/comforge/`, and can run the same conformance suite against its own adapter.

**How this page is tested.** CI runs the blocks in a scratch directory with the published
package. The example is JavaScript (ESM); it needs Node.js ≥ 22.13 or Bun for `node:sqlite`.

## 1. One record type, two stores, compare-and-swap

```sh recipe
cat > "$WORK/ledger.mjs" <<'EOF'
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createFileLedger } from "@comforge/ledger/file";
import { createSQLiteLedger, ledgerTableStatements, statementDriver } from "@comforge/ledger/sqlite";

const validate = (r) => {
  if (r.state !== "queued" && r.state !== "done") throw new Error("unknown state");
};
const dir = mkdtempSync(path.join(tmpdir(), "acme-ledger-"));
const db = new DatabaseSync(path.join(dir, "jobs.sqlite"));
for (const sql of ledgerTableStatements({ columns: { state: "TEXT" } })) db.prepare(sql).run();

const stores = {
  file: createFileLedger({ directory: path.join(dir, "files"), namespace: "acme-jobs", validate }),
  sqlite: createSQLiteLedger({ driver: statementDriver(db), namespace: "acme-jobs", validate,
                               columns: (r) => ({ state: r.state }) }),
};
const out = {};
for (const [name, jobs] of Object.entries(stores)) {
  await jobs.create({ operationId: "job-1", version: 1, state: "queued", body: "payload" });
  // Two writers race from version 1: exactly one replace wins.
  const won = await jobs.replace("job-1", 1, { operationId: "job-1", version: 2, state: "done", body: "payload" });
  const lost = await jobs.replace("job-1", 1, { operationId: "job-1", version: 2, state: "done", body: "other" });
  out[name] = { won, lost, state: (await jobs.get("job-1"))?.state };
}
console.log(JSON.stringify(out));
EOF
node "$WORK/ledger.mjs"
```
<!-- recipe-expect: {"json": {"file.won": true, "file.lost": false, "sqlite.won": true, "sqlite.lost": false, "sqlite.state": "done"}} -->

**Expected:** in both stores the first `replace` wins and the second, from the same version,
loses. That is the compare-and-swap every lifecycle write relies on.

## 2. Check your own adapter against the contract

`@comforge/ledger/conformance` runs the shared suite against any `open(namespace)` function:

```sh recipe
cat > "$WORK/conformance.mjs" <<'EOF'
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ledgerConformance } from "@comforge/ledger/conformance";
import { createFileLedger } from "@comforge/ledger/file";

const dir = mkdtempSync(path.join(tmpdir(), "acme-conformance-"));
let n = 0;
const cases = ledgerConformance((ns) => createFileLedger({ directory: dir, namespace: ns }), {
  namespaces: () => { n += 1; return [`a${n}`, `b${n}`]; },
});
let passed = 0;
for (const c of cases) { await c.run(); passed += 1; }
console.log(JSON.stringify({ cases: cases.length, passed }));
EOF
node "$WORK/conformance.mjs"
```
<!-- recipe-expect: {"stdout": "\"passed\""} -->

## Errors

| Error | Cause |
|---|---|
| `LedgerError` `invalid-record` | the record failed your `validate` |
| `LedgerError` `unsafe-path` | the file ledger's directory is a symlink, foreign-owned or open to other users |
| hard-link probe failure | the file ledger needs a filesystem with hard links (not FAT, exFAT, some network mounts); use SQLite |

## Side effects, security, cleanup

- **Writes:** files and a SQLite database in a temporary directory; nothing on GitHub.
- **Reconciliation is not exactly-once:** the ledger makes a lost answer detectable and never
  re-sends it blindly; `comforge recover` settles it from GitHub ([recipe 4](04-interrupted-handover-and-recovery.md)).
- **Cleanup:** delete the temporary directory.
