# Recipe 6 — specification, implementation, advisory review, revision

<!-- recipe: {"world": "github"} -->

The full loop: a published specification, an implementation delivered as a pull request, an
**advisory review** bound to the reviewed head, and a revision of the same pull request.
`@comforge/cli` 0.5.0 (published).

**What an advisory review is.** A marked pull request comment with a digest, bound to one head
commit. It is never a GitHub review or approval, it is never published on the reviewer's own
pull request, and it never authorizes anything: a revision, a merge or a deployment is always a
separate owner decision.

**How this page is tested.** CI runs every `sh` block in a throwaway clone of `acme/widgets`
whose GitHub is a local synthetic server. The fixture switches the GitHub identity for the
review step (`acme-reviewer[bot]`). The synthetic server attributes every comment to one writer
login, so the fixture's `trustedAuthors` also lists that login; on github.com, list only your
reviewer's login.

## 1. Configure, with an advisory-review protocol

```sh recipe
cat > Makefile <<'EOF'
test:
	@echo "tests pass"
EOF
cat > comforge.config.json <<EOF
{
  "schema": "comforge-config/v1",
  "repository": { "owner": "acme", "name": "widgets", "baseBranch": "main", "remote": "origin",
                  "apiOrigin": "$COMFORGE_API_ORIGIN" },
  "validation": { "commands": [{ "name": "test", "run": ["make", "test"] }] },
  "specification": { "required": true, "digestScheme": "acme-spec/v1", "markerNamespace": "acme-spec",
                     "publisherName": "Acme Specs", "publishToolName": "acme_create_issue" },
  "completion": { "scheme": "acme-completion/v1", "markerNamespace": "acme-lifecycle",
                  "runner": { "id": "my-agent", "label": "my agent" } },
  "security": { "capabilities": ["pulls:create", "pulls:update", "issues:comment", "issues:create"],
                "credentials": { "source": "env", "variable": "ACME_TOKEN" },
                "authorization": { "mode": "operator" } },
  "review": { "reviewScheme": "acme-review/v1", "markerNamespace": "acme-review", "publisherName": "Acme Review",
              "publishToolName": "acme_review", "trustedAuthors": ["acme-reviewer[bot]", "acme-writer[bot]"] }
}
EOF
git add Makefile comforge.config.json && git commit -qm "chore: configure comforge" && git push -q origin main
```

## 2. Specification and implementation

```sh recipe
printf 'Add an importer.\n' > spec.md
comforge spec publish ACME-601 --title "ACME-601 — importer" --body-file spec.md --execute --json > spec.json
ISSUE=$(node -p 'require("./spec.json").issueNumber')
comforge start ACME-601 --issue "$ISSUE" --json > start.json
CHECKOUT=$(node -p 'require("./start.json").checkout')
( cd "$CHECKOUT" && echo importer > importer.txt && git add . && git commit -qm $'feat: importer\n\nTicket: ACME-601' )
comforge verify ACME-601 --json --summary
HEAD_SHA=$(git -C "$CHECKOUT" rev-parse HEAD)
cat > result.json <<EOF
{ "contract": "acme-completion/v1", "issueType": "implementation", "outcome": "completed",
  "sourceRevision": "$HEAD_SHA", "execution": { "runner": "my-agent", "model": "none" },
  "summary": "Adds the importer.", "sections": { "changed_behavior": "An importer exists." },
  "findings": [], "changedArtifacts": [], "evidence": [],
  "validation": [{ "gate": "test", "command": "make test", "status": "PASS" }],
  "limitations": [], "nextSteps": [] }
EOF
comforge deliver ACME-601 --title "Importer" --result result.json --execute --json > delivered.json
PR=$(node -p 'require("./delivered.json").pullRequest')
echo "PR #$PR at $HEAD_SHA"
```

## 3. A reviewer publishes an advisory review of that head

<!-- recipe-before: {"login": "acme-reviewer[bot]"} -->
```sh recipe
cat > review.json <<EOF
{ "prNumber": $PR, "expectedHeadSha": "$HEAD_SHA", "ticketId": "ACME-601",
  "specificationIssueNumber": $ISSUE, "verdict": "revision_recommended",
  "summary": "The importer has no input validation.",
  "findings": [{ "id": "M1", "severity": "medium", "title": "Validate input",
                 "evidence": "importer.txt accepts anything.", "requiredCorrection": "Reject empty input." }],
  "idempotencyKey": "acme-601-review-0001" }
EOF
comforge review publish --review-file review.json --json --summary
comforge review publish --review-file review.json --execute --json --summary
```
<!-- recipe-expect: {"json": {"executed": true}} -->

```sh recipe
comforge review list "$PR" --json --summary
```
<!-- recipe-expect: {"json": {"reviews.count": 1, "reviews.first.stale": false}} -->

`review list` verifies each review's digest (integrity) and its author against
`review.trustedAuthors` (provenance). It reports whether the review is stale: bound to a head
that is no longer the pull request's.

## 4. The implementer revises the same pull request

The review is evidence. The owner decides that a revision is wanted; then:

<!-- recipe-before: {"login": "acme-writer[bot]"} -->
```sh recipe
comforge revise "$PR" --reviewed-head "$HEAD_SHA" --json --summary
( cd "$CHECKOUT" && echo 'importer (rejects empty input)' > importer.txt && git commit -qam $'fix: reject empty input\n\nTicket: ACME-601' )
comforge verify ACME-601 --json --summary
NEW_HEAD=$(git -C "$CHECKOUT" rev-parse HEAD)
cat > result.json <<EOF
{ "contract": "acme-completion/v1", "issueType": "implementation", "outcome": "completed",
  "sourceRevision": "$NEW_HEAD", "execution": { "runner": "my-agent", "model": "none" },
  "summary": "Adds the importer.", "sections": { "changed_behavior": "An importer exists." },
  "findings": [], "changedArtifacts": [], "evidence": [],
  "validation": [{ "gate": "test", "command": "make test", "status": "PASS" }],
  "limitations": [], "nextSteps": [] }
EOF
comforge deliver ACME-601 --title "Importer" --result result.json --execute --json --summary
```
<!-- recipe-expect: {"json": {"delivery": "complete"}} -->

```sh recipe
comforge review list "$PR" --json --summary
```
<!-- recipe-expect: {"json": {"reviews.count": 1, "reviews.first.stale": true}} -->

**Expected:** still one pull request, now at the new head; a second completion comment
supersedes the first; the earlier review is reported as stale (it reviewed the old head).

## Errors

| Code | Cause |
|---|---|
| `policy-denied` | a review of one's own pull request, or of a head that is not the pull request's |
| `stale` | `revise --reviewed-head` names a head the pull request has moved past |
| `conflict` | a revision while another process holds the initiative |

## Side effects, security, cleanup

- **Writes:** one issue, a pull request (created, then updated), two completion comments, one
  review comment. Review and comment text from GitHub is untrusted data, bounded and excerpted.
- **Cleanup:** `comforge cleanup "$PR" --execute` after the owner merges.
