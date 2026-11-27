import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PackageName } from "../../tooling/release/packages";
import {
  type AgentAction,
  acquireLock,
  assertNoSecret,
  type Campaign,
  type CampaignIo,
  CampaignRefusal,
  DEFAULT_CAMPAIGN,
  deriveCampaign,
  type Observation,
  type PackageObservation,
  type PlanObservation,
  parseCampaign,
  readCheckpoint,
  releaseStaleLock,
  runCampaign,
  type Target,
} from "../../tooling/release/releaseCampaign";

// COMFORGE-RELEASE-001: the campaign only reads what the release commands did and names the
// next step. These scenarios drive it through a simulated world (registry, mirror, PRs, runs)
// and check that recovery never repeats a step or requests a publication.

const HEAD = "a".repeat(40);
const TAG = (n: number) => n.toString(16).padStart(40, "0");
const CAMPAIGN: Campaign = parseCampaign(JSON.parse(readFileSync(path.join(import.meta.dir, "../..", DEFAULT_CAMPAIGN), "utf8")));
const RELEASED: Record<string, string> = {
  "@comforge/core": "0.1.2",
  "@comforge/github": "0.4.0",
  "@comforge/cli": "0.2.0",
  "@comforge/ledger": "0.1.0",
};
/** The same targets adopted one by one: the single-package pin paths. */
const SOLO: Campaign = { ...CAMPAIGN, id: "solo-campaign", adopt: [] };
// Mirrors the registry: every package the portfolio installs (mcp since COMFORGE-ADOPTION-001).
const CONSUMED = new Set(["@comforge/core", "@comforge/github", "@comforge/cli", "@comforge/ledger", "@comforge/mcp"]);

type Pkg = {
  mainVersion: string;
  /** The CHANGELOG carries the target's section (written by the version PR). */
  changelog: boolean;
  pinned: string | null;
  versionPr: { number: number; state: "OPEN" | "MERGED" | "CLOSED" } | null;
  consumerPr: { number: number; state: "OPEN" | "MERGED" | "CLOSED" } | null;
  recordPr: { number: number; state: "OPEN" | "MERGED" | "CLOSED" } | null;
  /** Integrity in the committed release record on main (null: none). */
  record: string | null;
  tagCommit: string | null;
  published: boolean;
  provenance: boolean;
  integrity: string | null;
  bootstrap: { environment: boolean; rulesets: boolean } | null;
  plan?: PlanObservation;
};

class World {
  pkgs = new Map<string, Pkg>();
  publishInFlight = false;
  lastPublishRun: Observation["lastPublishRun"] = null;
  executed: { action: AgentAction; package: string }[] = [];
  planned: string[] = [];
  failNext: { action: AgentAction; afterSideEffect: boolean } | null = null;
  nextPr = 200;

  constructor() {
    for (const t of CAMPAIGN.packages)
      this.pkgs.set(t.package, {
        mainVersion: RELEASED[t.package] ?? "0.1.0",
        changelog: false,
        pinned: RELEASED[t.package] ?? null,
        versionPr: null,
        consumerPr: null,
        recordPr: null,
        record: null,
        tagCommit: null,
        published: false,
        provenance: false,
        integrity: null,
        bootstrap: t.firstRelease ? { environment: false, rulesets: false } : null,
      });
    this.pkgs.set("@comforge/ledger", {
      mainVersion: "0.1.0",
      changelog: true,
      pinned: "0.1.0",
      versionPr: null,
      consumerPr: null,
      recordPr: null,
      record: null,
      tagCommit: TAG(1),
      published: true,
      provenance: false,
      integrity: "sha512-ledger",
      bootstrap: null,
    });
  }
  get(name: string) {
    return this.pkgs.get(name) as Pkg;
  }
  target(name: string) {
    return CAMPAIGN.packages.find((p) => p.package === name) as Target;
  }

