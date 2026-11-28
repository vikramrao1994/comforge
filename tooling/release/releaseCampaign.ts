/**
 * `bun run release:campaign <plan|status|resume|unlock> [--campaign FILE] [--execute] [--retry-failed] [--json]`
 *
 * One resumable, dependency-ordered release campaign over the existing release commands
 *. It is not a release system. The planner, the version PR, the
 * owner's signed approval, the publisher, the npm workflows and the consumer update each
 * stay the only writer of what they write today. The campaign only reads their results and
 * says which step is next:
 *
 * - `plan` reads the committed campaign file and the observed state, and prints the
 *  per-package stages. It writes nothing.
 * - `status` does the same under the campaign lock, then records a non-secret checkpoint.
 * - `resume` also takes the next step, if an agent may take it. Only two such steps exist:
 *  `release:version-pr --open` and `release:adopt --open`. Without
 *  `--execute` it only prints that step. At most one step runs per invocation.
 * - `unlock` removes a lock whose holder process is gone.
 *
 * Publication, approval and merging are never campaign steps. Approving a release run's
 * comforge-release environment, the first-release bootstrap and every merge stop the campaign
 * with the owner's exact next action and the resume command. A campaign is not a blanket
 * approval: each package is published only by a run that built its own candidate and that the
 * owner approved.
 *
 * Trust: the state comes from the authoritative sources on every run: origin/main, the
 * public mirror's tags, the npm registry and the GitHub runs and PRs. The checkpoint never
 * decides that something happened. It only lets the campaign refuse when a fact it already
 * recorded (a tag commit, a registry integrity, an adopted pin) has changed, and it carries
 * a step that was started but whose result is unknown until the observed state settles it.
 * Exactly-once publication is not claimed. The campaign never requests one, and the
 * publisher refuses a reused version.
 */
import { spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { MIRROR_REPOSITORY } from "./mirror";
import { PACKAGES, type PackageName, type PackageProfile, profileOf } from "./packages";
import { digestOf, type PlanStatus } from "./releasePlan";

export const CAMPAIGN_SCHEMA = "comforge-release-campaign/v1";
export const CHECKPOINT_SCHEMA = "comforge-release-campaign-checkpoint/v1";
export const DEFAULT_CAMPAIGN = "releases/campaigns/comforge-release-001.json";

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const Name = z.string().refine((n) => Object.hasOwn(PACKAGES, n), "not a registry package");
const Version = z.string().regex(SEMVER, "an exact MAJOR.MINOR.PATCH");

export const CampaignSchema = z
  .object({
    schema: z.literal(CAMPAIGN_SCHEMA),
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{2,63}$/),
    issue: z.number().int().positive().optional(),
    packages: z
      .array(
        z
          .object({
            package: Name,
            version: Version,
            firstRelease: z.boolean().default(false),
          })
          .strict(),
      )
      .min(1),
    hold: z.array(z.object({ package: Name, version: Version }).strict()).default([]),
    /**
     * Packages the consumer adopts together, in one consumer update. Needed when an installed
     * release requires another package's previous version exactly (cli 0.2.0 pins core 0.1.2),
     * so adopting one alone would install a nested copy. Unlisted packages adopt alone.
     */
    adopt: z.array(z.array(Name).min(2)).default([]),
    /**
     * Packages whose version fields are prepared in one version PR (`version-pr` with every
     * member). It saves a pull request and nothing else: each member is still approved,
     * published, read back and recorded on its own, and a dependent is not planned for approval
     * before its dependency's release record is on main. Unlisted packages get their own PR.
     */
    versionTogether: z.array(z.array(Name).min(2)).default([]),
  })
  .strict();
export type Campaign = z.infer<typeof CampaignSchema>;
export type Target = Campaign["packages"][number] & { package: PackageName };

/** The adoption group of a target, in campaign order (itself alone when unlisted). */
export function groupOf(campaign: Campaign, name: PackageName): Target[] {
  const group = campaign.adopt.find((g) => g.includes(name)) ?? [name];
  return campaign.packages.filter((p) => group.includes(p.package)) as Target[];
}

export type CampaignRefusalCode =
  | "campaign-invalid"
  | "campaign-order"
  | "campaign-changed"
  | "campaign-locked"
  | "checkpoint-invalid"
  | "secret-in-state"
  | "checkout-not-main"
  | "observation-failed";

export class CampaignRefusal extends Error {
  constructor(
    readonly code: CampaignRefusalCode,
    message: string,
  ) {
    super(`release:campaign refused (${code}): ${message}`);
  }
}

/** Validates a campaign: registry packages, each once, listed after its campaign dependencies. */
export function parseCampaign(raw: unknown): Campaign {
  const parsed = CampaignSchema.safeParse(raw);
  if (!parsed.success)
    throw new CampaignRefusal(
      "campaign-invalid",
      parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
    );
  const campaign = parsed.data;
  const members = campaign.packages.map((p) => p.package);
  const held = campaign.hold.map((h) => h.package);
  const all = [...members, ...held];
  if (new Set(all).size !== all.length)
    throw new CampaignRefusal("campaign-invalid", "a package is listed twice");
  members.forEach((name, i) => {
    for (const dep of profileOf(name).dependsOn) {
      const at = members.indexOf(dep);
      if (at > i)
        throw new CampaignRefusal(
          "campaign-order",
          `${name} is listed before its dependency ${dep}`,
        );
      if (at < 0 && !held.includes(dep))
        throw new CampaignRefusal(
          "campaign-order",
          `${name} depends on ${dep}, which the campaign neither releases nor holds`,
        );
    }
  });
  const grouped = campaign.adopt.flat();
  if (new Set(grouped).size !== grouped.length)
    throw new CampaignRefusal("campaign-invalid", "a package is in two adoption groups");
  for (const name of grouped)
    if (!members.includes(name as PackageName))
      throw new CampaignRefusal(
        "campaign-invalid",
        `adoption group member ${name} is not a campaign package`,
      );
  const versioned = campaign.versionTogether.flat();
  if (new Set(versioned).size !== versioned.length)
    throw new CampaignRefusal("campaign-invalid", "a package is in two version groups");
  for (const name of versioned)
    if (!members.includes(name as PackageName))
      throw new CampaignRefusal(
        "campaign-invalid",
        `version group member ${name} is not a campaign package`,
      );
  return campaign;
}

