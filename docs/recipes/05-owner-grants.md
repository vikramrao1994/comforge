# Recipe 5 — owner authorization and scoped grants

<!-- recipe: {"world": "github"} -->

In `owner-grant` mode, holding the CLI and a GitHub token is not enough to write: each write
needs a grant signed by a key the owner put in the trusted configuration. A grant is bound to
the repository, ticket, issue, unedited specification digest, base commit, exact head and
branch, with an expiry (at most 7 days) and a number of attempts. `@comforge/cli` 0.5.0
(published).

**operator vs owner-grant.** `{"mode": "operator"}` is policy: whoever runs the CLI with the
token decides. `owner-grant` is enforcement **only if the agent cannot read the private key**:
sign on the owner's machine, never where the agent runs.

**How this page is tested.** CI runs every `sh` block in a throwaway clone of `acme/widgets`
whose GitHub is a local synthetic server. The test plays both roles, owner and agent, in one
shell; in real use the signing steps happen on the owner's machine.

## 1. Owner: create a signing key

```sh recipe
cat > "$WORK/keygen.mjs" <<'EOF'
import { generateKeyPairSync } from "node:crypto";
import { writeFileSync } from "node:fs";
import { keyIdFor } from "@comforge/cli/authority";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const publicKeyPem = publicKey.export({ type: "spki", format: "pem" });
writeFileSync(process.argv[2], privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
console.log(JSON.stringify({ keyId: keyIdFor(publicKeyPem), publicKeyPem, label: "owner" }));
EOF
node "$WORK/keygen.mjs" "$ROOT/owner.key.pem" > "$WORK/trusted-key.json"
cat "$WORK/trusted-key.json"
```

The private key stays in `$ROOT/owner.key.pem`, outside the repository. Only the public key goes
into the configuration.

## 2. Owner: trust the key in the configuration

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
                "authorization": { "mode": "owner-grant", "grantScheme": "acme-grant/v1",
                                   "trustedKeys": [$(cat "$WORK/trusted-key.json")] } }
}
EOF
git add Makefile comforge.config.json && git commit -qm "chore: owner-grant authorization" && git push -q origin main
comforge doctor --json --summary
```
<!-- recipe-expect: {"json": {"ok": true}} -->

A candidate branch cannot add a key or switch the mode: the trusted configuration is read from
the base branch, and `publish` refuses a candidate that edits it (`untrusted-config-change`).

## 3. Owner: sign a governance grant to publish the specification

Specification and review publication have no initiative yet, so their grant is a governance
grant. The dry run prints the unsigned template:

```sh recipe
printf 'Add a widget command.\n' > spec.md
comforge spec publish ACME-501 --title "ACME-501 — widget" --body-file spec.md --json > spec-plan.json
node -e 'const p=require("./spec-plan.json"); require("fs").writeFileSync(process.env.WORK+"/spec-grant.json", JSON.stringify(p.grantTemplate))'
comforge grant sign - --grant "$WORK/spec-grant.json" --key "$ROOT/owner.key.pem" --json > "$WORK/spec-grant.signed.json"
comforge spec publish ACME-501 --title "ACME-501 — widget" --body-file spec.md --grant "$WORK/spec-grant.signed.json" --execute --json > spec.json
ISSUE=$(node -p 'require("./spec.json").issueNumber')
```

## 4. Agent: work and verify (no grant needed: nothing is written to GitHub)

```sh recipe
comforge start ACME-501 --issue "$ISSUE" --json > start.json
CHECKOUT=$(node -p 'require("./start.json").checkout')
( cd "$CHECKOUT" && echo widget > widget.txt && git add . && git commit -qm $'feat: widget\n\nTicket: ACME-501' )
comforge verify ACME-501 --json --summary
```
<!-- recipe-expect: {"json": {"status": "PASS"}} -->

## 5. Agent: a write without a grant is refused

```sh recipe
comforge publish ACME-501 --title "Widget" --execute --json
```
<!-- recipe-expect: {"exit": 1, "json": {"error": "authorization-required"}} -->

## 6. Owner: sign a grant for exactly this head

```sh recipe
comforge grant template ACME-501 --hours 2 --json > "$WORK/grant.json"
comforge grant sign ACME-501 --grant "$WORK/grant.json" --key "$ROOT/owner.key.pem" --json > "$WORK/grant.signed.json"
```

## 7. Agent: publish with the grant

```sh recipe
comforge publish ACME-501 --title "Widget" --grant "$WORK/grant.signed.json" --execute --json --summary
```
<!-- recipe-expect: {"json": {"executed": true, "authorization.mode": "owner-grant"}} -->

A grant is spent one attempt at a time and never refunded. A new commit needs a new grant:
it is bound to the exact head. `security.authorization.revokedGrants` lists grant ids the owner
revoked.

## Errors

| Code | Cause |
|---|---|
| `authorization-required` | no `security.authorization` in the trusted configuration, or (owner-grant) no `--grant` |
| `unauthorized` | a grant that does not match the repository, ticket, issue, specification, head, branch, key or time, or has no attempts left |
| `command-scope-unsupported` (MCP) | cleanup with a grant format that cannot name a command; use a cleanup command grant (`grant template <ID> --command cleanup`) |

## Side effects, security, cleanup

- **Writes:** one issue, one branch push, one pull request. Grants and the private key are files
  you hold; Comforge never stores the private key.
- **The guarantee holds only if the agent cannot read the key.** Keep the key, the token and the
  agent in separate places.
- **Cleanup:** delete `owner.key.pem` from wherever you test; after a merge,
  `comforge grant template <ID> --command cleanup` scopes a grant to cleanup of that pull request.
