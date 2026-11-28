# Release publisher transition

**Status: planned** (owner actions; nothing here has been executed). This page is the one
authoritative procedure for moving npm publication of the five `@comforge` packages from the
previous external publisher to this repository's `release.yml`. Every step is an owner action;
an agent may prepare and verify, never perform a credential, environment, permission or
publication change.

## Invariant

**Never two active publishers.** At every point exactly one of these holds:

- the previous external publisher is active, and this repository's `release.yml` cannot mint a
  credential (`COMFORGE_PUBLISHER` unset, or `COMFORGE_PREVIOUS_PUBLISHER_RETIRED` unset); or
- the previous external publisher is disabled and holds no credential for this repository, and
  `release.yml` may publish.

`release.yml` enforces its half: jobs `authorize` and `release` need the repository variable
`COMFORGE_PUBLISHER=comforge`, and job `release` refuses, before any credential exists, unless
the `comforge-release` environment variable `COMFORGE_PREVIOUS_PUBLISHER_RETIRED` holds the
date (`YYYY-MM-DD`, not in the future) the previous publisher was retired. The owner enforces
the other half by the order below: the previous publisher is retired and verified **before**
either variable is set.

## Procedure

| # | Step | Who | Verify before continuing | If it fails |
|---|---|---|---|---|
| 1 | Credential-free rehearsal: `bun run release:rehearse` locally and the CI job *Release rehearsal* on `main`; optionally dispatch `release.yml` as a dry run (publish unticked). `COMFORGE_PUBLISHER` stays **unset**. | owner (dispatch) | every package `PASS`; the dry run shows a candidate per package and pushes nothing | fix on a PR; nothing to undo |
| 2 | Configure `protect-main` from `.github/rulesets/protect-main.json` | owner | `bun tooling/verifyRuleset.ts` prints `PASS` | adjust the ruleset; no publication is possible yet |
| 3 | Disable the previous external publisher's release workflow and revoke or delete the credential it uses to push to this repository | owner | the workflow shows *disabled*; the credential no longer authenticates against this repository (a push or `GET /repos/...` with it fails) | re-run the step; do not continue while either still works |
| 4 | Create environment `comforge-release`, restricted to `main`, holding the push credential (GitHub App `COMFORGE_APP_ID` + `COMFORGE_APP_PRIVATE_KEY`, or fine-grained `COMFORGE_RELEASE_TOKEN` limited to this repository, contents write) | owner | the environment lists only `main` as a deployment branch | delete the environment and start the step again |
| 5 | Make the owner the required reviewer of environment `comforge-release` (Settings → Environments) | owner | the environment lists the owner under *Required reviewers* | remove the reviewer; nothing published yet |
| 6 | Set `COMFORGE_PREVIOUS_PUBLISHER_RETIRED` (environment variable of `comforge-release`) to step 3's date, then the repository variable `COMFORGE_PUBLISHER=comforge` | owner | both visible in settings; the previous publisher still disabled | unset `COMFORGE_PUBLISHER`; the state is back to step 5 |
| 7 | One attended release: merge a version PR (or `bun run release:dispatch package=<id>`); when CI is green `release.yml` builds the candidate and waits; **Approve** its `comforge-release` environment | owner | the run pushes only `releases/<id>` and its tag; the npm workflow publishes directly | see recovery below |
| 8 | Read back: `bun run release:npm-readback --package <id> --commit <release commit> --expect-provenance`, then `bun run release:record` | owner | readback `PASS`; the record committed through a PR | a readback failure is never "probably fine": stop and investigate before any further release |

## Recovery

- **Step 7 fails before the tag push** (authorization refused, rebuild mismatch, credential
  error): nothing was published. Unset `COMFORGE_PUBLISHER`, fix on a PR, return to step 6.
- **Step 7 pushed the tag but npm did not publish**: the release branch and tag are immutable.
  Re-run the package's npm workflow for that tag after fixing its cause; never re-tag.
- **npm published but readback fails**: npm versions are immutable. Deprecate nothing on your
  own; record the finding, publish a corrected patch through the same procedure.
- **Going back to the previous publisher**: unset `COMFORGE_PUBLISHER` **first**, then revoke
  the `comforge-release` credential, then re-enable the previous publisher. Never re-enable the
  previous publisher while `COMFORGE_PUBLISHER=comforge`.

## What an agent may do

Prepare and verify: run the rehearsal, read rulesets and workflow states (read-only), draft the
ruleset or trust-file change as a PR. It never sets variables, environments, secrets, rulesets
or npm settings, never dispatches a publishing run, and never signs.
