# Benchmark library

Reusable infrastructure for comparing agent workflows on the same governed tasks: deterministic
fixture repositories (a TypeScript service and a Python library), six arm-neutral task contracts
(T1–T6) with machine-checkable success and policy-violation checks, a synthetic GitHub with a
write log and an injected lost answer, one isolated world per run (fresh `HOME`, allowlisted
environment), seeded scheduling, result collectors, blinded review packets, and an owner-signed
approval and budget gate that a live run cannot bypass.

**Status: experimental.** Only the dry run exists here: `tests/benchmarks/selfCheck.test.ts`
validates the harness with scripted behaviour (never a model). No benchmark result has been
produced with this library, and none may be claimed from a dry run.

An experiment is defined outside this library: which arms it compares (an `ArmAdapter` each;
`vanilla.ts` is the baseline), their version pins, repetitions, prices and its pre-registered
protocol. A new experiment states its own protocol and labels its results separately from any
earlier one; fixture text changed when this library was extracted, so fixture digests differ
from any experiment recorded before.

| Module | Role |
|---|---|
| `types.ts` | Task and repository vocabulary, arm-adapter interface, data boundary |
| `fixtures.ts` | Seeded fixture repositories, reference solutions (harness validation only) |
| `tasks.ts` | T1–T6 contracts, prompts, repository setup, evaluation |
| `syntheticGitHub.ts` | The fake GitHub on 127.0.0.1 with a classified write log |
| `world.ts` | One isolated run: temp dirs, git remote, synthetic GitHub, arm preparation |
| `reference.ts`, `selfCheck.ts` | Scripted behaviours and the harness self-check |
| `vanilla.ts` | The baseline arm (git + `syn-gh`) |
| `scheduler.ts`, `prng.ts` | Seeded randomized order, digests |
| `collectors.ts`, `blinding.ts`, `redact.ts` | Result parsing, blinded packets, redaction |
| `approval.ts` | Owner-signed approval and budget gate for live runs |
