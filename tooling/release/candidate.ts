/**
 * The immutable release candidate (COMFORGE-RELEASE-AUTOMATION-001): everything the owner
 * approves, derived from one source commit, with a digest that binds it.
 *
 * The publisher workflow builds the candidate in a job without credentials. The owner
 * approves exactly that candidate by signing a release authorization over its digest
 * (tooling/release/releaseAuthorization.ts, COMFORGE-RELEASE-APPROVAL-001). The
 * publishing job then rebuilds from the same commit and refuses unless the rebuild matches
 * the candidate exactly, so the approval reaches only what was shown. The approval value
 * `VERSION@SOURCE_SHA` is derived from the candidate, never typed.
 */
import { digestOf, type ReleasePlan } from "./releasePlan";

export const CANDIDATE_SCHEMA = "comforge-release-candidate/v1";
export const REQUIRED_CHECKS = ["Validate (test:verify)"] as const;

export type CiProof = {
  ok: boolean;
  checks: { name: string; conclusion: string | null }[];
};

export type CandidateInput = {
  package: string;
  version: string;
  tag: string;
  sourceCommit: string;
  releaseRecordSha256: string;
  tarball: { sha256: string; integrity: string };
  fileCount: number;
  workflowChanges: { file: string; sha256: string | null }[];
  workflowApproval: string | null;
  plan: ReleasePlan;
  ci: CiProof | null;
};

export type ReleaseCandidate = Omit<CandidateInput, "plan"> & {
  schema: typeof CANDIDATE_SCHEMA;
  plan: Pick<ReleasePlan, "digest" | "status" | "bump" | "nextVersion" | "intents" | "api"> & {
    baseline: ReleasePlan["baseline"];
  };
  changelogSection: string | null;
  risk: string[];
  approval: string;
  digest: string;
};

export class CandidateRefusal extends Error {
  constructor(
    readonly code:
      | "candidate-invalid"
      | "candidate-stale"
      | "candidate-mismatch"
      | "candidate-not-ready"
      | "ci-unproven",
    message: string,
  ) {
    super(`release:build refused (${code}): ${message}`);
  }
}

/** A human-readable list of what deserves a second look before approving. */
export function riskSummary(input: CandidateInput): string[] {
  const { plan } = input;
  const risk: string[] = [];
  for (const i of plan.intents.filter((x) => x.breaking))
    risk.push(`BREAKING (${i.file}): ${i.breaking}`);
  if (plan.api.removed.length) risk.push(`exports removed: ${plan.api.removed.join(", ")}`);
  if (plan.api.added.length) risk.push(`exports added: ${plan.api.added.join(", ")}`);
  if (input.workflowChanges.length)
    risk.push(
      `changes the npm publishing workflow (${input.workflowChanges.map((c) => c.file).join(", ")}): needs its own approval`,
    );
  if (plan.changes.library.length === 0)
    risk.push("library unchanged: a distribution-only release");
  if (!input.ci?.ok) risk.push("required CI checks are not proven green for the source commit");
  return risk;
}

export function buildCandidateRecord(input: CandidateInput): ReleaseCandidate {
  const { plan, ...rest } = input;
  const body: Omit<ReleaseCandidate, "digest"> = {
    schema: CANDIDATE_SCHEMA,
    ...rest,
    plan: {
      digest: plan.digest,
      status: plan.status,
      bump: plan.bump,
      nextVersion: plan.nextVersion,
      baseline: plan.baseline,
      intents: plan.intents,
      api: plan.api,
    },
    changelogSection: plan.changelogSection,
    risk: riskSummary(input),
    approval: `${input.version}@${input.sourceCommit}`,
  };
  return { ...body, digest: digestOf(body) };
}

/** Refuses a record whose content no longer matches its own digest. */
export function assertCandidateIntegrity(candidate: ReleaseCandidate): void {
  const { digest, ...body } = candidate;
  if (candidate.schema !== CANDIDATE_SCHEMA || digest !== digestOf(body))
    throw new CandidateRefusal(
      "candidate-invalid",
      "the candidate record does not match its digest",
    );
}

