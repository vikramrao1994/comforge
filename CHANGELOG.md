# Changelog

`@comforge/core`, the governance kernel of Comforge. Every release is tagged `core/vMAJOR.MINOR.PATCH` on the `releases/core` branch of the public Comforge repository and carries a `RELEASE.json` naming its source commit, the TypeScript version that compiled it, the SHA-256 of every file and of the npm tarball. Released versions are never changed; a correction is a new version.

## 0.1.1

Distribution release. The library is unchanged: same source, exports, wire formats and signatures as 0.1.0.

- Published to npm as `@comforge/core` through Trusted Publishing, with provenance naming this repository, the `npm-publish.yml` workflow, the `core/v0.1.1` tag and the release commit; 0.1.0 was a one-time manual publish without provenance.
- The release branch now carries that workflow (`.github/workflows/npm-publish.yml`) and its dependency-free verifier (`.github/comforge/npm-release.mjs`). Neither is part of the npm package.
- `package.json` declares `repository`, which npm needs to check provenance.
- README documents installing from npm at an exact version. Example links in README and `llms.txt` now point at this release's tag on GitHub, so they also resolve from the npm package, which does not include `examples/`.

## 0.1.0

First versioned release, and the first under the name `@comforge/core` (the unversioned distribution was named `factory-core`; import from `@comforge/core` instead). The public surface is otherwise unchanged:

- `createSpecificationProtocol`: published-specification canonicalization, digests, markers and verification;
- `createGrantProtocol`, `createReceiptProtocol` and the authorization vocabulary: owner-grant and validation-receipt verification (verification only, never signing);
- `createReviewProtocol`, `createCompletionProtocol`: advisory-review and completion-record integrity;
- `evaluateLifecycleAction`: lifecycle decisions (`allow` / `deny` / `insufficient_evidence`).

Runtimes: Node ≥ 22 (compiled `dist/`), Bun ≥ 1.4. Only runtime dependency: `zod` 4. ESM only.

Licensed under the Apache License, Version 2.0 (`LICENSE`, SPDX `Apache-2.0`).
