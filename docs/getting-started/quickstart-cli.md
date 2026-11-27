# CLI quickstart

Status: published (`@comforge/cli` 0.5.0). Requirements: Node.js ≥ 22.18 or Bun ≥ 1.4, Git ≥ 2.30,
macOS or Linux ([runtimes](../reference/compatibility.md)).

```sh
npm install --save-dev --save-exact @comforge/cli   # or: bun add -d --exact @comforge/cli
npx comforge init            # preview the detected configuration
npx comforge init --write    # write comforge.config.json; review and commit it to main
npx comforge doctor          # environment, configuration, credential and ledger checks
```

Choose an authorization mode in the committed configuration before any write
([authorization](../security/authorization-and-trust.md)). With `security.authorization` unset, every
write is refused with `authorization-required`.

One initiative, end to end (an issue whose body is a published specification):

```sh
npx comforge start ACME-101 --issue 12   # verify the spec, isolated checkout on agent/acme-101
# …work and commit in the printed checkout…
npx comforge verify ACME-101              # validation commands on the committed head
npx comforge deliver ACME-101 --title "Add the widget cache" --result result.json          # plan
npx comforge deliver ACME-101 --title "Add the widget cache" --result result.json --execute
# …people review and merge on GitHub…
npx comforge cleanup 34 --execute
```

Every writing command is a dry run without `--execute`. Output is JSON with `--json`; exit codes
and error codes are listed by `comforge capabilities` and in the
[CLI reference](../../packages/cli/README.md#exit-codes-and-errors).

The same workflow with every command, configuration and expected output, tested in CI:
[recipe 1](../recipes/01-first-governed-initiative.md).

Next: [configuration](../reference/configuration.md), [CLI reference](../reference/cli.md),
[commands](../reference/tool-selection.md),
[recovery](../troubleshooting/migration-and-recovery.md).
