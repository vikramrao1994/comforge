# Recipe 10 — a governed npm release

<!-- recipe: {"world": "repository"} -->

How a Comforge package version is planned, rehearsed, authorized and published. **Most of this
is this repository's own tooling**, not a public API of the five packages:

| Piece | Kind |
|---|---|
| `release-intents/`, `bun run release:plan`, `release:version-pr`, `release:rehearse`, `release:approve`, `release.yml`, `release-trust.json` | **this repository's tooling** (not published; reuse by copying, under Apache-2.0) |
| npm Trusted Publishing with provenance (GitHub OIDC) | npm and GitHub, generic |
| owner-signed authorization (Ed25519 over a canonical JSON digest) | built on the generic grant pattern of `@comforge/core`; the release format itself is repository tooling |
| `createGitHubWriter`, `@comforge/ledger` | published APIs the tooling uses, available to your own release tooling |

**How this page is tested.** CI runs the `sh recipe` blocks in a checkout of this repository.
The rehearsal block is run by CI's own job *Release rehearsal (credential-free, all five
packages)* on every pull request, not by the recipe test, because it builds every package.
Nothing here publishes.

## 1. Every shipped change has a reviewed release intent

A change to anything a package ships needs an intent file in `release-intents/`, reviewed with
the change. The planner refuses an ambiguous or unreviewed bump:

```sh recipe
bun run release:plan --package @comforge/ledger --json
```
<!-- recipe-expect: {"json": {"schema": "comforge-release-plan/v1", "package": "@comforge/ledger"}} -->

`status` is `no-release`, `version-pr-due` or `release-ready`; anything else is a refusal with a
stable code (for example `uncovered-change`, `intent-edited`, `version-state-ambiguous`). With an intent
pending, the next step is the version pull request (`bun run release:version-pr --package
@comforge/ledger`), reviewed and merged like any change.

## 2. Rehearse without credentials

```sh
bun run release:rehearse --package @comforge/ledger
```

The rehearsal makes the version commit locally, builds the candidate twice and checks the two
builds are byte-identical, verifies a signed authorization with a synthetic key (accepted;
refused when tampered, signed by another key, expired or bound to another candidate), prepares
the npm package and reads it back from a fake registry. It pushes and publishes nothing.

## 3. Authorize and publish (owner only)

| Step | Who | Command |
|---|---|---|
| sign the exact candidate digest and dispatch `release.yml` | owner, on the owner's machine | `bun run release:approve --package <id>` |
| approve the `npm-<id>` environment | owner, on GitHub | — |
| publish with provenance | `npm-publish-<id>.yml` (Trusted Publishing) | — |
| read back the published tarball and its provenance | anyone | `bun run release:npm-readback --package <id> --commit <sha> --expect-provenance` |

`release.yml` refuses to publish unless the repository variable `COMFORGE_PUBLISHER=comforge`
is set and the previous publisher's retirement is recorded; see
[release governance](../contributing/release-governance.md) and the
[publisher transition](../contributing/release-transition.md).

## Errors

| Refusal | Cause |
|---|---|
| `baseline-unrelated` | the baseline's source commit is not an ancestor of the head |
| `uncovered-change`, `intent-edited`, `intent-invalid` | a shipped change without a reviewed intent, or an intent edited after review |
| rebuild mismatch | the candidate is not reproducible; nothing is authorized |

## Side effects, security, cleanup

- **Writes:** none in steps 1–2. Step 3 pushes one release branch and one tag, and npm
  publishes one immutable version.
- **Security:** the signing key never reaches CI; the authorization binds the workflow path and
  digest, so a changed workflow needs a new authorization.
- **Cleanup:** none. Published npm versions are immutable: a mistake is fixed by a new patch.
