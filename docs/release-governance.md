# Release governance

Each package is versioned independently, tagged `<id>/vX.Y.Z` on its own release branch
`releases/<id>`, and published to npm by that branch's workflow through **npm Trusted
Publishing** with provenance. Released versions are never changed; a correction is a new version.

## The path of a release

| Step | Who | Command / place | Status |
|---|---|---|---|
| 1. Release intent | contributor, in the same PR as the change | `release-intents/<date>-<slug>.json` (package, bump, summary) | published tooling |
| 2. Plan | anyone | `bun run release:plan` — dependency-aware: what changed since each package's baseline (`releases/baseline/<id>`), which bump, in which order | implemented |
| 3. Version PR | maintainer | `bun run release:version-pr` (grouped by `releases/campaigns/*.json` `versionTogether`) | implemented |
| 4. Candidate | CI, no credential | `release.yml` job `candidate`: build twice, reproducibility, disclosure scan, Node import, CI proof for the commit, immutable candidate digest | implemented |
| 5. Authorization | **owner**, offline key | `bun run release:approve` signs exactly that candidate against `release-trust.json` and dispatches the publish run | implemented |
| 6. Release | CI, credential in `comforge-release` | `release.yml` jobs `authorize` + `release`: verify again, rebuild, match the candidate, push `releases/<id>` and the tag | implemented, **not active** |
| 7. npm publish | CI on the tag | `npm-publish-<id>.yml` (`npm-publish.yml` for core), environment `npm-<id>`, Trusted Publishing, staged publish | published |
| 8. Stage approval | **owner** | `npm stage approve` | published |
| 9. Readback | anyone | `bun run release:npm-readback` — integrity, provenance, tag and record match | implemented |
| 10. Record | maintainer | `bun run release:record` — the release record becomes the next planning baseline | implemented |

Campaigns (`releases/campaigns/*.json`, `bun run release:campaign`) order several packages by
dependency and recover from a partial publication: a package that published is read back and
recorded; one that did not is retried from its own candidate.

## Branch protection

**Status: planned** (owner configuration). `.github/rulesets/protect-main.json` is the exact
ruleset for `main`: no deletion or force-push, pull requests with code-owner review, and every
CI job (bound to the GitHub Actions app) required on an up-to-date branch. Until
`bun tooling/verifyRuleset.ts` prints `PASS` against the live repository, CI is advisory, not
the enforcement boundary: a direct push to `main` would not wait for it. With a single
maintainer, code-owner review cannot be given by the pull request's own author; the owner
decides whether to add a second code owner or relax that one parameter, and records it here.

## Single publisher, and the switch-over

Exactly one publisher may be active. Until the owner switches, releases are still published by
the previous source repository's release workflow, and this repository's `release.yml` runs only
its credential-free `candidate` job. The ordered, fail-closed switch-over, what verifies each
step and how to recover from each failure: [Release publisher transition](release-transition.md)
(the only authoritative procedure). CI exercises the pipeline on every pull request without a
credential (`bun run release:rehearse`); a rehearsal is never a publication.

npm Trusted Publishing needs no change as long as each `npm-publish-<id>.yml` keeps its file name
and `npm-<id>` environment on its release branch.

Who can still publish: anyone who can change `release.yml` or `release-trust.json` on `main`.
Keep both owner-reviewed.