/** Refuses a candidate the planner did not call release-ready, or whose CI is not green. */
export function assertCandidateReady(candidate: ReleaseCandidate): void {
  if (candidate.plan.status !== "release-ready" || candidate.plan.nextVersion !== candidate.version)
    throw new CandidateRefusal(
      "candidate-not-ready",
      `the release plan is ${candidate.plan.status} (next ${candidate.plan.nextVersion}), not release-ready for ${candidate.version}`,
    );
  if (!candidate.ci?.ok)
    throw new CandidateRefusal(
      "ci-unproven",
      `required checks (${REQUIRED_CHECKS.join(", ")}) are not green for ${candidate.sourceCommit}`,
    );
}

/** Checks the record is intact and publishable, and returns the approval it carries. */
export function approvalFromCandidate(
  candidate: ReleaseCandidate,
  rebuilt: Omit<CandidateInput, "ci">,
): string {
  assertCandidateIntegrity(candidate);
  if (candidate.sourceCommit !== rebuilt.sourceCommit)
    throw new CandidateRefusal(
      "candidate-stale",
      `the candidate was built from ${candidate.sourceCommit}, this run is ${rebuilt.sourceCommit}`,
    );
  const expected = buildCandidateRecord({ ...rebuilt, ci: candidate.ci });
  const fields = [
    "package",
    "version",
    "tag",
    "releaseRecordSha256",
    "tarball",
    "fileCount",
    "workflowChanges",
    "workflowApproval",
    "plan",
    "changelogSection",
    "approval",
  ] as const;
  const differs = fields.filter(
    (f) => JSON.stringify(expected[f]) !== JSON.stringify(candidate[f]),
  );
  if (differs.length > 0)
    throw new CandidateRefusal(
      "candidate-mismatch",
      `the rebuild differs from the approved candidate in ${differs.join(", ")}`,
    );
  assertCandidateReady(candidate);
  return candidate.approval;
}

/** GitHub's REST base: the runner sets it in Actions; a rehearsal may point it at a stub. */
export function githubApiBase(): string {
  return (process.env.GITHUB_API_URL ?? "https://api.github.com").replace(/\/+$/, "");
}

/** Reads the check runs GitHub recorded for `sha`; every required check must have succeeded. */
export async function ciProof(options: {
  repository: string;
  sha: string;
  token: string | undefined;
  fetchImpl?: typeof fetch;
}): Promise<CiProof> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const res = await fetchImpl(
    `${githubApiBase()}/repos/${options.repository}/commits/${options.sha}/check-runs?per_page=100`,
    {
      headers: {
        accept: "application/vnd.github+json",
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      },
    },
  );
  if (!res.ok) return { ok: false, checks: [] };
  const runs =
    ((await res.json()) as { check_runs?: { name: string; conclusion: string | null }[] })
      .check_runs ?? [];
  const checks = REQUIRED_CHECKS.map((name) => {
    const matching = runs.filter((r) => r.name === name);
    // Any success for the commit proves the check passed on exactly this tree.
    const success = matching.find((r) => r.conclusion === "success");
    return { name, conclusion: success ? "success" : (matching[0]?.conclusion ?? null) };
  });
  return { ok: checks.every((c) => c.conclusion === "success"), checks };
}

export function renderCandidate(c: ReleaseCandidate): string {
  return [
    `### ${c.package} ${c.version} — release candidate`,
    "",
    `- Source commit: \`${c.sourceCommit}\``,
    `- Candidate digest: \`${c.digest}\``,
    `- Release record SHA-256: \`${c.releaseRecordSha256}\``,
    `- Tarball: \`${c.tarball.integrity}\``,
    `- Plan: ${c.plan.status}, ${c.plan.bump} from ${c.plan.baseline.version} (\`${c.plan.digest}\`)`,
    `- CI: ${c.ci ? c.ci.checks.map((x) => `${x.name} ${x.conclusion ?? "missing"}`).join(", ") : "not checked"}`,
    ...(c.workflowApproval
      ? [`- Workflow change (needs \`approve_workflows\`): \`${c.workflowApproval}\``]
      : []),
    "",
    "Risk:",
    ...(c.risk.length ? c.risk.map((r) => `- ${r}`) : ["- none recorded"]),
    "",
    ...(c.changelogSection ? ["Changelog:", "", c.changelogSection] : []),
  ].join("\n");
}
