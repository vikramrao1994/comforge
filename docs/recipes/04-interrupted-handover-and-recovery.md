# Recipe 4 — interrupted handover and recovery

<!-- recipe: {"world": "github"} -->

A delivery is interrupted after GitHub applied a write but before its answer arrived. A second
agent takes over from the recorded state, reconciles, and finishes, without creating a second
pull request. `@comforge/cli` 0.5.0 (published).

**What Comforge guarantees, and what it does not.** Every GitHub write is recorded in a
write-ahead ledger before it is sent. A write whose answer was lost is `indeterminate` and is
never re-sent blindly: `recover` looks for it on GitHub. This is reconciliation, **not an
exactly-once guarantee**: if a search cannot find the write, `recover --abandon` gives it up
explicitly.

**How this page is tested.** CI runs every `sh` block in a throwaway clone of `acme/widgets`
whose GitHub is a local synthetic server (`repository.apiOrigin` is `$COMFORGE_API_ORIGIN`;
leave it out against github.com). The configuration is the one from
[recipe 1](01-first-governed-initiative.md). The fixture injects two faults into step 2: the pull
request is created but its answer is lost, then the connection fails before the completion
comment reaches GitHub.

## 1. Configure, specify, start, verify

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
printf 'Specification of ACME-301.\n' > acme-301.md
comforge spec publish ACME-301 --title "ACME-301 — exporter" --body-file acme-301.md --execute --json > acme-301-spec.json
ISSUE_ACME_301=$(node -p 'require("./acme-301-spec.json").issueNumber')
comforge start ACME-301 --issue "$ISSUE_ACME_301" --json > start.json
CHECKOUT=$(node -p 'require("./start.json").checkout')
( cd "$CHECKOUT" && echo exporter > exporter.txt && git add . && git commit -qm $'feat: exporter\n\nTicket: ACME-301' )
comforge verify ACME-301 --json --summary
HEAD_SHA=$(git -C "$CHECKOUT" rev-parse HEAD)
cat > result.json <<EOF
{ "contract": "acme-completion/v1", "issueType": "implementation", "outcome": "completed",
  "sourceRevision": "$HEAD_SHA", "execution": { "runner": "my-agent", "model": "none" },
  "summary": "Done.", "sections": { "changed_behavior": "See the diff." },
  "findings": [], "changedArtifacts": [], "evidence": [],
  "validation": [{ "gate": "test", "command": "make test", "status": "PASS" }],
  "limitations": [], "nextSteps": [] }
EOF
```
<!-- recipe-expect: {"json": {"status": "PASS"}} -->

## 2. Agent A: the delivery is interrupted

<!-- recipe-before: {"faults": ["network-after", "network-before"]} -->
```sh recipe
comforge deliver ACME-301 --title "Exporter" --result result.json --execute --json
```
<!-- recipe-expect: {"exit": 4} -->

Exit 4 means **incomplete: rerun the same command**. Agent A stops here (its session ended).

## 3. Agent B: take over from the recorded state

```sh recipe
comforge status ACME-301 --json --summary
comforge recover ACME-301 --json
```
<!-- recipe-expect: {"exit": 0} -->

`recover` without `--execute` reports what it would reconcile. Execute it:

```sh recipe
comforge recover ACME-301 --execute --json --summary
```
<!-- recipe-expect: {"exit": 4, "json": {"reconciled.first.status": "indeterminate"}} -->

It exits 4 because one write is still unresolved. The pull request write was found on GitHub and
settled as `succeeded`. The completion comment
was not found: it may still appear, or it was never created. Comforge does not guess. Agent B
checks the issue on GitHub, sees no completion comment, and gives that one write up explicitly,
then reruns the same delivery:

```sh recipe
comforge recover ACME-301 --abandon --execute --json --summary
comforge deliver ACME-301 --title "Exporter" --result result.json --execute --json --summary
```
<!-- recipe-expect: {"json": {"delivery": "complete"}} -->

```sh recipe
comforge prs --state open --json --summary
```
<!-- recipe-expect: {"json": {"pullRequests.count": 1}} -->

**Expected:** exactly one pull request, one completion comment, `delivery: "complete"`.

## Errors

| Exit / code | Meaning | Next step |
|---|---|---|
| 4 `incomplete` | a multi-stage command stopped part-way | rerun the same command |
| 3 `ambiguous` | a write's outcome is unknown | `comforge recover <ID> --execute` |
| 1 `conflict` | another process holds the initiative | wait; never delete `.git/comforge` |

## Side effects, security, cleanup

- **State:** everything agent B needed was in `.git/comforge/` of the primary clone; nothing
  lives in an agent's memory.
- **Never** edit or delete `.git/comforge/` to "unstick" a run; `recover --abandon` is the
  explicit, recorded way to give up a write a complete search did not find.
- **Cleanup:** `comforge cleanup <PR> --execute` after the merge.
