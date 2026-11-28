---
name: comforge-authorization
description: Explain and apply the authorization modes and owner-signed grants.
category: consumer
---

# comforge-authorization

Explain and apply the authorization modes and owner-signed grants.

## When to use

- Any write is refused with `authorization-required`, `grant-required` or `grant-invalid`.
- The owner asks which authorization mode to use.

## Prerequisites

- A committed configuration.
- For `owner-grant`: the owner's Ed25519 key, kept where agents cannot read it.

## Examples

```sh
npx comforge grant template ACME-101 --hours 24 > grant.json          # anyone
npx comforge grant sign ACME-101 --grant grant.json --key owner.pem   # the owner, offline
npx comforge deliver ACME-101 --title "…" --result r.json --grant grant.signed.json --execute
```

## Decision rules

- `operator`: whoever runs the CLI decides (policy). `owner-grant`: the owner's signature per initiative and commit (enforcement).
- Recommend `owner-grant` when an agent runs unattended — and only if the key is out of the agent's reach.
- Command-scoped grants (`--command cleanup`) authorize exactly one command target.

## Security boundaries

- An agent never generates, reads or holds the owner's private key, and never chooses the mode.
- A grant from another authority (runtime grants, release authorizations) is never accepted as a lifecycle grant.

## Validation

```sh
npx comforge doctor --json   # reports the active authorization mode
```

## Failure and recovery

- `grant-expired` / `grant-exhausted`: ask the owner for a new grant.
- `grant-head-mismatch`: the grant names another commit; verify and request a grant for this head.

## References

- [docs/security/authorization-and-trust.md](../../docs/security/authorization-and-trust.md)
- [packages/cli/README.md#authorization](../../packages/cli/README.md#authorization)
- [docs/recipes/05-owner-grants.md](../../docs/recipes/05-owner-grants.md)
