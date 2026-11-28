# Configuration

`comforge.config.json` at the repository root, committed to the base branch. Status: published
(`comforge-config/v1`, `@comforge/cli` 0.5.0). `comforge schema config` prints the JSON Schema;
the generated [section and key inventory](inventory/configuration.md) is reconciled with it in
CI; the [example](#example) below is complete. Unknown keys
and unknown schema versions are refused. Commands are argument vectors, never shell strings.

| Section | Required | Decides |
|---|---|---|
| `schema` | yes | `"comforge-config/v1"` |
| `repository` | yes | `owner`, `name`, `baseBranch`, `remote`; `apiOrigin` (GitHub Enterprise or a test server) and `webOrigin` (the web origin links point at, default `https://github.com`) |
| `tickets` | — | the ticket id `pattern` and the agent `branchPrefix` (default `agent/`) |
| `checkout` | — | `parent` directory for isolated checkouts and the `provision` commands run in each |
| `validation` | yes | the trusted `commands` `verify` runs, and `timeoutSeconds` |
| `evidence` | — | `reportDir`, where an initiative's committed evidence lives |
| `commits` | — | the commit `trailer` every initiative commit carries (default `Ticket`; `null` to not require one) |
| `specification` | — | `required`, and the protocol identity: `digestScheme`, `markerNamespace`, `publisherName`, `publishToolName` |
| `completion` | — | the completion record `scheme`, `markerNamespace`, `runner` identity and `publishCommand` |
| `context` | — | the routing `manifest` `comforge context` reads |
| `state` | — | `writeLedgerDirectory` and `legacy` (an earlier lifecycle to migrate from) |
| `lifecycle` | — | `remotePreflight` (refuse an existing branch or PR at start), `phaseRequiresCleanParent` |
| `verification` | — | `snapshot` (verify in a fresh clone), `unavailableExitStatuses`, `summary`, `optional` (`--with`) |
| `publication` | — | `checks` before a push, `bodyCommand`, `marker`, `draftFirst`, `linkMarkerNamespace`, `reportPullRequestReason` |
| `cleanup` | — | `deleteRemoteBranch`, `deleteLocalBranch`, `fastForwardPrimary`, `after` commands |
| `review` | — | the advisory-review protocol: `reviewScheme`, `markerNamespace`, `publisherName`, `publishToolName`, `trustedAuthors` |
| `discussion` | — | discussion comments on published specification issues: `scheme`, `markerNamespace`, `publisherName`, `publishToolName` (marker `<namespace>:issue-comment v1`; unreleased) |
| `artifacts` | — | `readable` path prefixes `comforge artifact` may read at a commit |
| `security` | — | `capabilities`, `authorization` (`operator` or `owner-grant`), `credentials`, `delivery` (assignee), `ledgerNamespace`, `markerNamespace` |

**Trust.** The CLI reads the configuration **from the base branch at the fetched revision**,
never from the working tree, so a candidate cannot change the rules that govern its own
validation and publication. A candidate that changes a trusted section is refused at `publish`
with `untrusted-config-change`; the owner merges such a change separately.

**Authorization** (`security.authorization`): absent → every write is refused
(`authorization-required`); `{"mode": "operator"}` → whoever runs the CLI with the credential
decides; `{"mode": "owner-grant", "grantScheme", "trustedKeys", "revokedGrants"?}` → every write
needs an owner-signed grant. See [authorization and trust](../security/authorization-and-trust.md).

**Credentials** (`security.credentials`): `{"source": "env", "variable": "NAME"}` or
`{"source": "gh"}`. The token is read per process, held in memory, never written, logged or
passed to a child process.

Recipes with complete configurations: [1](../recipes/01-first-governed-initiative.md),
[5](../recipes/05-owner-grants.md) (owner grants), [6](../recipes/06-specification-review-revision.md)
(advisory reviews), [9](../recipes/09-non-typescript-project.md) (Python).

## Example

```json
{
  "schema": "comforge-config/v1",
  "repository": { "owner": "acme", "name": "widgets", "baseBranch": "main", "remote": "origin" },
  "tickets": { "pattern": "^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+$", "branchPrefix": "agent/" },
  "checkout": { "provision": [["npm", "ci"]] },
  "validation": { "commands": [{ "name": "test", "run": ["npm", "test"] }], "timeoutSeconds": 3600 },
  "evidence": { "reportDir": "docs/comforge" },
  "commits": { "trailer": "Ticket" },
  "specification": { "required": true, "digestScheme": "acme-spec/v1", "markerNamespace": "acme-spec", "publisherName": "Acme Specs", "publishToolName": "acme_create_issue" },
  "completion": { "scheme": "acme-completion/v1", "markerNamespace": "acme-lifecycle", "runner": { "id": "my-agent", "label": "my agent" } },
  "context": { "manifest": "routing.json" },
  "security": {
    "capabilities": ["pulls:create", "pulls:update", "issues:comment"],
    "ledgerNamespace": "writes",
    "markerNamespace": "comforge-cli",
    "credentials": { "source": "env", "variable": "GITHUB_TOKEN" },
    "delivery": { "assignee": "acme-owner" }
  }
}
```

The `specification` and `completion` sections name the `@comforge/core` protocols; a repository
that configures the same names produces byte-identical records. More on trust, authorization,
credentials, provisioning and verification results: [CLI reference](cli.md#trust-and-configuration-sections).
