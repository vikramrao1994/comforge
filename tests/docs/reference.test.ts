import { describe, expect, test } from "bun:test";
import { inconsistencies } from "../../tooling/benchmarks/summary";
import { checkBenchmarks, checkInvented, checkRecipes, checkReference, checkVersions } from "../../tooling/docs/checks";
import { cliContracts, flagsOf, mcpContracts } from "../../tooling/docs/contracts";

// Documentation is checked against the packages' own contracts, so a page can neither go stale
// nor describe an interface that does not exist.
describe("documentation drift checks", () => {
  test("the generated inventories are current and every contract is explained by hand", async () => {
    expect(await checkReference()).toEqual([]);
  });
  test("no document names a command, flag or tool the contracts do not declare", async () => {
    expect(await checkInvented()).toEqual([]);
  });
  test("no document calls an unreleased version published", () => {
    expect(checkVersions()).toEqual([]);
  });
  test("recipes: at least ten, each executable, with errors, cleanup and test notes, all indexed", () => {
    expect(checkRecipes()).toEqual([]);
  });
  test("the benchmark summary matches its evidence", () => {
    expect(checkBenchmarks()).toEqual([]);
  });
});

describe("contracts", () => {
  test("flags come from the parser's allowlist, including those a usage line omits", async () => {
    const cli = await cliContracts();
    const start = cli.commands.find((c) => c.name === "start");
    expect(start?.flags).toContain("--reopen");
    expect(start?.usageOmits).toEqual(["--reopen"]);
    expect(cli.globalFlags).toEqual(["--compact", "--cwd", "--help", "--json", "--summary", "--version"]);
  });
  test("MCP tools, profiles and launch flags are read from the server's own sources", async () => {
    const mcp = await mcpContracts();
    expect(mcp.tools.length).toBe(19);
    expect(mcp.profiles).toEqual(["read-only", "reviewer", "executor", "publisher"]);
    expect(mcp.binFlags).toEqual(["--compact-discovery", "--profile", "--repository", "--summary-text"]);
  });
  test("flagsOf reads flag names, not values", () => {
    expect(flagsOf("start <ID> [--issue N] [--expect-digest HEX]")).toEqual(["--expect-digest", "--issue"]);
  });
});

describe("benchmark evidence", () => {
  test("a hand-edited derived figure is caught", () => {
    const tamper = {
      discovery: {
        "read-only": { chars: 100 },
        "read-only (compact)": { chars: 50 },
        "executor+publisher": { chars: 100 },
        "executor+publisher (compact)": { chars: 60 },
      },
      tasks: [
        { cliJson: { chars: 100 }, cliCompact: { chars: 80 }, mcpText: { chars: 90 } },
        { mcpListText: { chars: 20 } },
        { cliJson: { chars: 10 }, cliCompact: { chars: 8 }, mcpSummaryText: { chars: 5 } },
      ],
      derived: {
        compactDiscoveryReductionPercent: { "read-only": 50, "executor+publisher": 45 },
        cliCompactReductionPercent: { statusAll: 20, statusOne: 20 },
        mcpVsCliEquivalentStatusPercent: -10,
        mcpVsCliCompactEquivalentStatusPercent: 12.5,
        summaryFirstVsCliFullPercent: { everyInitiative: 80, oneInitiative: 50 },
      },
    } as unknown as Parameters<typeof inconsistencies>[0];
    expect(inconsistencies(tamper)).toEqual(["compact discovery (executor+publisher): evidence says 45%, its sizes give 40%"]);
  });
});
