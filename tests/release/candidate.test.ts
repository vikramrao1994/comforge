import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  approvalFromCandidate,
  buildCandidateRecord,
  type CandidateInput,
  CandidateRefusal,
  ciProof,
  REQUIRED_CHECKS,
  renderCandidate,
} from "../../tooling/release/candidate";
import { INTENT_SCHEMA } from "../../tooling/release/releaseIntent";
import { evaluatePlan, type PlanInput } from "../../tooling/release/releasePlan";

const REPO = path.resolve(import.meta.dir, "../..");

// the owner approves a candidate, not a typed SHA. The
// publishing job derives the approval only from a candidate its own rebuild matches.

const SOURCE = "a".repeat(40);
const FILES = { "src/index.ts": "1", "dist/index.js": "2" };
const intent = {
  schema: INTENT_SCHEMA,
  package: "@comforge/core",
  bump: "patch",
  summary: "Fix a thing.",
  breaking: null,
  covers: [],
} as const;
const planInput: PlanInput = {
  package: "@comforge/core",
  head: SOURCE,
  baseline: { version: "0.1.2", sourceCommit: "0".repeat(40), files: FILES },
  headVersion: "0.1.3",
  changelog: "# C\n\n## 0.1.3\n\n- Fix a thing.\n\n## 0.1.2\n",
  candidateFiles: { ...FILES, "src/index.ts": "3", "dist/index.js": "4" },
  manifestChanged: false,
  exports: { before: ["a"], after: ["a"] },
  commits: [{ sha: "1".repeat(40), subject: "fix", libraryChange: true, intentsAdded: ["release-intents/fix.json"] }],
  intents: [{ file: "release-intents/fix.json", intent: { ...intent, covers: [] }, addedIn: "1".repeat(40) }],
  editedIntents: [],
  invalidIntents: [],
};
const rebuilt = (over: Partial<Omit<CandidateInput, "ci">> = {}): Omit<CandidateInput, "ci"> => ({
  package: "@comforge/core",
  version: "0.1.3",
  tag: "core/v0.1.3",
  sourceCommit: SOURCE,
  releaseRecordSha256: "r".repeat(64),
  tarball: { sha256: "t".repeat(64), integrity: "sha512-x" },
  fileCount: 46,
  workflowChanges: [],
  workflowApproval: null,
  plan: evaluatePlan(planInput),
  ...over,
});
const green = { ok: true, checks: [{ name: "Validate (test:verify)", conclusion: "success" }] };
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    if (error instanceof CandidateRefusal) return error.code;
    throw error;
  }
  return "approved";
};

