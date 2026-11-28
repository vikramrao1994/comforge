# Recipe 7 — embed the lifecycle and host services in your own program

<!-- recipe: {"world": "github"} -->

An application that already has its own server, sessions and storage can call Comforge in
process, without a subprocess or a loopback call:

- **`createLifecycleServices`** (`@comforge/cli`): every lifecycle command as a function
  returning `{ ok: true, value, exit }` or `{ ok: false, error: { code, message, detail, exit } }`,
  with every dependency injected.
- **`createEngineeringHost`** (`@comforge/mcp/host`): exact-commit, complete-or-refuse GitHub
  evidence reads, advisory-review reads and trusted-configuration reads, read-only unless the
  host injects `writes`.

Both are published (`@comforge/cli` 0.5.0, `@comforge/mcp` 0.3.0). The example is TypeScript,
run directly by Node.js ≥ 22.18 (type stripping) or Bun.

**How this page is tested.** CI runs every `sh` block in a throwaway clone of `acme/widgets`
whose GitHub is a local synthetic server; the program's transport points at it through
`COMFORGE_API_ORIGIN`.

## 1. A repository with one delivered pull request

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
printf 'Add a reporter.\n' > spec.md
comforge spec publish ACME-701 --title "ACME-701 — reporter" --body-file spec.md --execute --json > spec.json
ISSUE=$(node -p 'require("./spec.json").issueNumber')
comforge start ACME-701 --issue "$ISSUE" --json > start.json
CHECKOUT=$(node -p 'require("./start.json").checkout')
( cd "$CHECKOUT" && echo reporter > reporter.txt && git add . && git commit -qm $'feat: reporter\n\nTicket: ACME-701' )
comforge verify ACME-701 --json --summary
comforge publish ACME-701 --title "Reporter" --execute --json > published.json
PR=$(node -p 'require("./published.json").pullRequest.number')
```

## 2. The embedding program

```sh recipe
cat > "$WORK/host.ts" <<'EOF'
import { execFileSync } from "node:child_process";
import path from "node:path";
import { createLifecycleServices, defaultRuntime } from "@comforge/cli";
import { createEngineeringHost, fetchTransport } from "@comforge/mcp/host";

const root = process.cwd();
const commonDir = path.resolve(root, execFileSync("git", ["rev-parse", "--git-common-dir"], { encoding: "utf8" }).trim());

// Trusted host wiring: only this program supplies the runtime and the repository.
const lifecycle = createLifecycleServices({ runtime: { ...defaultRuntime(), cwd: root }, repository: { root, commonDir } });
const status = await lifecycle.status({ id: "ACME-701" });
if (!status.ok) throw new Error(`${status.error.code}: ${status.error.message}`);

// Read-only host services: the host owns the token and the transport.
const host = createEngineeringHost({
  repository: { owner: "acme", name: "widgets" },
  transport: fetchTransport({ token: () => process.env.ACME_TOKEN ?? "", apiOrigin: process.env.COMFORGE_API_ORIGIN }),
});
const pr = await host.evidence.getPullRequest(Number(process.argv[2]));

console.log(JSON.stringify({
  initiative: status.value,
  pullRequest: { number: pr.number, state: pr.state, head: pr.head.sha },
}));
EOF
node "$WORK/host.ts" "$PR"
```
<!-- recipe-expect: {"json": {"pullRequest.state": "open", "initiative.initiative": "ACME-701", "initiative.stage": "published"}} -->

**Expected:** one JSON line with the initiative's local record and the pull request read from
GitHub at its exact head.

## What the host decides, and what callers never can

| Injected by the host | Never taken from a caller |
|---|---|
| `runtime`, `repository`, credentials, stores, `signal` (`createLifecycleServices`) | a request's ids and titles are parsed like command-line input; an `authorized` field is removed |
| `repository`, `transport`, optional `writes` (`createEngineeringHost`) | without `writes`, every write refuses with `capability-denied` before a request exists |

Authorization still comes from the trusted configuration on the base branch. See
[host services](../concepts/host-services.md) and the
[API inventory](../reference/inventory/api.md).

## Errors, side effects, cleanup

| Code | Cause |
|---|---|
| `not-found` | no local state for that initiative, or no such pull request |
| `HostServiceError` `capability-denied` | a write on a read-only host |

- **Writes:** step 1 publishes one pull request; the program itself only reads.
- **Security:** the token is read per call from the host's own provider and never returned.
- **Cleanup:** none for the program; close or merge the pull request as usual.
