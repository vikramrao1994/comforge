# Recipe 3 — parallel initiatives

<!-- recipe: {"world": "github"} -->

Two agents work on two tickets at once from the same primary clone. Each initiative has its
own branch, checkout, state record and write identities, so neither can publish the other's
work. `@comforge/cli` 0.5.0 (published).

**Prerequisites:** a configured repository ([recipe 1](01-first-governed-initiative.md),
steps 1–2) and two published specifications.

**How this page is tested.** CI runs every `sh` block in a throwaway clone of `acme/widgets`
whose GitHub is a local synthetic server (`repository.apiOrigin` is `$COMFORGE_API_ORIGIN`;
leave it out against github.com). The configuration is the one from
[recipe 1](01-first-governed-initiative.md).

## 1. Configure and publish two specifications

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
                "authorization": { "mode": "operator" } }
}
EOF
git add Makefile comforge.config.json && git commit -qm "chore: configure comforge" && git push -q origin main
```

```sh recipe
printf 'Specification of ACME-201.\n' > acme-201.md
comforge spec publish ACME-201 --title "ACME-201 — parser" --body-file acme-201.md --execute --json > acme-201-spec.json
ISSUE_ACME_201=$(node -p 'require("./acme-201-spec.json").issueNumber')
printf 'Specification of ACME-202.\n' > acme-202.md
comforge spec publish ACME-202 --title "ACME-202 — formatter" --body-file acme-202.md --execute --json > acme-202-spec.json
ISSUE_ACME_202=$(node -p 'require("./acme-202-spec.json").issueNumber')
echo "$ISSUE_ACME_201 $ISSUE_ACME_202"
```

## 2. Start both

```sh recipe
comforge start ACME-201 --issue "$ISSUE_ACME_201" --json > a.json
comforge start ACME-202 --issue "$ISSUE_ACME_202" --json > b.json
A=$(node -p 'require("./a.json").checkout'); B=$(node -p 'require("./b.json").checkout')
echo "$A"; echo "$B"
```

Each checkout is a separate clone (`../widgets-agents/acme-201`, `…/acme-202`) on its own branch.
Give each agent its own checkout; run lifecycle commands from the primary clone.

## 3. Work and verify each independently

```sh recipe
( cd "$A" && echo parser > parser.txt && git add . && git commit -qm $'feat: parser\n\nTicket: ACME-201' )
( cd "$B" && echo formatter > formatter.txt && git add . && git commit -qm $'feat: formatter\n\nTicket: ACME-202' )
comforge verify ACME-201 --json --summary && comforge verify ACME-202 --json --summary
```
<!-- recipe-expect: {"json": {"status": "PASS"}} -->

```sh recipe
comforge status --json --summary
```
<!-- recipe-expect: {"json": {"initiatives.count": 2}} -->

## 4. Deliver both

```sh recipe
HEAD_A=$(git -C "$A" rev-parse HEAD)
cat > result.json <<EOF
{ "contract": "acme-completion/v1", "issueType": "implementation", "outcome": "completed",
  "sourceRevision": "$HEAD_A", "execution": { "runner": "my-agent", "model": "none" },
  "summary": "Done.", "sections": { "changed_behavior": "See the diff." },
  "findings": [], "changedArtifacts": [], "evidence": [],
  "validation": [{ "gate": "test", "command": "make test", "status": "PASS" }],
  "limitations": [], "nextSteps": [] }
EOF
comforge deliver ACME-201 --title "Parser" --result result.json --execute --json --summary
HEAD_B=$(git -C "$B" rev-parse HEAD)
cat > result.json <<EOF
{ "contract": "acme-completion/v1", "issueType": "implementation", "outcome": "completed",
  "sourceRevision": "$HEAD_B", "execution": { "runner": "my-agent", "model": "none" },
  "summary": "Done.", "sections": { "changed_behavior": "See the diff." },
  "findings": [], "changedArtifacts": [], "evidence": [],
  "validation": [{ "gate": "test", "command": "make test", "status": "PASS" }],
  "limitations": [], "nextSteps": [] }
EOF
comforge deliver ACME-202 --title "Formatter" --result result.json --execute --json --summary
```
<!-- recipe-expect: {"json": {"delivery": "complete"}} -->

**Expected:** two pull requests, `agent/acme-201` and `agent/acme-202`, each with its own
completion comment.

## Errors

| Code | Cause |
|---|---|
| `conflict` | a second `start` of the same ticket while one is active; use `revise` or a phase (`ACME-201.b`) |
| `dirty-checkout` | uncommitted changes in a checkout at `verify` |
| `policy-denied` | a commit without the `Ticket:` trailer of its own initiative |

## Side effects, security, cleanup

- **Writes:** two branches, two pull requests, two comments, and two state records in
  `.git/comforge/`.
- **Isolation is per checkout, not per process.** Two agents on one machine still run as the same
  user; isolation from each other's files is the host's job (containers, separate users).
- **Cleanup:** `comforge cleanup <PR> --execute` for each pull request after its merge.
