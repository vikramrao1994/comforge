# 0001 — Deterministic code decides; instructions guide

Status: accepted.

Every permission, write and refusal is decided by code reading trusted inputs (the base-branch
configuration, signed grants, the ledger). Agent instructions, skills and context routing are
guidance: no command reads them to decide a permission. Consequence: a prompt injection in an
issue or comment can change what an agent attempts, never what Comforge allows.
