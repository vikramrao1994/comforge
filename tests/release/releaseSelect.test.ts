import { expect, test } from "bun:test";
import { selectPackages } from "../../tooling/release/releaseSelect";

// The release workflow publishes only what this selects: release-ready packages, in registry
// (dependency) order; a refusal, such as a version already on the registry, is never selected.

test("selects only release-ready packages, in dependency order", () => {
  const status: Record<string, string> = {
    "@comforge/core": "no-release",
    "@comforge/github": "version-pr-due",
    "@comforge/ledger": "refused",
    "@comforge/cli": "release-ready",
    "@comforge/mcp": "release-ready",
  };
  const r = selectPackages({ registry: true }, (name) => status[name] ?? "refused");
  expect(r.selected).toEqual(["cli", "mcp"]);
  expect(r.verdicts.map((v) => v.id)).toEqual(["core", "github", "ledger", "cli", "mcp"]);
});

test("a dispatch for one package selects it only when it is release-ready", () => {
  expect(selectPackages({ registry: true, only: "mcp" }, () => "release-ready").selected).toEqual(["mcp"]);
  expect(selectPackages({ registry: true, only: "mcp" }, () => "refused").selected).toEqual([]);
  expect(() => selectPackages({ registry: true, only: "agents" }, () => "release-ready")).toThrow();
});