/** The members versioned in one PR with `name`, in campaign order (itself alone when unlisted). */
export function versionGroupOf(campaign: Campaign, name: PackageName): Target[] {
  const group = campaign.versionTogether.find((g) => g.includes(name)) ?? [name];
  return campaign.packages.filter((p) => group.includes(p.package)) as Target[];
}

/** The branch `version-pr` uses for these members (the planner's own naming). */
export const versionBranchOf = (group: readonly Target[]) =>
  group.length === 1
    ? `comforge-release/${profileOf((group[0] as Target).package).tagPrefix}${(group[0] as Target).version}`
    : `comforge-release/group-${group.map((t) => profileOf(t.package).id).join("-")}`;

// ── Observations (collected fresh on every run) ──────────────────────────────

export type PrRef = { number: number; state: "OPEN" | "MERGED" | "CLOSED" };
export type PlanObservation =
  | { kind: "plan"; status: PlanStatus; nextVersion: string | null; digest: string }
  | { kind: "refused"; code: string; message: string };
export type RunRef = { id: number; conclusion: string; headSha: string };

export type PackageObservation = {
  /** The planner at origin/main; only evaluated once every campaign dependency is ready. */
  plan: PlanObservation | null;
  versionPr: PrRef | null;
  consumerPr: PrRef | null;
  /** Commit the mirror's `<tagPrefix><target>` tag points at. */
  tagCommit: string | null;
  registry: { published: boolean; integrity: string | null; provenance: boolean };
  /** The mirror's npm workflow for this package has a run that has not finished. */
  npmRunInFlight: boolean;
  /** The latest successful candidate dry run of this package for origin/main. */
  candidateRun: RunRef | null;
  /** The committed release record (released/<id>/<target>) on origin/main. */
  record: { version: string; integrity: string } | null;
  recordPr: PrRef | null;
  /** The consumer pin record on origin/main. Its PR (`consumerPr`) is the adoption group's. */
  pin: { version: string; integrity: string } | null;
  /** The exact version in the root package.json on origin/main (null: not installed). */
  installed: string | null;
  /** First release only: the mirror's npm environment and rulesets for this package. */
  bootstrap: { environment: boolean; rulesets: boolean } | null;
};

export type Observation = {
  head: string;
  /** A Publish Comforge release run is queued or in progress. */
  publishInFlight: boolean;
  /** The latest publish (not candidate) run on origin/main, if any. */
  lastPublishRun: RunRef | null;
  packages: Partial<Record<PackageName, PackageObservation>>;
};

// ── Checkpoint (non-secret, durable, never authoritative) ─────────────────────

export type AgentAction = "open-version-pr" | "open-record-pr" | "open-pin-pr";

const Facts = z
  .object({
    planDigest: z.string().optional(),
    supersededPlans: z.array(z.string()).optional(),
    versionPr: z.number().int().optional(),
    candidateRun: z.number().int().optional(),
    tagCommit: z.string().optional(),
    integrity: z.string().optional(),
    provenance: z.boolean().optional(),
    pinPr: z.number().int().optional(),
    recordPr: z.number().int().optional(),
  })
  .strict();
const Action = z.enum(["open-version-pr", "open-record-pr", "open-pin-pr"]);
const PackageCheckpointSchema = z
  .object({
    stage: z.string(),
    facts: Facts,
    pending: z.object({ action: Action, startedAt: z.string() }).strict().optional(),
    failed: z.object({ action: Action, at: z.string(), message: z.string() }).strict().optional(),
  })
  .strict();
export const CheckpointSchema = z
  .object({
    schema: z.literal(CHECKPOINT_SCHEMA),
    campaign: z.string(),
    campaignDigest: z.string(),
    head: z.string(),
    updatedAt: z.string(),
    packages: z.record(z.string(), PackageCheckpointSchema),
    history: z.array(
      z.object({ at: z.string(), package: z.string(), from: z.string(), to: z.string() }).strict(),
    ),
  })
  .strict();
export type Checkpoint = z.infer<typeof CheckpointSchema>;
export type PackageCheckpoint = z.infer<typeof PackageCheckpointSchema>;

// ── Derivation (pure) ────────────────────────────────────────────────────────

export type Stage =
  | "waiting-dependency"
  | "planning"
  | "version-pr"
  | "approval"
  | "publishing"
  | "pinning"
  | "adopted"
  | "blocked";
export type Lifecycle = "planned" | "built" | "published" | "verified" | "adopted";

export type Step =
  | { by: "agent"; action: AgentAction; command: string }
  | { by: "owner"; action: string; detail: string; command?: string }
  | { by: "wait"; detail: string };

export type PackageState = {
  package: PackageName;
  target: string;
  stage: Stage;
  lifecycle: Lifecycle;
  step: Step | null;
  blockers: { code: string; detail: string }[];
  notes: string[];
  /** Ask the planner before deciding (set when the plan was not evaluated yet). */
  needsPlan: boolean;
  /** Published and verified; dependents in its adoption group may be planned. */
  released: boolean;
  checkpoint: PackageCheckpoint;
};

export type CampaignView = {
  campaign: string;
  head: string;
  packages: PackageState[];
  holds: { package: PackageName; version: string; pinned: string | null; ok: boolean }[];
  next: { package: PackageName; step: Step } | null;
  complete: boolean;
};

const blank = (): PackageCheckpoint => ({ stage: "planning", facts: {} });

/** The release-record step of a group member, or null once its record is on main and matches. */
function recordGate(
  obs: PackageObservation,
  cp: PackageCheckpoint,
  target: Target,
  flag: string,
): { step: Step; blocker?: undefined } | { blocker: { code: string; detail: string } } | null {
  const branch = `comforge-released/${profileOf(target.package).tagPrefix}${target.version}`;
  if (obs.record) {
    if (obs.record.integrity !== obs.registry.integrity)
      return {
        blocker: {
          code: "record-integrity-mismatch",
          detail: `the committed release record of ${target.package}@${target.version} does not match the registry's integrity`,
        },
      };
    return null;
  }
  if (obs.recordPr?.state === "OPEN")
    return {
      step: {
        by: "owner",
        action: "merge-record-pr",
        detail: `review and merge release record PR #${obs.recordPr.number} (verified readback; installs nothing)`,
      },
    };
  if (obs.recordPr?.state === "MERGED")
    return {
      blocker: {
        code: "record-not-on-main",
        detail: `release record PR #${obs.recordPr.number} is merged, but origin/main has no record for ${target.version}`,
      },
    };
  if (obs.recordPr?.state === "CLOSED")
    return {
      blocker: {
        code: "record-pr-closed",
        detail: `release record PR #${obs.recordPr.number} was closed unmerged; the owner decides how to continue`,
      },
    };
  if (cp.pending?.action === "open-record-pr")
    return {
      blocker: {
        code: "pending-unconfirmed",
        detail: `open-record-pr started ${cp.pending.startedAt} and no PR exists; check origin for ${branch}, then delete the branch or open its PR, and clear the pending step with --retry-failed`,
      },
    };
  if (cp.failed?.action === "open-record-pr")
    return {
      blocker: {
        code: "record-failed",
        detail: `${cp.failed.message} (${cp.failed.at}); rerun with --retry-failed after fixing the cause`,
      },
    };
  return {
    step: {
      by: "agent",
      action: "open-record-pr",
      command: `bun run release:record ${flag} --version ${target.version} --open`,
    },
  };
}

