# Recipe 1 — your first governed initiative

<!-- recipe: {"world": "github"} -->

One ticket from a published specification to a pull request with a completion record, with
`@comforge/cli` 0.5.0 (published). About ten commands.

**Prerequisites**
- A GitHub repository you can write to, its clone as the current directory, Node.js ≥ 22.18 or
  Bun ≥ 1.4, Git ≥ 2.30, and `npm install --save-dev --save-exact @comforge/cli`.
- A fine-grained token for that one repository (Contents, Pull requests and Issues: read and
  write) in an environment variable. The recipe calls it `ACME_TOKEN`.

**How this page is tested.** CI runs every `sh` block below in a throwaway clone whose GitHub
is a local synthetic server, so `repository.apiOrigin` is set to `$COMFORGE_API_ORIGIN`. Against
github.com, leave `apiOrigin` out. The synthetic repository is `acme/widgets`.

## 1. Configure

`comforge init` previews a configuration detected from the repository; `--write` writes it. This
recipe writes a complete one instead, so every setting is visible:

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
comforge doctor --json
```
<!-- recipe-expect: {"json": {"ok": true}} -->

The configuration is trusted only once it is on the base branch: every command reads it from
there, never from your working tree. `"authorization": {"mode": "operator"}` means whoever runs
the CLI with the token decides each write; see [recipe 5](05-owner-grants.md) for owner-signed
grants.

## 2. Publish the specification

Work starts from a specification issue whose body carries a digest, so later edits are detected.

```sh recipe
cat > spec.md <<'EOF'
Add a `widget` command that prints "widget".
EOF
comforge spec publish ACME-101 --title "ACME-101 — widget command" --body-file spec.md --json
```
<!-- recipe-expect: {"json": {"executed": false}} -->

That was a dry run. Every command that writes to GitHub needs `--execute`:

```sh recipe
comforge spec publish ACME-101 --title "ACME-101 — widget command" --body-file spec.md --execute --json | tee spec.json
ISSUE=$(node -p 'require("./spec.json").issueNumber')
```
<!-- recipe-expect: {"json": {"executed": true}} -->

## 3. Start, work, verify

```sh recipe
comforge start ACME-101 --issue "$ISSUE" --json > start.json
CHECKOUT=$(node -p 'require("./start.json").checkout')
( cd "$CHECKOUT"
  printf 'widget:\n\t@echo widget\n' >> Makefile
  git add Makefile && git commit -qm $'feat: widget command\n\nTicket: ACME-101' )
comforge verify ACME-101 --json
```
<!-- recipe-expect: {"json": {"status": "PASS"}} -->

`start` verified the issue's specification digest and cloned an isolated checkout on
`agent/acme-101` next to your repository. The work happens in that checkout; every commit
carries the `Ticket:` trailer. Lifecycle commands run from your primary clone, which holds the
local state. `verify` ran the trusted validation commands on the exact committed head.

## 4. Deliver

The completion result is a JSON record of what was done, checked against the specification:

```sh recipe
HEAD_SHA=$(git -C "$CHECKOUT" rev-parse HEAD)
cat > result.json <<EOF
{ "contract": "acme-completion/v1", "issueType": "implementation", "outcome": "completed",
  "sourceRevision": "$HEAD_SHA", "execution": { "runner": "my-agent", "model": "none" },
  "summary": "Adds the widget command.", "sections": { "changed_behavior": "make widget prints widget." },
  "findings": [], "changedArtifacts": ["Makefile"], "evidence": [],
  "validation": [{ "gate": "test", "command": "make test", "status": "PASS" }],
  "limitations": [], "nextSteps": [] }
EOF
comforge deliver ACME-101 --title "Widget command" --result result.json --json
```
<!-- recipe-expect: {"exit": 0} -->

The dry run printed the plan: push, pull request, completion comment. Execute it:

```sh recipe
comforge deliver ACME-101 --title "Widget command" --result result.json --execute --json
```
<!-- recipe-expect: {"json": {"delivery": "complete"}} -->

```sh recipe
comforge status ACME-101 --json --summary
```

**Expected:** one pull request from `agent/acme-101`, one completion comment on the specification issue, and
`delivery: "complete"`. Comforge never merges: review and merge on GitHub, then clean up.

## Errors you may meet

| Code | Cause | Fix |
|---|---|---|
| `config-missing` | the configuration is not on the base branch | commit and push it first |
| `specification-invalid` | the issue body was edited after publication | publish a new specification |
| `validation-missing` | `verify` has not passed on this exact head | run `comforge verify` again |
| `credential-missing` | `ACME_TOKEN` is unset | export it where GitHub commands run |

## Side effects and cleanup

- **Writes:** one issue, one branch push, one pull request, one comment; local state in
  `.git/comforge/`; a checkout in `../<repository>-agents/acme-101`.
- **After the merge:** `comforge cleanup <PR> --execute` removes the checkout and closes the
  local record.
- **Security:** the token is read per process and never written to state or printed.
