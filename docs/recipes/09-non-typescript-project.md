# Recipe 9 — a non-TypeScript project (Python)

<!-- recipe: {"world": "github"} -->

Comforge governs any Git repository: validation and provisioning are argument vectors you
configure, never a JavaScript toolchain. This recipe governs a Python package with the standard
library's `unittest`, and shows a failing validation blocking publication. The `comforge`
executable itself needs Node.js or Bun on the machine. `@comforge/cli` 0.5.0 (published).

**Prerequisites:** Python 3 on `PATH`.

**How this page is tested.** CI runs every `sh` block in a throwaway clone of `acme/widgets`
whose GitHub is a local synthetic server (`repository.apiOrigin` is `$COMFORGE_API_ORIGIN`;
leave it out against github.com).

## 1. A Python project and its configuration

```sh recipe
mkdir -p widgets tests
touch tests/__init__.py
printf '__pycache__/\n' > .gitignore
cat > widgets/__init__.py <<'EOF'
def widget():
    return "widget"
EOF
cat > tests/test_widgets.py <<'EOF'
import unittest
from widgets import widget

class WidgetTest(unittest.TestCase):
    def test_widget(self):
        self.assertEqual(widget(), "widget")
EOF
cat > comforge.config.json <<EOF
{
  "schema": "comforge-config/v1",
  "repository": { "owner": "acme", "name": "widgets", "baseBranch": "main", "remote": "origin",
                  "apiOrigin": "$COMFORGE_API_ORIGIN" },
  "validation": { "commands": [{ "name": "unittest", "run": ["python3", "-m", "unittest", "discover", "-s", "tests", "-t", "."] }] },
  "specification": { "required": true, "digestScheme": "acme-spec/v1", "markerNamespace": "acme-spec",
                     "publisherName": "Acme Specs", "publishToolName": "acme_create_issue" },
  "completion": { "scheme": "acme-completion/v1", "markerNamespace": "acme-lifecycle",
                  "runner": { "id": "my-agent", "label": "my agent" } },
  "security": { "capabilities": ["pulls:create", "pulls:update", "issues:comment", "issues:create"],
                "credentials": { "source": "env", "variable": "ACME_TOKEN" },
                "authorization": { "mode": "operator" } }
}
EOF
git add . && git commit -qm "chore: python project governed by comforge" && git push -q origin main
comforge doctor --json --summary
```
<!-- recipe-expect: {"json": {"ok": true}} -->

## 2. A change that breaks a test is refused

```sh recipe
printf 'Specification of ACME-901.\n' > acme-901.md
comforge spec publish ACME-901 --title "ACME-901 — louder widget" --body-file acme-901.md --execute --json > acme-901-spec.json
ISSUE_ACME_901=$(node -p 'require("./acme-901-spec.json").issueNumber')
comforge start ACME-901 --issue "$ISSUE_ACME_901" --json > start.json
CHECKOUT=$(node -p 'require("./start.json").checkout')
( cd "$CHECKOUT" && sed -i.bak 's/"widget"/"WIDGET"/' widgets/__init__.py && rm widgets/__init__.py.bak \
  && git commit -qam $'feat: louder widget\n\nTicket: ACME-901' )
comforge verify ACME-901 --json --summary
```
<!-- recipe-expect: {"exit": 1, "json": {"status": "FAIL"}} -->

```sh recipe
HEAD_SHA=$(git -C "$CHECKOUT" rev-parse HEAD)
comforge publish ACME-901 --title "Louder widget" --execute --json
```
<!-- recipe-expect: {"exit": 1, "json": {"error": "validation-failed"}} -->

Only a `PASS` on the exact head publishes.

## 3. Fix, verify, publish

```sh recipe
( cd "$CHECKOUT" && sed -i.bak 's/"widget")/"WIDGET")/' tests/test_widgets.py && rm tests/test_widgets.py.bak \
  && git commit -qam $'test: expect the louder widget\n\nTicket: ACME-901' )
comforge verify ACME-901 --json --summary
```
<!-- recipe-expect: {"json": {"status": "PASS"}} -->

```sh recipe
comforge publish ACME-901 --title "Louder widget" --execute --json --summary
```

## Errors, side effects, cleanup

| Code | Cause |
|---|---|
| `validation-failed` / `FAIL` | a configured command exited non-zero |
| `dirty-checkout` | files the validation wrote (`__pycache__/`) are not ignored: add them to `.gitignore` |
| `UNAVAILABLE` (exit 3) | the environment could not validate (for example `python3` missing) |

- **Writes:** one issue, one branch push, one pull request. Validation runs your project's code
  as you: run untrusted work in a container or VM.
- **Cleanup:** `comforge cleanup <PR> --execute` after the merge.