/**
 * Pure: one package's stage from its observation, the checkpoint and the packages already
 * adopted. Reaching a stage requires the evidence for it, never a checkpoint entry alone.
 */
export function derivePackage(input: {
  target: Target;
  obs: PackageObservation;
  checkpoint: PackageCheckpoint | undefined;
  /** Campaign members already adopted, plus held packages pinned at their version. */
  ready: ReadonlySet<PackageName>;
  /** Members released ahead of their adoption group (record committed, or published last). */
  released?: ReadonlySet<PackageName>;
  /** The target's adoption group in campaign order (default: itself alone). */
  group?: readonly Target[];
  /** The members versioned in one PR with the target (default: itself alone). */
  versionGroup?: readonly Target[];
  publishInFlight: boolean;
  lastPublishRun: RunRef | null;
  head: string;
  retryFailed: boolean;
}): PackageState {
  const { target, obs } = input;
  const profile = profileOf(target.package);
  const cp: PackageCheckpoint = structuredClone(input.checkpoint ?? blank());
  delete cp.failed;
  if (input.checkpoint?.failed && !input.retryFailed) cp.failed = input.checkpoint.failed;
  const facts = cp.facts;
  const blockers: PackageState["blockers"] = [];
  const notes: string[] = [];
  const flag = `--package ${profile.name}`;
  const group = input.group ?? [target];
  const released = input.released ?? new Set<PackageName>();
  const isLast = group.at(-1)?.package === target.package;
  let releasedNow = false;
  const state = (
    stage: Stage,
    lifecycle: Lifecycle,
    step: Step | null,
    needsPlan = false,
  ): PackageState => {
    cp.stage = blockers.length > 0 ? "blocked" : stage;
    return {
      package: target.package,
      target: target.version,
      stage: blockers.length > 0 ? "blocked" : stage,
      lifecycle,
      step: blockers.length > 0 ? null : step,
      blockers,
      notes,
      needsPlan,
      released: releasedNow && blockers.length === 0,
      checkpoint: cp,
    };
  };
  const block = (code: string, detail: string, lifecycle: Lifecycle) => {
    blockers.push({ code, detail });
    return state("blocked", lifecycle, null);
  };

  // A fact recorded at a completed stage can never change; a change is a reconciliation for the owner.
  if (facts.tagCommit && obs.tagCommit && facts.tagCommit !== obs.tagCommit)
    return block(
      "checkpoint-conflict",
      `${profile.tagPrefix}${target.version} now points at ${obs.tagCommit}, recorded ${facts.tagCommit}`,
      "published",
    );
  if (facts.integrity && obs.registry.integrity && facts.integrity !== obs.registry.integrity)
    return block(
      "checkpoint-conflict",
      `the registry integrity of ${target.package}@${target.version} changed since it was recorded`,
      "published",
    );
  if (input.checkpoint?.stage === "adopted" && obs.pin?.version !== target.version)
    return block(
      "checkpoint-conflict",
      `${target.package} was adopted at ${target.version}, origin/main now pins ${obs.pin?.version ?? "nothing"}`,
      "adopted",
    );

  // A started step whose result was lost: the observed state settles it, never a re-run.
  const pending = input.checkpoint?.pending;
  if (pending) {
    const pr =
      pending.action === "open-version-pr"
        ? obs.versionPr
        : pending.action === "open-record-pr"
          ? obs.recordPr
          : obs.consumerPr;
    if (pr) {
      delete cp.pending;
      if (pending.action === "open-version-pr") facts.versionPr = pr.number;
      else if (pending.action === "open-record-pr") facts.recordPr = pr.number;
      else facts.pinPr = pr.number;
      notes.push(`reconciled ${pending.action} from ${pending.startedAt}: PR #${pr.number} exists`);
    }
  }

  const consumed = profile.consumedDownstream;
  if (
    obs.pin?.version === target.version &&
    (!consumed || obs.installed === target.version) &&
    obs.registry.published
  ) {
    if (obs.pin.integrity !== obs.registry.integrity)
      return block(
        "pin-integrity-mismatch",
        `origin/main's pin integrity differs from the registry's ${target.package}@${target.version}`,
        "adopted",
      );
    facts.integrity ??= obs.registry.integrity ?? undefined;
    facts.tagCommit ??= obs.tagCommit ?? undefined;
    if (!consumed)
      notes.push("pinned only: no consumer installs it; production integration is a separate gate");
    return state("adopted", "adopted", null);
  }

  if (obs.registry.published) {
    if (!obs.tagCommit)
      return block(
        "registry-without-tag",
        `${target.package}@${target.version} is on the registry but ${MIRROR_REPOSITORY} has no ${profile.tagPrefix}${target.version}; never republish, reconcile by hand`,
        "published",
      );
    if (!target.firstRelease && !obs.registry.provenance)
      return block(
        "provenance-missing",
        `${target.package}@${target.version} has no provenance attestation; only a first-release bootstrap may lack one`,
        "published",
      );
    if (target.firstRelease && !obs.registry.provenance)
      notes.push(
        "bootstrap version without provenance (owner's manual first publish); later versions must carry it",
      );
    facts.tagCommit = obs.tagCommit;
    facts.integrity = obs.registry.integrity ?? undefined;
    facts.provenance = obs.registry.provenance;
    if (obs.consumerPr) facts.pinPr = obs.consumerPr.number;
    if (group.length > 1 && !obs.consumerPr) {
      // Adopted with its group. A member that a later member pins exactly is released for
      // planning only by its committed release record.
      const at = group.findIndex((m) => m.package === target.package);
      const needsRecord = group
        .slice(at + 1)
        .some((m) => profileOf(m.package).dependsOn.includes(target.package));
      if (needsRecord) {
        const recordStep = recordGate(obs, cp, target, flag);
        if (recordStep)
          return recordStep.blocker
            ? block(recordStep.blocker.code, recordStep.blocker.detail, "published")
            : state("pinning", "published", recordStep.step);
        facts.recordPr ??= obs.recordPr?.number;
      }
      releasedNow = true;
      const others = group.filter((m) => m.package !== target.package);
      const waiting = others.filter((m) => !released.has(m.package)).map((m) => m.package);
      if (!isLast || waiting.length > 0)
        return state("pinning", "verified", {
          by: "wait",
          detail: `adopted together with ${others.map((m) => m.package).join(", ")} in one consumer update${waiting.length > 0 ? `; waits for ${waiting.join(", ")} to be released` : ""}`,
        });
    } else if (group.length > 1 && !isLast) {
      releasedNow = true;
      return state("pinning", "verified", {
        by: "wait",
        detail: `adopted with its group in PR #${obs.consumerPr?.number}; see ${group.at(-1)?.package}`,
      });
    }
    if (obs.consumerPr?.state === "OPEN")
      return state("pinning", "verified", {
        by: "owner",
        action: "merge-pin-pr",
        detail: `review and merge PR #${obs.consumerPr.number} (exact dependency, bun.lock, read-back pin record)`,
      });
    if (obs.consumerPr?.state === "MERGED")
      return block(
        "pin-not-on-main",
        `pin PR #${obs.consumerPr.number} is merged, but origin/main does not pin ${target.version}`,
        "verified",
      );
    if (obs.consumerPr?.state === "CLOSED")
      return block(
        "pin-pr-closed",
        `pin PR #${obs.consumerPr.number} was closed unmerged; the owner decides whether to reopen it or prepare a new one`,
        "published",
      );
    if (cp.pending?.action === "open-pin-pr")
      return block(
        "pending-unconfirmed",
        `open-pin-pr started ${cp.pending.startedAt} and no PR exists; check origin for ${consumerBranchOf(target)}, then delete the branch or open its PR, and clear the pending step with --retry-failed`,
        "published",
      );
    if (cp.failed?.action === "open-pin-pr")
      return block(
        "pin-failed",
        `${cp.failed.message} (${cp.failed.at}); consumer:update restored the previous pin; rerun with --retry-failed after fixing the cause`,
        "published",
      );
    if (!consumed)
      return state("pinning", "published", {
        by: "owner",
        action: "authorize-adoption-pr",
        detail: `${target.package} is not installed by a consumer, so its pin is a reviewed implementation change: read it back${target.firstRelease ? " (without --expect-provenance for the bootstrap version)" : " --expect-provenance"} and commit the pin record`,
        command: `bun run release:npm-readback ${flag} --commit ${obs.tagCommit}${target.firstRelease ? "" : " --expect-provenance"} --write-pin ${profile.pinDir}`,
      });
    return state("pinning", "published", {
      by: "agent",
      action: "open-pin-pr",
      command: `bun run release:adopt ${group.map((m) => `--package ${m.package} --version ${m.version}`).join(" ")} --open`,
    });
  }

  if (obs.tagCommit) {
    facts.tagCommit = obs.tagCommit;
    if (target.firstRelease)
      return state("publishing", "built", {
        by: "owner",
        action: "bootstrap-publish",
        detail: `first release: npm can attach a Trusted Publisher only to an existing package. Plan the tarball, publish it once by hand with 2FA, read it back without --expect-provenance, then add the Trusted Publisher (${profile.npmWorkflow.split("/").pop()}, environment npm-${profile.id})`,
        command: `bun run release:npm-plan ${flag} --commit ${obs.tagCommit}`,
      });
    return state("publishing", "built", {
      by: "owner",
      action: "approve-npm-publication",
      detail: obs.npmRunInFlight
        ? `the ${profile.npmWorkflow.split("/").pop()} run (environment npm-${profile.id}) in ${MIRROR_REPOSITORY} is publishing; approve it if its environment still asks for a reviewer`
        : `the tag exists but no npm run is in flight and the version is not public: check the ${profile.npmWorkflow.split("/").pop()} run for ${profile.tagPrefix}${target.version}. The tag is immutable, so never dispatch the release workflow again for this version`,
    });
  }

  // Inside an adoption group a dependency need only be released; across groups it is adopted.
  const missing = profile.dependsOn.filter(
    (dep) => !input.ready.has(dep) && !(released.has(dep) && group.some((m) => m.package === dep)),
  );
  if (missing.length > 0) {
    notes.push(
      `waits for ${missing.join(", ")} to be published, read back and pinned (or released, within its adoption group)`,
    );
    return state("waiting-dependency", "planned", {
      by: "wait",
      detail: `dependency gate: ${missing.join(", ")} first`,
    });
  }
  if (input.publishInFlight)
    return state("publishing", "planned", {
      by: "wait",
      detail:
        "a Publish Comforge release run is queued or in progress; let it finish, then run status again. Never approve a second publication while one is in flight",
    });

  const plan = obs.plan;
  if (!plan) return state("planning", "planned", null, true);
  if (plan.kind === "refused") return block(`plan-${plan.code}`, plan.message, "planned");
  if (plan.status === "no-release" || plan.nextVersion !== target.version)
    return block(
      "target-mismatch",
      `the planner gives ${plan.status === "no-release" ? "no release" : plan.nextVersion}; the campaign targets ${target.version}. Change the campaign file through review, or add the missing intent`,
      "planned",
    );

  if (plan.status === "version-pr-due") {
    if (obs.versionPr) facts.versionPr = obs.versionPr.number;
    if (obs.versionPr?.state === "OPEN")
      return state("version-pr", "planned", {
        by: "owner",
        action: "merge-version-pr",
        detail: `review and merge version PR #${obs.versionPr.number}`,
      });
    if (obs.versionPr?.state === "MERGED")
      return block(
        "version-pr-stale",
        `version PR #${obs.versionPr.number} is merged but the plan is still version-pr-due (its changelog no longer matches the intents); prepare a refreshed version PR on a new branch`,
        "planned",
      );
    if (obs.versionPr?.state === "CLOSED")
      return block(
        "version-pr-closed",
        `version PR #${obs.versionPr.number} was closed unmerged; the owner decides how to continue`,
        "planned",
      );
    if (cp.pending?.action === "open-version-pr")
      return block(
        "pending-unconfirmed",
        `open-version-pr started ${cp.pending.startedAt} and no PR exists; check origin for comforge-release/${profile.tagPrefix}${target.version}, then delete the branch or open its PR, and clear the pending step with --retry-failed`,
        "planned",
      );
    if (cp.failed?.action === "open-version-pr")
      return block(
        "version-pr-failed",
        `${cp.failed.message} (${cp.failed.at}); rerun with --retry-failed after fixing the cause`,
        "planned",
      );
    return state("version-pr", "planned", {
      by: "agent",
      action: "open-version-pr",
      command: `bun run release:version-pr --open ${(input.versionGroup ?? [target])
        .map((t) => `--package ${t.package}`)
        .join(" ")}`,
    });
  }

  // release-ready: the version is on main; what remains is the owner's signed approval.
  if (facts.planDigest && facts.planDigest !== plan.digest) {
    facts.supersededPlans = [...(facts.supersededPlans ?? []), facts.planDigest];
    notes.push(
      "the release plan changed since the last checkpoint: any earlier candidate and approval are void; approve the new candidate",
    );
    delete facts.candidateRun;
  }
  facts.planDigest = plan.digest;
  if (target.firstRelease && obs.bootstrap) {
    const setup: string[] = [];
    if (!obs.bootstrap.rulesets)
      setup.push(
        `rulesets protecting releases/${profile.id} and ${profile.tagPrefix}* in ${MIRROR_REPOSITORY}`,
      );
    if (!obs.bootstrap.environment)
      setup.push(
        `environment npm-${profile.id} (owner as required reviewer, deployment tags ${profile.tagPrefix}*) in ${MIRROR_REPOSITORY}`,
      );
    if (setup.length > 0)
      return state("approval", "planned", {
        by: "owner",
        action: "first-release-setup",
        detail: `before the first ${target.package} release: ${setup.join("; ")}; COMFORGE_RELEASE_TOKEN Workflows: write for this release only (restore to No access afterwards)`,
      });
  }
  const built = obs.candidateRun?.headSha === input.head;
  if (built && obs.candidateRun) facts.candidateRun = obs.candidateRun.id;
  if (input.lastPublishRun?.headSha === input.head && input.lastPublishRun.conclusion === "failure")
    notes.push(
      `publish run ${input.lastPublishRun.id} on this commit failed and pushed no tag; its approval is consumed, so a new candidate needs a new approval`,
    );
  return state("approval", built ? "built" : "planned", {
    by: "owner",
    action: "approve-release",
    detail: `approve the comforge-release environment of the release run for ${target.version} after reviewing its candidate summary; a first release also changes the npm workflow, shown there`,
    command: `bun run release:dispatch package=${profileOf(target.package).id}`,
  });
}

