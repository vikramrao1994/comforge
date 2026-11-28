/**
 * The owner's release approval: an approval of this workflow run's `comforge-release`
 * environment by the repository owner, read from GitHub for exactly this run.
 *
 *  bun tooling/release/environmentApproval.ts verify   (in Actions: GITHUB_REPOSITORY, GITHUB_RUN_ID,
 *                                                        GITHUB_REPOSITORY_OWNER, GITHUB_TOKEN)
 *
 * The click is the authorization. It is bound to this run, and a run publishes only the candidate
 * it built: the release job downloads the candidate of its own run, rebuilds, and publishes only a
 * byte-identical rebuild (release.ts). GitHub shows the approver that run and its summary — the
 * candidate digest, version, source commit and any workflow change — before the click.
 *
 * Fails closed: no approval, a rejection, an approval of another environment, by anyone but the
 * owner, or an API answer that cannot be read is a refusal, never a pass. The environment's
 * required reviewer is a repository setting (docs/contributing/release-governance.md); this check
 * also holds if that setting is removed, because it requires the approval record itself.
 */

export const RELEASE_ENVIRONMENT = "comforge-release";

export class ApprovalRefusal extends Error {
  constructor(
    readonly code:
      | "approval-missing"
      | "approval-rejected"
      | "approval-not-owner"
      | "approval-unreadable",
    message: string,
  ) {
    super(message);
  }
}

export interface EnvironmentApprovalInput {
  repository: string;
  runId: string;
  owner: string;
  token: string | undefined;
  environment?: string;
  fetchImpl?: typeof fetch;
  apiOrigin?: string;
}

export interface EnvironmentApproval {
  environment: string;
  approver: string;
  runId: string;
}

interface ApprovalRecord {
  state?: unknown;
  environments?: { name?: unknown }[];
  user?: { login?: unknown } | null;
}

export async function verifyEnvironmentApproval(
  input: EnvironmentApprovalInput,
): Promise<EnvironmentApproval> {
  const environment = input.environment ?? RELEASE_ENVIRONMENT;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.repository) || !/^\d+$/.test(input.runId))
    throw new ApprovalRefusal("approval-unreadable", "repository or run id is malformed");
  const fetchImpl = input.fetchImpl ?? fetch;
  let records: ApprovalRecord[];
  try {
    const res = await fetchImpl(
      `${input.apiOrigin ?? "https://api.github.com"}/repos/${input.repository}/actions/runs/${input.runId}/approvals`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          ...(input.token ? { Authorization: `Bearer ${input.token}` } : {}),
        },
      },
    );
    if (!res.ok)
      throw new ApprovalRefusal("approval-unreadable", `GitHub answered HTTP ${res.status}`);
    const body = (await res.json()) as unknown;
    if (!Array.isArray(body))
      throw new ApprovalRefusal("approval-unreadable", "GitHub's answer is not a list");
    records = body as ApprovalRecord[];
  } catch (error) {
    if (error instanceof ApprovalRefusal) throw error;
    throw new ApprovalRefusal("approval-unreadable", "the approvals of this run could not be read");
  }
  const forEnvironment = records.filter(
    (r) => Array.isArray(r.environments) && r.environments.some((e) => e?.name === environment),
  );
  if (forEnvironment.some((r) => r.state === "rejected"))
    throw new ApprovalRefusal("approval-rejected", `the ${environment} deployment was rejected`);
  const approved = forEnvironment.filter((r) => r.state === "approved");
  if (approved.length === 0)
    throw new ApprovalRefusal(
      "approval-missing",
      `run ${input.runId} has no approval of environment ${environment}`,
    );
  const byOwner = approved.find(
    (r) =>
      typeof r.user?.login === "string" && r.user.login.toLowerCase() === input.owner.toLowerCase(),
  );
  if (!byOwner)
    throw new ApprovalRefusal(
      "approval-not-owner",
      `the ${environment} approval of run ${input.runId} is not the repository owner's`,
    );
  return { environment, approver: byOwner.user?.login as string, runId: input.runId };
}

/** The approval of the current Actions run, from its own environment. */
export function verifyCurrentRun(fetchImpl?: typeof fetch): Promise<EnvironmentApproval> {
  const env = process.env;
  return verifyEnvironmentApproval({
    repository: env.GITHUB_REPOSITORY ?? "",
    runId: env.GITHUB_RUN_ID ?? "",
    owner: env.GITHUB_REPOSITORY_OWNER ?? "",
    token: env.GITHUB_TOKEN,
    ...(fetchImpl ? { fetchImpl } : {}),
  });
}

if (import.meta.main) {
  if (process.argv[2] !== "verify") {
    console.error("usage: bun tooling/release/environmentApproval.ts verify");
    process.exit(2);
  }
  verifyCurrentRun().then(
    (a) => console.log(`approved: ${a.environment} by ${a.approver} for run ${a.runId}`),
    (error: unknown) => {
      console.error(
        `::error::release refused (${error instanceof ApprovalRefusal ? error.code : "internal"}): ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exit(1);
    },
  );
}