  io(): CampaignIo {
    return {
      observe: async () => {
        const packages: Observation["packages"] = {};
        for (const [name, p] of this.pkgs) {
          const obs: PackageObservation = {
            plan: null,
            versionPr: p.versionPr && { ...p.versionPr },
            consumerPr: p.consumerPr && { ...p.consumerPr },
            recordPr: p.recordPr && { ...p.recordPr },
            record: p.record ? { version: this.target(name)?.version ?? "", integrity: p.record } : null,
            tagCommit: p.tagCommit,
            registry: { published: p.published, integrity: p.integrity, provenance: p.provenance },
            npmRunInFlight: false,
            candidateRun: null,
            pin: p.pinned ? { version: p.pinned, integrity: p.pinned === this.target(name)?.version ? (p.integrity ?? "") : "sha512-old" } : null,
            installed: CONSUMED.has(name) ? p.pinned : null,
            bootstrap: p.bootstrap && { ...p.bootstrap },
          };
          packages[name as PackageName] = obs;
        }
        return { head: HEAD, publishInFlight: this.publishInFlight, lastPublishRun: this.lastPublishRun, packages };
      },
      plan: async (pkg) => {
        this.planned.push(pkg);
        const p = this.get(pkg);
        if (p.plan) return p.plan;
        const next = this.target(pkg).version;
        return p.mainVersion === next && p.changelog
          ? { kind: "plan", status: "release-ready", nextVersion: next, digest: `sha256:${pkg}-ready` }
          : { kind: "plan", status: "version-pr-due", nextVersion: next, digest: `sha256:${pkg}-due` };
      },
      execute: async (action, targets) => {
        const target = targets.at(-1) as Target;
        this.executed.push({ action, package: targets.map((t) => t.package).join("+") });
        const p = this.get(target.package);
        const fail = this.failNext?.action === action ? this.failNext : null;
        if (fail) this.failNext = null;
        if (fail && !fail.afterSideEffect) throw new Error("consumer:update refused (checks-failed)");
        const pr = { number: this.nextPr++, state: "OPEN" as const };
        if (action === "open-version-pr") p.versionPr = pr;
        else if (action === "open-record-pr") p.recordPr = pr;
        // One PR for the whole adoption group: every member observes it.
        else for (const t of targets) this.get(t.package).consumerPr = pr;
        if (fail) throw new Error("response lost after the PR was created");
      },
      assertRunnable: () => {},
    };
  }

  /** What the owner does for the step the campaign names; never a campaign action. */
  ownerActs(name: string, action: string) {
    const p = this.get(name);
    const t = this.target(name);
    if (action === "merge-version-pr" && p.versionPr) {
      p.versionPr.state = "MERGED";
      p.mainVersion = t.version;
      p.changelog = true;
    } else if (action === "first-release-setup") p.bootstrap = { environment: true, rulesets: true };
    else if (action === "approve-release") {
      p.tagCommit = TAG(this.nextPr++);
      if (!t.firstRelease) this.publish(name, true);
    } else if (action === "bootstrap-publish") this.publish(name, false);
    else if (action === "merge-record-pr" && p.recordPr) {
      p.recordPr.state = "MERGED";
      p.record = p.integrity;
    } else if (action === "merge-pin-pr" && p.consumerPr) {
      const pr = p.consumerPr;
      for (const [member, q] of this.pkgs)
        if (q.consumerPr?.number === pr.number) {
          q.consumerPr = { ...pr, state: "MERGED" };
          q.pinned = this.target(member).version;
        }
    } else if (action === "authorize-adoption-pr") p.pinned = t.version;
    else throw new Error(`no owner action ${action} for ${name}`);
  }
  publish(name: string, provenance: boolean) {
    const p = this.get(name);
    p.published = true;
    p.provenance = provenance;
    p.integrity = `sha512-${name}-${this.target(name).version}`;
  }
}