const consumerBranchOf = (t: Target) =>
  `comforge-consumer/${profileOf(t.package).tagPrefix}${t.version}`;

/** The consumer-update branch of an adoption group (`release:adopt`'s groupBranch). */
export const groupBranchOf = (group: readonly Target[]) =>
  group.length === 1
    ? consumerBranchOf(group[0] as Target)
    : `comforge-consumer/${group.map((t) => `${profileOf(t.package).tagPrefix}${t.version}`).join("+")}`;

/** Pure: every package's state, in campaign order, and the one next step. */
export function deriveCampaign(input: {
  campaign: Campaign;
  observation: Observation;
  checkpoint: Checkpoint | null;
  retryFailed?: boolean;
}): CampaignView {
  const { campaign, observation } = input;
  const ready = new Set<PackageName>();
  const released = new Set<PackageName>();
  const holds = campaign.hold.map((h) => {
    const pinned = observation.packages[h.package as PackageName]?.pin?.version ?? null;
    const ok = pinned === h.version;
    if (ok) ready.add(h.package as PackageName);
    return { package: h.package as PackageName, version: h.version, pinned, ok };
  });
  const packages: PackageState[] = [];
  for (const raw of campaign.packages) {
    const target = raw as Target;
    const obs = observation.packages[target.package];
    if (!obs)
      throw new CampaignRefusal("observation-failed", `no observation for ${target.package}`);
    const s = derivePackage({
      target,
      obs,
      checkpoint: input.checkpoint?.packages[target.package],
      ready,
      released,
      group: groupOf(campaign, target.package),
      versionGroup: versionGroupOf(campaign, target.package),
      publishInFlight: observation.publishInFlight,
      lastPublishRun: observation.lastPublishRun,
      head: observation.head,
      retryFailed: input.retryFailed ?? false,
    });
    for (const h of holds)
      if (!h.ok && profileOf(target.package).dependsOn.includes(h.package))
        s.notes.push(
          `held ${h.package} must stay pinned at ${h.version} (origin/main: ${h.pinned})`,
        );
    if (s.stage === "adopted") ready.add(target.package);
    if (s.released) released.add(target.package);
    packages.push(s);
  }
  // Strict order: the earliest package that is not adopted owns the next step. A member released
  // ahead of its adoption group only waits for the group's last member, so it is passed over.
  const pending = packages.filter((p) => p.stage !== "adopted");
  const first = pending.find((p) => !(p.released && p.step?.by === "wait")) ?? pending[0];
  return {
    campaign: campaign.id,
    head: observation.head,
    packages,
    holds,
    next: first?.step ? { package: first.package, step: first.step } : null,
    complete: !first && holds.every((h) => h.ok),
  };
}