describe("the immutable candidate", () => {
  const candidate = buildCandidateRecord({ ...rebuilt(), ci: green });

  test("carries the derived approval, a digest and a readable summary", () => {
    expect(candidate.approval).toBe(`0.1.3@${SOURCE}`);
    expect(candidate.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(candidate.plan.status).toBe("release-ready");
    const text = renderCandidate(candidate);
    for (const part of [SOURCE, candidate.digest, "Fix a thing."]) expect(text).toContain(part);
  });

  test("a matching rebuild yields the approval with nothing typed", () => {
    expect(approvalFromCandidate(candidate, rebuilt())).toBe(`0.1.3@${SOURCE}`);
  });

  test("a tampered record, a different commit or a different artifact is refused", () => {
    expect(code(() => approvalFromCandidate({ ...candidate, version: "0.1.4" }, rebuilt()))).toBe("candidate-invalid");
    expect(code(() => approvalFromCandidate(candidate, rebuilt({ sourceCommit: "b".repeat(40) })))).toBe("candidate-stale");
    expect(code(() => approvalFromCandidate(candidate, rebuilt({ tarball: { sha256: "u".repeat(64), integrity: "sha512-y" } })))).toBe("candidate-mismatch");
    expect(
      code(() =>
        approvalFromCandidate(
          candidate,
          rebuilt({ workflowChanges: [{ file: ".github/workflows/npm-publish.yml", sha256: "f".repeat(64) }], workflowApproval: "x" }),
        ),
      ),
    ).toBe("candidate-mismatch");
  });

  test("a candidate whose plan is not release-ready, or whose CI is unproven, is refused", () => {
    const due = rebuilt({ plan: evaluatePlan({ ...planInput, headVersion: "0.1.2" }), version: "0.1.2", tag: "core/v0.1.2" });
    expect(code(() => approvalFromCandidate(buildCandidateRecord({ ...due, ci: green }), due))).toBe("candidate-not-ready");
    const red = buildCandidateRecord({ ...rebuilt(), ci: { ok: false, checks: [] } });
    expect(code(() => approvalFromCandidate(red, rebuilt()))).toBe("ci-unproven");
    expect(red.risk).toContain("required CI checks are not proven green for the source commit");
  });
});

describe("CI proof", () => {
  const respond = (body: unknown, status = 200) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  const allGreen = REQUIRED_CHECKS.map((name) => ({ name, conclusion: "success" }));

  test("the required checks are exactly the ruleset's required status checks", () => {
    const ruleset = JSON.parse(readFileSync(path.join(REPO, ".github/rulesets/protect-main.json"), "utf8")) as {
      rules: { type: string; parameters?: { required_status_checks?: { context: string }[] } }[];
    };
    const contexts = ruleset.rules
      .filter((r) => r.type === "required_status_checks")
      .flatMap((r) => r.parameters?.required_status_checks ?? [])
      .map((c) => c.context);
    expect([...REQUIRED_CHECKS].sort() as string[]).toEqual([...contexts].sort());
  });

  test("a required check that succeeded for the commit proves it, even after a failed attempt", async () => {
    const proof = await ciProof({
      repository: "o/r",
      sha: SOURCE,
      token: "t",
      fetchImpl: respond({
        check_runs: [{ name: REQUIRED_CHECKS[0], conclusion: "failure" }, ...allGreen],
      }),
    });
    expect(proof.ok).toBe(true);
  });

  test("a missing or failed check, or an API error, proves nothing", async () => {
    for (const fetchImpl of [
      respond({ check_runs: [] }),
      respond({ check_runs: allGreen.slice(1) }),
      respond({ check_runs: [{ ...allGreen[0], conclusion: "failure" }, ...allGreen.slice(1)] }),
      respond({}, 403),
    ])
      expect((await ciProof({ repository: "o/r", sha: SOURCE, token: undefined, fetchImpl })).ok).toBe(false);
  });
});

describe("release.yml", () => {
  const wf = Bun.YAML.parse(readFileSync(path.resolve(import.meta.dir, "../../.github/workflows/release.yml"), "utf8")) as {
    on: { workflow_dispatch: { inputs: Record<string, unknown> } };
    jobs: Record<
      string,
      { needs?: string | string[]; environment?: string; if?: string; steps: { name?: string; run?: string; env?: Record<string, string> }[] }
    >;
  };

  test("nothing is typed, signed or copied: a dispatch names only the package", () => {
    expect(Object.keys(wf.on.workflow_dispatch.inputs)).toEqual(["package"]);
  });

  test("select and candidate hold no secret; the release job reads the owner's approval before its credential", () => {
    expect(JSON.stringify(wf.jobs.select)).not.toMatch(/secrets\./);
    expect(JSON.stringify(wf.jobs.candidate)).not.toMatch(/secrets\./);
    expect(wf.jobs.authorize).toBeUndefined();
    const release = wf.jobs.release!;
    expect(release.needs).toEqual(["select", "candidate"]);
    expect(release.environment).toBe("comforge-release");
    const names = release.steps.map((s) => s.name ?? "");
    const firstSecret = release.steps.findIndex((s) => JSON.stringify(s).includes("secrets."));
    const approval = names.indexOf("Verify the owner's approval of this run");
    expect(approval).toBeGreaterThan(-1);
    expect(approval).toBeLessThan(firstSecret);
    expect(release.steps[approval]?.run).toBe("bun tooling/release/environmentApproval.ts verify");
    // It publishes only this run's candidate; nothing names an authorization any more.
    expect(release.steps.at(-2)?.run).toContain("--publish --candidate ../approved/candidate.json");
    expect(JSON.stringify(wf)).not.toContain("authorization");
  });
});
