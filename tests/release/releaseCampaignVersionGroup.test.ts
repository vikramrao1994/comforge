import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { PackageName } from "../../tooling/release/packages";
import {
  type Campaign,
  CampaignRefusal,
  derivePackage,
  groupOf,
  type PackageObservation,
  parseCampaign,
  type Target,
  versionBranchOf,
  versionGroupOf,
} from "../../tooling/release/releaseCampaign";
import { groupBranch, groupOrder } from "../../tooling/release/releasePlan";

// one version PR for a group of packages. It saves a pull request
// only. Approval, publication, readback and the release record stay per package, and a
// dependent still waits for its dependency's release.

const REPO = path.resolve(import.meta.dir, "../..");
const FILE = "releases/campaigns/comforge-adoption-001.json";
const campaign: Campaign = parseCampaign(JSON.parse(readFileSync(path.join(REPO, FILE), "utf8")));
const target = (name: string) => campaign.packages.find((p) => p.package === name) as Target;
const CLI = "@comforge/cli" as PackageName;
const MCP = "@comforge/mcp" as PackageName;
const HELD = new Set<PackageName>(["@comforge/core", "@comforge/github", "@comforge/ledger"] as PackageName[]);

const observed = (over: Partial<PackageObservation>): PackageObservation => ({
  plan: null,
  versionPr: null,
  consumerPr: null,
  tagCommit: null,
  registry: { published: false, integrity: null, provenance: false },
  npmRunInFlight: false,
  candidateRun: null,
  record: null,
  recordPr: null,
  pin: { version: "0.0.1", integrity: "sha512-old" },
  installed: "0.0.1",
  bootstrap: null,
  ...over,
});
const derive = (name: PackageName, obs: PackageObservation, ready: ReadonlySet<PackageName>) =>
  derivePackage({
    target: target(name),
    obs,
    checkpoint: undefined,
    ready,
    group: groupOf(campaign, name),
    versionGroup: versionGroupOf(campaign, name),
    publishInFlight: false,
    lastPublishRun: null,
    head: "a".repeat(40),
    retryFailed: false,
  });
const due = (version: string) => ({ kind: "plan", status: "version-pr-due", nextVersion: version, digest: "sha256:x" }) as const;

describe("the committed interface campaign", () => {
  test("releases the CLI then the MCP server, holds the lower-level packages, and adopts both in one change", () => {
    expect(campaign.packages.map((p) => `${p.package}@${p.version}`)).toEqual(["@comforge/cli@0.5.0", "@comforge/mcp@0.3.0"]);
    expect(campaign.hold.map((h) => h.package).sort()).toEqual([...HELD].sort());
    expect(groupOf(campaign, MCP).map((t) => t.package)).toEqual([CLI, MCP]);
    expect(versionGroupOf(campaign, CLI).map((t) => t.package)).toEqual([CLI, MCP]);
    // The MCP candidate names a CLI version that a committed campaign releases.
    const dir = path.join(REPO, "releases/campaigns");
    const campaigns = readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => parseCampaign(JSON.parse(readFileSync(path.join(dir, f), "utf8"))));
    const mcp = JSON.parse(readFileSync(path.join(REPO, "packages/mcp/package.json"), "utf8"));
    const cli = mcp.dependencies["@comforge/cli"];
    expect(campaigns.some((c) => c.packages.some((p) => p.package === CLI && p.version === cli))).toBe(true);
  });

  test("the version group's branch is the one the planner's version-pr command creates", () => {
    expect(versionBranchOf(versionGroupOf(campaign, MCP))).toBe(groupBranch(groupOrder([MCP, CLI])));
    expect(versionBranchOf([target(CLI)])).toBe("comforge-release/cli/v0.5.0");
  });
});

describe("a version group", () => {
  test("is opened as one version PR naming every member, by the first member that is due", () => {
    const state = derive(CLI, observed({ plan: due("0.5.0") }), HELD);
    expect(state.step).toMatchObject({
      by: "agent",
      action: "open-version-pr",
      command: "bun run release:version-pr --open --package @comforge/cli --package @comforge/mcp",
    });
  });

  test("once open, waits for the owner's merge instead of opening another", () => {
    const state = derive(CLI, observed({ plan: due("0.5.0"), versionPr: { number: 7, state: "OPEN" } }), HELD);
    expect(state.step).toMatchObject({ by: "owner", action: "merge-version-pr" });
  });

  test("never lets a dependent pass its dependency: the MCP server is not planned before the CLI is released", () => {
    // The group PR is merged, so the MCP version is already on main; the CLI is not released yet.
    const state = derive(MCP, observed({ plan: null, versionPr: { number: 7, state: "MERGED" } }), HELD);
    expect(state.stage).toBe("waiting-dependency");
    expect(state.step?.by).toBe("wait");
    expect(state.needsPlan).toBe(false);
  });

  test("a package outside any version group keeps its own version PR", () => {
    const solo: Campaign = { ...campaign, id: "solo-versions", versionTogether: [] };
    const state = derivePackage({
      target: target(CLI),
      obs: observed({ plan: due("0.5.0") }),
      checkpoint: undefined,
      ready: HELD,
      group: groupOf(solo, CLI),
      versionGroup: versionGroupOf(solo, CLI),
      publishInFlight: false,
      lastPublishRun: null,
      head: "a".repeat(40),
      retryFailed: false,
    });
    expect(state.step).toMatchObject({ command: "bun run release:version-pr --open --package @comforge/cli" });
  });

  test("is refused when a member is not a campaign package or is in two groups", () => {
    const raw = JSON.parse(readFileSync(path.join(REPO, FILE), "utf8"));
    expect(() => parseCampaign({ ...raw, versionTogether: [["@comforge/cli", "@comforge/core"]] })).toThrow(CampaignRefusal);
    expect(() =>
      parseCampaign({
        ...raw,
        versionTogether: [
          ["@comforge/cli", "@comforge/mcp"],
          ["@comforge/mcp", "@comforge/cli"],
        ],
      }),
    ).toThrow(/two version groups/);
  });
});