// ── Checkpoint storage ───────────────────────────────────────────────────────

/** Credentials that must never reach campaign state (npm, GitHub, PEM keys). */
const SECRET =
  /npm_[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----/;

export function assertNoSecret(text: string): void {
  if (SECRET.test(text))
    throw new CampaignRefusal(
      "secret-in-state",
      "refusing to write a credential into campaign state",
    );
}

export function readCheckpoint(file: string): Checkpoint | null {
  if (!existsSync(file)) return null;
  const parsed = CheckpointSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
  if (!parsed.success)
    throw new CampaignRefusal("checkpoint-invalid", `${file}: ${parsed.error.issues[0]?.message}`);
  return parsed.data;
}

/** Atomic: a crash leaves the previous checkpoint or the new one, never half of one. */
export function writeCheckpoint(file: string, checkpoint: Checkpoint): void {
  const text = `${JSON.stringify(CheckpointSchema.parse(checkpoint), null, 2)}\n`;
  assertNoSecret(text);
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, file);
}

export function nextCheckpoint(
  campaign: Campaign,
  view: CampaignView,
  previous: Checkpoint | null,
  now: string,
): Checkpoint {
  const history = [...(previous?.history ?? [])];
  for (const p of view.packages) {
    const from = previous?.packages[p.package]?.stage ?? "new";
    if (from !== p.checkpoint.stage)
      history.push({ at: now, package: p.package, from, to: p.checkpoint.stage });
  }
  return {
    schema: CHECKPOINT_SCHEMA,
    campaign: campaign.id,
    campaignDigest: digestOf(campaign),
    head: view.head,
    updatedAt: now,
    packages: Object.fromEntries(view.packages.map((p) => [p.package, p.checkpoint])),
    history,
  };
}

