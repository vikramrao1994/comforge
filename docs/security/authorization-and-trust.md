# Authorization and trust boundaries

Status: published.

| `security.authorization` | Who decides a write |
|---|---|
| unset / `null` | nobody: every write is refused (`authorization-required`) |
| `{ "mode": "operator" }` | whoever runs the CLI with the credential (policy, not enforcement) |
| `{ "mode": "owner-grant", … }` | the owner's Ed25519 signature per initiative and exact commit, with expiry ≤ 7 days and bounded attempts |

Choose `owner-grant` when an agent, not a person, runs the commands — and keep the signing key
out of the agent's reach; a key the agent can read protects nothing.

Boundaries the code enforces:

- The configuration is read from the base branch, never the working tree.
- Validation runs without the GitHub credential and without the `gh` login in its environment.
- Writes are limited to `security.capabilities`; anything else is refused before a request.
- Issue, comment and PR text is returned as bounded **untrusted** text: it never authorizes,
  approves or changes a specification.
- Advisory reviews are comments; Comforge never approves, merges or deploys.
- Release authorization for this repository's own packages is a separate, owner-signed authority
  ([release governance](../contributing/release-governance.md)).

What it does not protect against: anyone with write access using other tools. Use branch
rulesets for enforcement ([known limitations](../troubleshooting/known-limitations.md)).
