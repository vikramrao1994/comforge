# Changelog

## 0.1.0

- First release: a versioned compare-and-swap ledger contract (structurally @comforge/github's OperationLedger) with immutable-file, caller-connection SQLite and memory adapters, typed errors, namespace isolation, safe retention and shared conformance cases. No dependencies.
- File history compaction leaves unreadable superseded versions as found; README and llms.txt state the tested runtimes (Node 22, 24, 26, Bun 1.4), file-adapter prerequisites and refusals, untested SQLite drivers and durability levels.