// ── Lock (one campaign invocation at a time) ─────────────────────────────────

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

export function acquireLock(file: string, now: string): () => void {
  mkdirSync(path.dirname(file), { recursive: true });
  let fd: number;
  try {
    fd = openSync(file, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const holder = readFileSync(file, "utf8").trim();
    throw new CampaignRefusal(
      "campaign-locked",
      `another invocation holds ${file} (${holder}); wait for it, or run unlock if that process is gone`,
    );
  }
  writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: now }));
  closeSync(fd);
  return () => rmSync(file, { force: true });
}

/** Removes the lock only when its holder process no longer runs. */
export function releaseStaleLock(file: string): boolean {
  if (!existsSync(file)) return false;
  const { pid } = JSON.parse(readFileSync(file, "utf8")) as { pid: number };
  if (alive(pid))
    throw new CampaignRefusal("campaign-locked", `process ${pid} still holds ${file}`);
  rmSync(file, { force: true });
  return true;
}

// ── Runner ───────────────────────────────────────────────────────────────────

export type CampaignIo = {
  observe(campaign: Campaign): Promise<Observation>;
  /** Fills `plan` for one package at the observed head. */
  plan(pkg: PackageName, head: string): Promise<PlanObservation>;
  /** Runs one agent step; resolves only when its command succeeded. */
  /** `targets`: the adoption group for `open-pin-pr`, else the one package. */
  execute(action: AgentAction, targets: readonly Target[], head: string): Promise<void>;
  /** Refuses before a step when the local checkout cannot run it (dirty, not origin/main). */
  assertRunnable(head: string): void;
};

export type CampaignResult = { view: CampaignView; executed: AgentAction | null; exitCode: number };

/** 0 complete or advanced · 3 waiting for the owner or a dependency · 1 blocked. */
export function exitCodeOf(view: CampaignView, executed: boolean): number {
  if (view.complete || executed) return 0;
  if (view.packages.some((p) => p.stage === "blocked")) return 1;
  return 3;
}

async function observeAndDerive(
  io: CampaignIo,
  campaign: Campaign,
  checkpoint: Checkpoint | null,
  retryFailed: boolean,
) {
  const observation = await io.observe(campaign);
  let view = deriveCampaign({ campaign, observation, checkpoint, retryFailed });
  // Plan lazily: only the package whose dependencies are adopted, so a refusal for an unreleased
  // dependency is never mistaken for a blocker of the campaign.
  for (;;) {
    const due = view.packages.find((p) => p.needsPlan);
    if (!due) return { observation, view };
    const obs = observation.packages[due.package] as PackageObservation;
    obs.plan = await io.plan(due.package, observation.head);
    view = deriveCampaign({ campaign, observation, checkpoint, retryFailed });
  }
}

export async function runCampaign(options: {
  command: "plan" | "status" | "resume";
  campaign: Campaign;
  stateDir: string;
  io: CampaignIo;
  execute?: boolean;
  retryFailed?: boolean;
  now?: () => string;
}): Promise<CampaignResult> {
  const now = options.now ?? (() => new Date().toISOString());
  const { campaign, io } = options;
  const file = path.join(options.stateDir, `${campaign.id}.json`);
  const checkpoint = readCheckpoint(file);
  if (checkpoint && checkpoint.campaignDigest !== digestOf(campaign))
    throw new CampaignRefusal(
      "campaign-changed",
      `${campaign.id} changed since its checkpoint; a changed campaign is a new campaign (new id), so recorded facts are never applied to other targets`,
    );
  if (options.command === "plan") {
    const { view } = await observeAndDerive(io, campaign, checkpoint, false);
    return { view, executed: null, exitCode: exitCodeOf(view, false) };
  }
  const release = acquireLock(path.join(options.stateDir, `${campaign.id}.lock`), now());
  try {
    const retry = options.retryFailed ?? false;
    const base =
      retry && checkpoint
        ? {
            ...checkpoint,
            packages: Object.fromEntries(
              Object.entries(checkpoint.packages).map(([k, v]) => {
                const { pending: _p, failed: _f, ...rest } = v;
                return [k, rest];
              }),
            ),
          }
        : checkpoint;
    const { observation, view } = await observeAndDerive(io, campaign, base, retry);
    let state = nextCheckpoint(campaign, view, checkpoint, now());
    writeCheckpoint(file, state);
    const next = view.next;
    if (options.command !== "resume" || !options.execute || next?.step.by !== "agent")
      return { view, executed: null, exitCode: exitCodeOf(view, false) };

    const target = campaign.packages.find((p) => p.package === next.package) as Target;
    io.assertRunnable(observation.head);
    const entry = state.packages[next.package] as PackageCheckpoint;
    // Record the start first: a crash or a lost response leaves a pending step that the next
    // run reconciles against the observed PR instead of running the command again.
    entry.pending = { action: next.step.action, startedAt: now() };
    writeCheckpoint(file, state);
    try {
      await io.execute(
        next.step.action,
        next.step.action === "open-pin-pr"
          ? groupOf(campaign, target.package)
          : next.step.action === "open-version-pr"
            ? versionGroupOf(campaign, target.package)
            : [target],
        observation.head,
      );
    } catch (error) {
      delete entry.pending;
      entry.failed = {
        action: next.step.action,
        at: now(),
        message: (error as Error).message.slice(0, 500),
      };
      writeCheckpoint(file, state);
      const failed = await observeAndDerive(io, campaign, state, false);
      return { view: failed.view, executed: null, exitCode: 1 };
    }
    const after = await observeAndDerive(io, campaign, state, false);
    state = nextCheckpoint(campaign, after.view, state, now());
    writeCheckpoint(file, state);
    return { view: after.view, executed: next.step.action, exitCode: 0 };
  } finally {
    release();
  }
}