let dirs: string[] = [];
const stateDir = () => {
  const d = mkdtempSync(path.join(tmpdir(), "campaign-test-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});
const resume = (world: World, dir: string, extra: { retryFailed?: boolean; campaign?: Campaign } = {}) =>
  runCampaign({
    command: "resume",
    stateDir: dir,
    io: world.io(),
    execute: true,
    ...extra,
    campaign: extra.campaign ?? SOLO,
  });
const stateOf = (r: Awaited<ReturnType<typeof resume>>, name: string) => r.view.packages.find((p) => p.package === name);

describe("campaign definition", () => {
  test("the committed campaign targets the four candidates in dependency order, holds the ledger and adopts core, github and cli together", () => {
    expect(CAMPAIGN.adopt).toEqual([["@comforge/core", "@comforge/github", "@comforge/cli"]]);
    expect(CAMPAIGN.packages.map((p) => `${p.package}@${p.version}`)).toEqual([
      "@comforge/core@0.2.0",
      "@comforge/github@0.5.0",
      "@comforge/cli@0.3.0",
      "@comforge/mcp@0.1.0",
    ]);
    expect(CAMPAIGN.hold).toEqual([{ package: "@comforge/ledger", version: "0.1.0" }]);
  });

  test("a package before its dependency, an unknown package or an unheld dependency is refused", () => {
    const base = { schema: "comforge-release-campaign/v1", id: "x-campaign" };
    const order = {
      ...base,
      packages: [
        { package: "@comforge/github", version: "0.5.0" },
        { package: "@comforge/core", version: "0.2.0" },
      ],
    };
    expect(() => parseCampaign(order)).toThrow(/campaign-order/);
    expect(() => parseCampaign({ ...base, packages: [{ package: "@comforge/nope", version: "1.0.0" }] })).toThrow(/campaign-invalid/);
    expect(() => parseCampaign({ ...base, packages: [{ package: "@comforge/cli", version: "0.3.0" }] })).toThrow(/neither releases nor holds/);
  });
});

describe("campaign run", () => {
  // The MCP source already carries 0.1.0, but its CHANGELOG has no 0.1.0 section, so it still
  // needs a (changelog-only) version PR, as the real planner reports.
  test("adopted one by one, four packages reach adoption; each agent step runs once and none is a publication", async () => {
    const world = new World();
    const dir = stateDir();
    const owner: string[] = [];
    for (let i = 0; i < 40; i++) {
      const r = await resume(world, dir);
      if (r.view.complete) break;
      const next = r.view.next;
      if (!next) throw new Error(`stuck: ${JSON.stringify(r.view.packages.map((p) => p.blockers))}`);
      if (next.step.by === "owner") {
        expect(r.exitCode).toBe(r.executed ? 0 : 3);
        owner.push(`${next.package}:${next.step.action}`);
        world.ownerActs(next.package, next.step.action);
      }
    }
    const final = await runCampaign({ command: "status", campaign: SOLO, stateDir: dir, io: world.io() });
    expect(final.view.complete).toBe(true);
    expect(final.exitCode).toBe(0);
    expect(world.executed).toEqual([
      { action: "open-version-pr", package: "@comforge/core" },
      { action: "open-pin-pr", package: "@comforge/core" },
      { action: "open-version-pr", package: "@comforge/github" },
      { action: "open-pin-pr", package: "@comforge/github" },
      { action: "open-version-pr", package: "@comforge/cli" },
      { action: "open-pin-pr", package: "@comforge/cli" },
      { action: "open-version-pr", package: "@comforge/mcp" },
      // Installed since COMFORGE-ADOPTION-001, so its adoption is a consumer-pin PR like the others.
      { action: "open-pin-pr", package: "@comforge/mcp" },
    ]);
    expect(owner).toEqual([
      "@comforge/core:merge-version-pr",
      "@comforge/core:approve-release",
      "@comforge/core:merge-pin-pr",
      "@comforge/github:merge-version-pr",
      "@comforge/github:approve-release",
      "@comforge/github:merge-pin-pr",
      "@comforge/cli:merge-version-pr",
      "@comforge/cli:approve-release",
      "@comforge/cli:merge-pin-pr",
      "@comforge/mcp:merge-version-pr",
      "@comforge/mcp:first-release-setup",
      "@comforge/mcp:approve-release",
      "@comforge/mcp:bootstrap-publish",
      "@comforge/mcp:merge-pin-pr",
    ]);
    // Planning starts only once a package's dependencies are adopted.
    expect(world.planned.indexOf("@comforge/github")).toBeGreaterThan(-1);
    const checkpoint = readCheckpoint(path.join(dir, "solo-campaign.json"));
    expect(checkpoint?.packages["@comforge/mcp"]?.facts.provenance).toBe(false);
    expect(checkpoint?.packages["@comforge/core"]?.facts.provenance).toBe(true);
    // Installed, so adopted through its pin like the others; no "pinned only" note.
    expect(final.view.packages.find((p) => p.package === "@comforge/mcp")?.notes.join(" ")).not.toMatch(/pinned only/);
  });

  // The committed campaign adopts core, github and cli together, because the published github
  // 0.4.0 and cli 0.2.0 would each keep a nested core 0.1.2 next to core 0.2.0.
  test("the committed campaign releases core and github with records and adopts the group in one PR", async () => {
    const world = new World();
    const dir = stateDir();
    const owner: string[] = [];
    for (let i = 0; i < 40; i++) {
      const r = await resume(world, dir, { campaign: CAMPAIGN });
      if (r.view.complete) break;
      const next = r.view.next;
      if (!next) throw new Error(`stuck: ${JSON.stringify(r.view.packages.map((p) => [p.stage, p.blockers, p.step]))}`);
      if (next.step.by === "owner") {
        owner.push(`${next.package}:${next.step.action}`);
        world.ownerActs(next.package, next.step.action);
      }
      // core and github stay at their old pins until the group PR merges: no nested copies.
      if (world.get("@comforge/cli").pinned !== "0.3.0")
        expect([world.get("@comforge/core").pinned, world.get("@comforge/github").pinned]).toEqual(["0.1.2", "0.4.0"]);
    }
    expect(world.executed).toEqual([
      { action: "open-version-pr", package: "@comforge/core" },
      { action: "open-record-pr", package: "@comforge/core" },
      { action: "open-version-pr", package: "@comforge/github" },
      { action: "open-record-pr", package: "@comforge/github" },
      { action: "open-version-pr", package: "@comforge/cli" },
      { action: "open-pin-pr", package: "@comforge/core+@comforge/github+@comforge/cli" },
      { action: "open-version-pr", package: "@comforge/mcp" },
      // Installed since COMFORGE-ADOPTION-001, so its adoption is a consumer-pin PR like the others.
      { action: "open-pin-pr", package: "@comforge/mcp" },
    ]);
    expect(owner).toEqual([
      "@comforge/core:merge-version-pr",
      "@comforge/core:approve-release",
      "@comforge/core:merge-record-pr",
      "@comforge/github:merge-version-pr",
      "@comforge/github:approve-release",
      "@comforge/github:merge-record-pr",
      "@comforge/cli:merge-version-pr",
      "@comforge/cli:approve-release",
      "@comforge/cli:merge-pin-pr",
      "@comforge/mcp:merge-version-pr",
      "@comforge/mcp:first-release-setup",
      "@comforge/mcp:approve-release",
      "@comforge/mcp:bootstrap-publish",
      "@comforge/mcp:merge-pin-pr",
    ]);
  });

  test("group pin step names every member; mcp (another group) waits for the group's adoption", async () => {
    const world = new World();
    for (const [name, v] of [
      ["@comforge/core", "0.2.0"],
      ["@comforge/github", "0.5.0"],
      ["@comforge/cli", "0.3.0"],
    ] as const) {
      Object.assign(world.get(name), { mainVersion: v, changelog: true, tagCommit: TAG(v.length + name.length) });
      world.publish(name, true);
    }
    world.get("@comforge/core").record = world.get("@comforge/core").integrity;
    world.get("@comforge/github").record = world.get("@comforge/github").integrity;
    const r = await runCampaign({ command: "plan", campaign: CAMPAIGN, stateDir: stateDir(), io: world.io() });
    expect(r.view.next).toMatchObject({
      package: "@comforge/cli",
      step: {
        by: "agent",
        action: "open-pin-pr",
        command:
          "bun run release:adopt --package @comforge/core --version 0.2.0 --package @comforge/github --version 0.5.0 --package @comforge/cli --version 0.3.0 --open",
      },
    });
    expect(stateOf(r, "@comforge/core")).toMatchObject({ released: true, stage: "pinning" });
    expect(stateOf(r, "@comforge/mcp")?.stage).toBe("waiting-dependency");
    expect(world.planned).not.toContain("@comforge/mcp");
  });

  test("a group member is released only by a record matching the registry; github waits for it", async () => {
    const world = new World();
    const core = world.get("@comforge/core");
    Object.assign(core, { mainVersion: "0.2.0", changelog: true, tagCommit: TAG(8) });
    world.publish("@comforge/core", true);
    const noRecord = await resume(world, stateDir(), { campaign: CAMPAIGN });
    expect(noRecord.executed).toBe("open-record-pr");
    expect(stateOf(noRecord, "@comforge/github")?.stage).toBe("waiting-dependency");
    core.recordPr = null;
    core.record = "sha512-someone-else";
    const mismatch = await resume(world, stateDir(), { campaign: CAMPAIGN });
    expect(stateOf(mismatch, "@comforge/core")?.blockers[0]?.code).toBe("record-integrity-mismatch");
    core.record = core.integrity;
    const ok = await resume(world, stateDir(), { campaign: CAMPAIGN });
    expect(stateOf(ok, "@comforge/core")?.released).toBe(true);
    expect(ok.view.next?.package).toBe("@comforge/github");
  });

  test("a lost record-PR response is reconciled from the observed PR", async () => {
    const world = new World();
    const dir = stateDir();
    Object.assign(world.get("@comforge/core"), { mainVersion: "0.2.0", changelog: true, tagCommit: TAG(6) });
    world.publish("@comforge/core", true);
    world.failNext = { action: "open-record-pr", afterSideEffect: true };
    await resume(world, dir, { campaign: CAMPAIGN });
    const file = path.join(dir, "comforge-release-001-joint.json");
    const checkpoint = JSON.parse(readFileSync(file, "utf8"));
    checkpoint.packages["@comforge/core"].pending = { action: "open-record-pr", startedAt: "t0" };
    delete checkpoint.packages["@comforge/core"].failed;
    writeFileSync(file, JSON.stringify(checkpoint));
    const r = await resume(world, dir, { campaign: CAMPAIGN });
    expect(world.executed).toHaveLength(1);
    expect(stateOf(r, "@comforge/core")?.notes.join(" ")).toMatch(/reconciled open-record-pr/);
    expect(r.view.next?.step).toMatchObject({ by: "owner", action: "merge-record-pr" });
  });

  test("dependency gate: the CLI is never planned or stepped while github is not adopted", async () => {
    const world = new World();
    Object.assign(world.get("@comforge/core"), { mainVersion: "0.2.0", changelog: true });
    world.publish("@comforge/core", true);
    world.get("@comforge/core").tagCommit = TAG(9);
    world.get("@comforge/core").pinned = "0.2.0";
    world.get("@comforge/cli").plan = { kind: "plan", status: "release-ready", nextVersion: "0.3.0", digest: "sha256:x" };
    const r = await resume(world, stateDir());
    expect(stateOf(r, "@comforge/core")?.stage).toBe("adopted");
    expect(stateOf(r, "@comforge/cli")?.stage).toBe("waiting-dependency");
    expect(world.planned).not.toContain("@comforge/cli");
    expect(r.view.next?.package).toBe("@comforge/github");
  });

  test("owner approval pause: a release-ready package stops with the approve command and runs nothing", async () => {
    const world = new World();
    Object.assign(world.get("@comforge/core"), { mainVersion: "0.2.0", changelog: true });
    const r = await resume(world, stateDir());
    expect(r.exitCode).toBe(3);
    expect(r.view.next?.step).toMatchObject({
      by: "owner",
      action: "approve-release",
      command: "bun run release:approve --build --package @comforge/core",
    });
    expect(world.executed).toEqual([]);
  });

  test("without --execute, resume names the agent step and runs nothing", async () => {
    const world = new World();
    const r = await runCampaign({ command: "resume", campaign: SOLO, stateDir: stateDir(), io: world.io() });
    expect(r.view.next?.step.by).toBe("agent");
    expect(world.executed).toEqual([]);
  });

  test("a changed plan voids the earlier candidate; a changed tag or registry integrity is a conflict", async () => {
    const world = new World();
    const dir = stateDir();
    Object.assign(world.get("@comforge/core"), { mainVersion: "0.2.0", changelog: true });
    await resume(world, dir);
    world.get("@comforge/core").plan = { kind: "plan", status: "release-ready", nextVersion: "0.2.0", digest: "sha256:new" };
    const changed = await resume(world, dir);
    expect(stateOf(changed, "@comforge/core")?.notes.join(" ")).toMatch(/earlier candidate and approval are void/);
    expect(stateOf(changed, "@comforge/core")?.checkpoint.facts.supersededPlans).toEqual(["sha256:@comforge/core-ready"]);

    world.ownerActs("@comforge/core", "approve-release");
    await resume(world, dir); // records tag and integrity, opens the pin PR
    world.get("@comforge/core").integrity = "sha512-other";
    const conflict = await resume(world, dir);
    expect(stateOf(conflict, "@comforge/core")?.blockers[0]?.code).toBe("checkpoint-conflict");
    expect(conflict.exitCode).toBe(1);
    world.get("@comforge/core").integrity = "sha512-@comforge/core-0.2.0";
    world.get("@comforge/core").tagCommit = TAG(77);
    const moved = await resume(world, dir);
    expect(stateOf(moved, "@comforge/core")?.blockers[0]?.detail).toMatch(/now points at/);
  });

  test("failed publication: no tag after a failed publish run asks for a new approval, never a re-dispatch", async () => {
    const world = new World();
    Object.assign(world.get("@comforge/core"), { mainVersion: "0.2.0", changelog: true });
    world.lastPublishRun = { id: 9, conclusion: "failure", headSha: HEAD };
    const r = await resume(world, stateDir());
    const core = stateOf(r, "@comforge/core");
    expect(core?.step).toMatchObject({ by: "owner", action: "approve-release" });
    expect(core?.notes.join(" ")).toMatch(/approval is consumed/);
    expect(world.executed).toEqual([]);
  });

  test("lost response after a successful step: the observed PR settles it without running the step again", async () => {
    const world = new World();
    const dir = stateDir();
    world.failNext = { action: "open-version-pr", afterSideEffect: true };
    const first = await resume(world, dir);
    expect(first.exitCode).toBe(1);
    expect(world.executed).toHaveLength(1);
    // The PR exists although the command reported failure: the next run reconciles it.
    const checkpoint = JSON.parse(readFileSync(path.join(dir, "solo-campaign.json"), "utf8"));
    checkpoint.packages["@comforge/core"].pending = { action: "open-version-pr", startedAt: "t0" };
    delete checkpoint.packages["@comforge/core"].failed;
    writeFileSync(path.join(dir, "solo-campaign.json"), JSON.stringify(checkpoint));
    const second = await resume(world, dir);
    expect(world.executed).toHaveLength(1);
    expect(stateOf(second, "@comforge/core")?.notes.join(" ")).toMatch(/reconciled open-version-pr/);
    expect(second.view.next?.step).toMatchObject({ by: "owner", action: "merge-version-pr" });
  });

  test("lost response after publication: a version already on the registry is reconciled, not approved again", async () => {
    const world = new World();
    Object.assign(world.get("@comforge/core"), { mainVersion: "0.2.0", changelog: true });
    world.get("@comforge/core").tagCommit = TAG(5);
    world.publish("@comforge/core", true);
    const r = await runCampaign({ command: "status", campaign: SOLO, stateDir: stateDir(), io: world.io() });
    expect(stateOf(r, "@comforge/core")?.lifecycle).toBe("published");
    expect(r.view.next?.step).toMatchObject({ by: "agent", action: "open-pin-pr" });
    expect(world.planned).not.toContain("@comforge/core");
  });

  test("interrupted step: a pending step with no PR blocks until the owner reconciles it, then resumes", async () => {
    const world = new World();
    const dir = stateDir();
    const file = path.join(dir, "solo-campaign.json");
    await runCampaign({ command: "status", campaign: SOLO, stateDir: dir, io: world.io() });
    const checkpoint = JSON.parse(readFileSync(file, "utf8"));
    checkpoint.packages["@comforge/core"].pending = { action: "open-version-pr", startedAt: "t0" };
    writeFileSync(file, JSON.stringify(checkpoint));
    const blocked = await resume(world, dir);
    expect(stateOf(blocked, "@comforge/core")?.blockers[0]?.code).toBe("pending-unconfirmed");
    expect(world.executed).toEqual([]);
    const retried = await resume(world, dir, { retryFailed: true });
    expect(retried.executed).toBe("open-version-pr");
    expect(world.executed).toHaveLength(1);
  });

  test("pin failure is recorded and not retried until --retry-failed", async () => {
    const world = new World();
    const dir = stateDir();
    const core = world.get("@comforge/core");
    Object.assign(core, { mainVersion: "0.2.0", changelog: true });
    core.tagCommit = TAG(3);
    world.publish("@comforge/core", true);
    world.failNext = { action: "open-pin-pr", afterSideEffect: false };
    const failed = await resume(world, dir);
    expect(failed.exitCode).toBe(1);
    expect(stateOf(failed, "@comforge/core")?.blockers[0]?.code).toBe("pin-failed");
    await resume(world, dir);
    expect(world.executed).toHaveLength(1);
    const retried = await resume(world, dir, { retryFailed: true });
    expect(retried.executed).toBe("open-pin-pr");
    expect(world.executed).toHaveLength(2);
  });

  test("provenance mismatch: a non-bootstrap version without provenance is blocked; a registry version without its tag too", async () => {
    const world = new World();
    const core = world.get("@comforge/core");
    Object.assign(core, { mainVersion: "0.2.0", changelog: true });
    world.publish("@comforge/core", false);
    const noTag = await resume(world, stateDir());
    expect(stateOf(noTag, "@comforge/core")?.blockers[0]?.code).toBe("registry-without-tag");
    core.tagCommit = TAG(4);
    const r = await resume(world, stateDir());
    expect(stateOf(r, "@comforge/core")?.blockers[0]?.code).toBe("provenance-missing");
    expect(world.executed).toEqual([]);
  });

  test("a publication in flight is waited for; no approval is suggested while it runs", async () => {
    const world = new World();
    Object.assign(world.get("@comforge/core"), { mainVersion: "0.2.0", changelog: true });
    world.publishInFlight = true;
    const r = await resume(world, stateDir());
    expect(r.view.next?.step.by).toBe("wait");
    expect(r.exitCode).toBe(3);
  });

  test("target mismatch and planner refusals are blockers, not guesses", async () => {
    const world = new World();
    world.get("@comforge/core").plan = { kind: "plan", status: "version-pr-due", nextVersion: "0.1.3", digest: "d" };
    const r = await resume(world, stateDir());
    expect(stateOf(r, "@comforge/core")?.blockers[0]?.code).toBe("target-mismatch");
    world.get("@comforge/core").plan = { kind: "refused", code: "uncovered-change", message: "abc" };
    const refused = await resume(world, stateDir());
    expect(stateOf(refused, "@comforge/core")?.blockers[0]?.code).toBe("plan-uncovered-change");
  });

  test("an adopted pin that moves away is a conflict", async () => {
    const world = new World();
    const dir = stateDir();
    const core = world.get("@comforge/core");
    Object.assign(core, { mainVersion: "0.2.0", tagCommit: TAG(2), pinned: "0.2.0" });
    world.publish("@comforge/core", true);
    await resume(world, dir);
    core.pinned = "0.1.2";
    const r = await resume(world, dir);
    expect(stateOf(r, "@comforge/core")?.blockers[0]?.code).toBe("checkpoint-conflict");
  });
});

describe("campaign state", () => {
  test("concurrent invocation: a second run refuses while the lock is held, and a live holder cannot be unlocked", async () => {
    const dir = stateDir();
    const lock = path.join(dir, "solo-campaign.lock");
    const release = acquireLock(lock, "t0");
    const world = new World();
    await expect(resume(world, dir)).rejects.toThrow(/campaign-locked/);
    expect(() => releaseStaleLock(lock)).toThrow(/still holds/);
    expect(world.executed).toEqual([]);
    release();
    expect(existsSync(lock)).toBe(false);
    writeFileSync(lock, JSON.stringify({ pid: 2 ** 22 + 12345, startedAt: "t0" }));
    expect(releaseStaleLock(lock)).toBe(true);
  });

  test("a changed campaign file cannot reuse another campaign's checkpoint", async () => {
    const dir = stateDir();
    await runCampaign({ command: "status", campaign: SOLO, stateDir: dir, io: new World().io() });
    const edited = { ...SOLO, packages: SOLO.packages.map((p) => ({ ...p, version: p.package === "@comforge/core" ? "0.3.0" : p.version })) };
    await expect(runCampaign({ command: "status", campaign: edited, stateDir: dir, io: new World().io() })).rejects.toThrow(/campaign-changed/);
  });

  test("the checkpoint holds no credential and the writer refuses one", async () => {
    const dir = stateDir();
    await runCampaign({ command: "status", campaign: SOLO, stateDir: dir, io: new World().io() });
    const text = readFileSync(path.join(dir, "solo-campaign.json"), "utf8");
    expect(() => assertNoSecret(text)).not.toThrow();
    expect(() => assertNoSecret(`token npm_${"x".repeat(36)}`)).toThrow(CampaignRefusal);
    expect(() => assertNoSecret(`github_pat_${"y".repeat(40)}`)).toThrow(/secret-in-state/);
    expect(() => assertNoSecret("-----BEGIN PRIVATE KEY-----")).toThrow(/secret-in-state/);
  });

  test("plan writes nothing", async () => {
    const dir = stateDir();
    await runCampaign({ command: "plan", campaign: SOLO, stateDir: dir, io: new World().io() });
    expect(existsSync(path.join(dir, "solo-campaign.json"))).toBe(false);
    expect(existsSync(path.join(dir, "solo-campaign.lock"))).toBe(false);
  });

  test("a held package that is not pinned at its version keeps the campaign incomplete", async () => {
    const world = new World();
    const observation = await world.io().observe(CAMPAIGN);
    (observation.packages["@comforge/ledger"] as PackageObservation).pin = { version: "0.2.0", integrity: "x" };
    const view = deriveCampaign({ campaign: CAMPAIGN, observation, checkpoint: null });
    expect(view.holds[0]?.ok).toBe(false);
    expect(view.complete).toBe(false);
  });
});

describe("campaign prerequisites in the existing commands", () => {
  // The CLI still pins github 0.5.0 while core's pin moves; without rewiring, its tests import
  // the installed github 0.4.0, fail, and consumer:update rolls the pin back.
  test("consumer:update rewires sibling candidates before it runs the package tests", () => {
    const source = readFileSync(path.join(import.meta.dir, "../../tooling/release/consumerUpdate.ts"), "utf8");
    const ensure = source.indexOf('"tooling/release/candidates.ts", "ensure"');
    const tests = source.indexOf('"test", "--isolate", ...allTests()');
    expect(ensure).toBeGreaterThan(0);
    expect(ensure).toBeLessThan(tests);
  });
});
