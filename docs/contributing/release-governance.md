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
| 4. Candidate | CI, no credential | `release.yml` starts when CI is green for a push to `main` (or `bun run release:dispatch package=<id>`); job `select` asks the planner which packages are release-ready, job `candidate` builds each twice: reproducibility, disclosure scan, Node import, CI proof for the commit, immutable candidate digest, shown in the run summary | implemented |
| 5. Approval | **owner**, one click on GitHub | **Approve** the run's `comforge-release` environment (its required reviewer is the owner) after reviewing the candidate summary | implemented |
| 6. Release | CI, credential in `comforge-release` | `release.yml` job `release`: reads the owner's approval of this run back from GitHub (`tooling/release/environmentApproval.ts`), rebuilds, matches this run's candidate, pushes `releases/<id>` and the tag | implemented |
| 7. npm publish | CI on the tag | `npm-publish-<id>.yml` (`npm-publish.yml` for core), environment `npm-<id>`, Trusted Publishing, published directly with provenance | published |
| 8. Readback | anyone | `bun run release:npm-readback` — integrity, provenance, tag and record match | implemented |
| 9. Record | maintainer | `bun run release:record` — the release record becomes the next planning baseline | implemented |

Campaigns (`releases/campaigns/*.json`, `bun run release:campaign`) order several packages by
dependency and recover from a partial publication: a package that published is read back and
recorded; one that did not is retried from its own candidate.

## Branch protection

**Status: enforced** (applied 2026-11-27 at the owner's request). `.github/rulesets/protect-main.json`
is the exact ruleset for `main`: no deletion or force-push, every change through a pull request,
and every CI job (bound to the GitHub Actions app) required on an up-to-date branch, with no
bypass. `bun tooling/verifyRuleset.ts` compares the live ruleset with the file; CI is the
enforcement boundary only while it prints `PASS`.

Code-owner review is **off**: with a single maintainer, GitHub never counts a pull request
author's own approval, so requiring it would block every owner change to `.github/`,
`tooling/release/` and the other owned paths. `CODEOWNERS` still requests the review. Turn
`require_code_owner_review` on in the file and the ruleset together once a second code owner
exists.

## Single publisher, and the switch-over

Exactly one publisher may be active. Until the owner switches, releases are still published by
the previous source repository's release workflow, and this repository's `release.yml` runs only
its credential-free `candidate` job. The ordered, fail-closed switch-over, what verifies each
step and how to recover from each failure: [Release publisher transition](release-transition.md)
(the only authoritative procedure). CI exercises the pipeline on every pull request without a
credential (`bun run release:rehearse`); a rehearsal is never a publication.

npm Trusted Publishing needs no change as long as each `npm-publish-<id>.yml` keeps its file name
and `npm-<id>` environment on its release branch.

Who can publish: whoever can approve the `comforge-release` environment and merge to `main`, and
anyone who can change `release.yml` or `tooling/release/` on `main`. Keep the environment's
required reviewer set to the owner, and those files owner-reviewed. The `npm-<id>` environments
need no required reviewer: the release run's approval is the gate, and a second click adds none.