export function renderView(view: CampaignView, resume: string): string {
  const lines = [`campaign ${view.campaign} at ${view.head.slice(0, 12)}`];
  for (const p of view.packages) {
    lines.push(`  ${p.package} → ${p.target}: ${p.stage} (${p.lifecycle})`);
    for (const b of p.blockers) lines.push(`    BLOCKED ${b.code}: ${b.detail}`);
    for (const n of p.notes) lines.push(`    note: ${n}`);
    if (p.step?.by === "agent") lines.push(`    next (agent): ${p.step.command}`);
    if (p.step?.by === "owner")
      lines.push(
        `    next (owner, ${p.step.action}): ${p.step.detail}`,
        ...(p.step.command ? [`      ${p.step.command}`] : []),
      );
    if (p.step?.by === "wait") lines.push(`    waiting: ${p.step.detail}`);
  }
  for (const h of view.holds)
    lines.push(
      `  hold ${h.package} ${h.version}: ${h.ok ? "pinned" : `NOT pinned (origin/main: ${h.pinned})`}`,
    );
  if (view.complete) lines.push("complete: every package is published, read back and pinned");
  else if (view.next)
    lines.push(`next: ${view.next.package} (${view.next.step.by}); then ${resume}`);
  return lines.join("\n");
}

// ── Real observation and execution (read-only except the two agent steps) ────

const REPO = path.resolve(import.meta.dir, "..", "..");

