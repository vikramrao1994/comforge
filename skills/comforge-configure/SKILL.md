---
name: comforge-configure
description: Create or change comforge.config.json safely: detection, review, commit to the base branch.
category: consumer
---

# comforge-configure

Create or change comforge.config.json safely: detection, review, commit to the base branch.

## When to use

- The repository has no `comforge.config.json`, or a task changes validation, provisioning, capabilities or authorization.

## Prerequisites

- `@comforge/cli` installed (skill comforge-install).
- Write access to open a pull request against the base branch.

## Examples

```sh
npx comforge init                # preview the detected configuration
npx comforge init --write        # write it
npx comforge schema config > /tmp/comforge-config.schema.json
```

## Decision rules

- The configuration is trusted only once it is on the base branch: change it through a reviewed PR, never inside an initiative's own change (that is refused with `untrusted-config-change`).
- Grant only the capabilities the workflow needs (`security.capabilities`).
- Leave `security.authorization` for a person to choose (skill comforge-authorization).

## Security boundaries

- An agent must not choose or weaken `security.authorization` or `security.capabilities` on its own.
- Validation commands run the candidate's code; do not add commands that read credentials.

## Validation

```sh
npx comforge doctor --json && npx comforge schema config >/dev/null
```

## Failure and recovery

- `config-invalid`: the error names the field; compare with `comforge schema config`.
- `untrusted-config-change` at publish: split the configuration change into its own reviewed PR.

## References

- [docs/configuration.md](../../docs/configuration.md)
- [packages/cli/README.md#configuration](../../packages/cli/README.md#configuration)