function run(cmd: string, args: string[], cwd = REPO) {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  return { ok: r.status === 0, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
}
function must(cmd: string, args: string[]) {
  const r = run(cmd, args);
  if (!r.ok)
    throw new CampaignRefusal("observation-failed", `${cmd} ${args.join(" ")}: ${r.err || r.out}`);
  return r.out;
}
const ghJson = <T>(args: string[]): T => JSON.parse(must("gh", args) || "null") as T;

const UNFINISHED = new Set(["queued", "in_progress", "waiting", "requested", "pending"]);

function prOf(branch: string): PrRef | null {
  const prs = ghJson<PrRef[]>([
    "pr",
    "list",
    "--head",
    branch,
    "--state",
    "all",
    "--json",
    "number,state",
    "--limit",
    "1",
  ]);
  return prs[0] ?? null;
}

async function registryOf(p: PackageProfile, version: string) {
  const res = await fetch(`https://registry.npmjs.org/${p.name.replace("/", "%2f")}`);
  if (res.status === 404) return { published: false, integrity: null, provenance: false };
  if (!res.ok)
    throw new CampaignRefusal("observation-failed", `registry HTTP ${res.status} for ${p.name}`);
  const doc = (await res.json()) as {
    versions?: Record<
      string,
      { dist?: { integrity?: string; attestations?: { provenance?: unknown } | null } }
    >;
  };
  const v = doc.versions?.[version];
  return {
    published: Boolean(v),
    integrity: v?.dist?.integrity ?? null,
    provenance: Boolean(v?.dist?.attestations?.provenance),
  };
}

export function realIo(): CampaignIo {
  return {
    async observe(campaign) {
      must("git", ["fetch", "-q", "origin", "main"]);
      const head = must("git", ["rev-parse", "origin/main"]);
      const show = (file: string) => run("git", ["show", `origin/main:${file}`]);
      const rootDeps =
        (JSON.parse(show("package.json").out) as { dependencies?: Record<string, string> })
          .dependencies ?? {};
      const tags = new Map<string, string>();
      for (const line of must("git", [
        "ls-remote",
        `https://github.com/${MIRROR_REPOSITORY}.git`,
        "refs/tags/*",
      ]).split("\n")) {
        const [sha, ref] = line.split("\t");
        if (!sha || !ref) continue;
        const name = ref.replace(/^refs\/tags\//, "").replace(/\^\{\}$/, "");
        if (ref.endsWith("^{}") || !tags.has(name)) tags.set(name, sha);
      }
      type Run = {
        databaseId: number;
        displayTitle: string;
        status: string;
        conclusion: string;
        headSha: string;
      };
      const runs = ghJson<Run[]>([
        "run",
        "list",
        "--workflow",
        "release.yml",
        "--limit",
        "30",
        "--json",
        "databaseId,displayTitle,status,conclusion,headSha",
      ]);
      const publishRuns = runs.filter((r) => r.displayTitle.startsWith("Comforge release "));
      const lastPublish = publishRuns.find((r) => r.headSha === head);
      const mirror = (args: string[]) => run("gh", [...args, "-R", MIRROR_REPOSITORY]);
      const environments = new Set(
        JSON.parse(
          must("gh", [
            "api",
            `repos/${MIRROR_REPOSITORY}/environments`,
            "--jq",
            "[.environments[].name]",
          ]),
        ) as string[],
      );
      const rulesets = new Set(
        JSON.parse(
          must("gh", ["api", `repos/${MIRROR_REPOSITORY}/rulesets`, "--jq", "[.[].name]"]),
        ) as string[],
      );
      const packages: Observation["packages"] = {};
      const names = [
        ...campaign.packages.map((p) => p.package),
        ...campaign.hold.map((h) => h.package),
      ] as PackageName[];
      for (const name of names) {
        const profile = profileOf(name);
        const target = campaign.packages.find((p) => p.package === name);
        const version =
          target?.version ?? campaign.hold.find((h) => h.package === name)?.version ?? "";
        const pinText = show(`${profile.pinDir}/npm-pin.json`);
        const pin = pinText.ok
          ? (JSON.parse(pinText.out) as { version: string; integrity: string })
          : null;
        const npmRuns = mirror([
          "run",
          "list",
          "--workflow",
          path.basename(profile.npmWorkflow),
          "--limit",
          "5",
          "--json",
          "status",
        ]);
        const candidate = runs.find(
          (r) =>
            r.displayTitle === `Comforge ${profile.id} candidate` &&
            r.headSha === head &&
            r.conclusion === "success",
        );
        packages[name] = {
          plan: null,
          versionPr:
            prOf(`comforge-release/${profile.tagPrefix}${version}`) ??
            (target && versionGroupOf(campaign, name).length > 1
              ? prOf(versionBranchOf(versionGroupOf(campaign, name)))
              : null),
          consumerPr: prOf(
            target
              ? groupBranchOf(groupOf(campaign, name))
              : `comforge-consumer/${profile.tagPrefix}${version}`,
          ),
          record: (() => {
            const r = show(`releases/records/${profile.id}/${version}/npm-pin.json`);
            if (!r.ok) return null;
            const rec = JSON.parse(r.out) as {
              package: string;
              version: string;
              integrity: string;
            };
            return rec.package === name && rec.version === version
              ? { version: rec.version, integrity: rec.integrity }
              : null;
          })(),
          recordPr: prOf(`comforge-released/${profile.tagPrefix}${version}`),
          tagCommit: tags.get(`${profile.tagPrefix}${version}`) ?? null,
          registry: await registryOf(profile, version),
          npmRunInFlight: npmRuns.ok
            ? (JSON.parse(npmRuns.out || "[]") as { status: string }[]).some((r) =>
                UNFINISHED.has(r.status),
              )
            : false,
          candidateRun: candidate
            ? {
                id: candidate.databaseId,
                conclusion: candidate.conclusion,
                headSha: candidate.headSha,
              }
            : null,
          pin: pin ? { version: pin.version, integrity: pin.integrity } : null,
          installed: rootDeps[name] ?? null,
          bootstrap: target?.firstRelease
            ? {
                environment: environments.has(`npm-${profile.id}`),
                rulesets:
                  rulesets.has(`protect-${profile.id}-releases`) &&
                  rulesets.has(`protect-${profile.id}-version-tags`),
              }
            : null,
        };
      }
      return {
        head,
        publishInFlight: runs.some((r) => UNFINISHED.has(r.status)),
        lastPublishRun: lastPublish
          ? {
              id: lastPublish.databaseId,
              conclusion: lastPublish.conclusion,
              headSha: lastPublish.headSha,
            }
          : null,
        packages,
      };
    },
    async plan(pkg, head) {
      // The planner reads the local install for candidate dependencies: run from an
      // up-to-date, installed checkout of origin/main.
      const dir = mkdtempSync(path.join(tmpdir(), "comforge-campaign-plan-"));
      const out = path.join(dir, "plan.json");
      try {
        const r = run("bun", [
          "tooling/release/releasePlan.ts",
          "plan",
          "--package",
          pkg,
          "--head",
          head,
          "--registry",
          "--json",
          "--out",
          out,
        ]);
        if (r.ok) {
          const plan = JSON.parse(readFileSync(out, "utf8")) as {
            status: PlanStatus;
            nextVersion: string | null;
            digest: string;
          };
          return {
            kind: "plan",
            status: plan.status,
            nextVersion: plan.nextVersion,
            digest: plan.digest,
          };
        }
        const m = /refused \(([a-z-]+)\): (.*)/.exec(r.err);
        if (!m)
          throw new CampaignRefusal("observation-failed", `planner failed for ${pkg}: ${r.err}`);
        return { kind: "refused", code: m[1] as string, message: m[2] as string };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    assertRunnable(head) {
      if (must("git", ["status", "--porcelain", "--untracked-files=no"]) !== "")
        throw new CampaignRefusal("checkout-not-main", "commit or discard tracked changes first");
      if (must("git", ["rev-parse", "HEAD"]) !== head)
        throw new CampaignRefusal(
          "checkout-not-main",
          `run resume from a checkout of origin/main (${head.slice(0, 12)})`,
        );
    },
    async execute(action, targets, head) {
      const start = must("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
      const one = targets[0] as Target;
      const args =
        action === "open-version-pr"
          ? [
              "tooling/release/releasePlan.ts",
              "version-pr",
              "--open",
              ...targets.flatMap((t) => ["--package", t.package]),
              "--head",
              head,
            ]
          : action === "open-record-pr"
            ? [
                "tooling/release/releaseRecord.ts",
                "--package",
                one.package,
                "--version",
                one.version,
                "--open",
              ]
            : [
                "tooling/release/consumerUpdate.ts",
                ...targets.flatMap((t) => ["--package", t.package, "--version", t.version]),
                "--open",
              ];
      const r = spawnSync("bun", args, { cwd: REPO, stdio: "inherit" });
      // The commands leave the checkout on their branch; return to where the campaign started.
      run("git", [
        "switch",
        "-q",
        start === "HEAD" ? "--detach" : start,
        ...(start === "HEAD" ? [head] : []),
      ]);
      if (action === "open-pin-pr") run("bun", ["install", "--frozen-lockfile"]);
      if (r.status !== 0) throw new Error(`${args[0]} exited with ${r.status}`);
    },
  };
}

/** Campaign state lives in the repository's Git directory: local, never committed, never pushed. */
export const stateDirOf = (repo = REPO) =>
  path.resolve(repo, must("git", ["rev-parse", "--git-common-dir"]), "comforge-campaign");

async function main(argv: string[]): Promise<number> {
  const arg = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const command = argv[0] ?? "plan";
  const file = arg("--campaign") ?? DEFAULT_CAMPAIGN;
  const campaign = parseCampaign(JSON.parse(readFileSync(path.resolve(REPO, file), "utf8")));
  const stateDir = stateDirOf();
  if (command === "unlock") {
    const removed = releaseStaleLock(path.join(stateDir, `${campaign.id}.lock`));
    console.log(removed ? "stale lock removed" : "no lock");
    return 0;
  }
  if (command !== "plan" && command !== "status" && command !== "resume")
    throw new Error(`unknown command ${command} (plan | status | resume | unlock)`);
  const result = await runCampaign({
    command,
    campaign,
    stateDir,
    io: realIo(),
    execute: argv.includes("--execute"),
    retryFailed: argv.includes("--retry-failed"),
  });
  const resume = `bun run release:campaign resume${file === DEFAULT_CAMPAIGN ? "" : ` --campaign ${file}`}`;
  console.log(
    argv.includes("--json") ? JSON.stringify(result, null, 2) : renderView(result.view, resume),
  );
  if (command === "resume" && !argv.includes("--execute") && result.view.next?.step.by === "agent")
    console.log(`dry run: pass --execute to run \`${result.view.next.step.command}\``);
  return result.exitCode;
}

if (import.meta.main) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error((error as Error).message);
      process.exit(error instanceof CampaignRefusal ? 1 : 2);
    });
}
