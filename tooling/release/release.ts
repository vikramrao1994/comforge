/**
 * `bun run release:build --dest <mirror-checkout> [--out DIR] [--ci-proof] [--publish (--candidate FILE --authorization FILE | --approve VERSION@SOURCE_SHA) [--approve-workflows PATH@SHA256,...]]`
 *
 * Builds the `@comforge/core` release candidate from the committed HEAD of this repository
 * (twice, and refuses unless both builds are byte-identical), scans it for disclosure,
 * checks that the compiled package imports under Node, and plans the sync into the
 * RELEASE_BRANCH of a Comforge checkout. Without --publish it is a dry run: the release is
 * rehearsed in a throwaway copy of the checkout and nothing is pushed. With --publish and the
 * matching --approve it switches the checkout to RELEASE_BRANCH, commits, tags and pushes that
 * branch and tag (never main) to the checkout's origin, which must be MIRROR_REPOSITORY. A
 * release that adds, changes or removes a `.github/workflows/` file also needs
 * --approve-workflows naming each such file and digest, exactly as the dry run printed it.
 * Writes plan.json, the patch and the tarball to --out, and candidate.json: the immutable
 * candidate (tooling/release/candidate.ts) with the release planner's verdict, the CI
 * proof (--ci-proof) and a digest. `--publish --candidate FILE` derives the approval from that
 * record after checking this rebuild matches it, so the owner never copies a SHA; the release
 * planner must be release-ready for exactly this version, and --authorization must be the
 * owner's signed approval of exactly that candidate (releaseAuthorization.ts), checked against
 * the trust file and workflow at the source commit immediately before the push.
 *
 * Setup, the owner's gates and recovery: docs/contributing/release-governance.md.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  approvalFromCandidate,
  buildCandidateRecord,
  type CandidateInput,
  CandidateRefusal,
  type CiProof,
  ciProof,
  type ReleaseCandidate,
  renderCandidate,
} from "./candidate";
import {
  assertReproducible,
  brokenRelativeLinks,
  buildCandidate,
  checkoutReleaseBranch,
  dryRunRelease,
  git,
  MIRROR_REPOSITORY,
  normalizeRemote,
  publicationBlockers,
  pushRelease,
  ReleaseRefusal,
  releaseMirror,
  scanForDisclosure,
  verifyCompiledExports,
  workflowApproval,
  workflowChanges,
} from "./mirror";
import { profileOf, sourceInputs } from "./packages";
import {
  AuthorizationRefusal,
  expectedRepository,
  trustAt,
  verifyReleaseAuthorization,
  workflowDigestAt,
} from "./releaseAuthorization";
import { collectPlanInput, evaluatePlan, PlanRefusal, type ReleasePlan } from "./releasePlan";

const REPO = path.resolve(import.meta.dir, "..", "..");

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<number> {
  const dest = arg("--dest");
  if (!dest) {
    console.error(
      "usage: bun run release:build --dest <mirror-checkout> [--out DIR] [--publish (--candidate FILE --authorization FILE | --approve VERSION@SOURCE_SHA)]",
    );
    return 2;
  }
  const destDir = path.resolve(dest);
  const outDir = path.resolve(arg("--out") ?? path.join(REPO, "generated", "factory-core-release"));
  const publish = process.argv.includes("--publish");

  // The registry package to release (`--package`, default @comforge/core): its source, branch,
  // tag and npm workflow all come from tooling/release/packages.ts, never from the caller.
  const profile = profileOf(arg("--package") ?? "@comforge/core");
  const SOURCE_INPUTS = sourceInputs(profile);
  const RELEASE_BRANCH = profile.releaseBranch;
  const sourceCommit = git(REPO, ["rev-parse", "HEAD"]);
  if (
    git(REPO, [
      "status",
      "--porcelain",
      "--untracked-files=all",
      "--",
      ...SOURCE_INPUTS,
      "tooling/release",
    ]) !== ""
  )
    throw new ReleaseRefusal(
      "source-dirty",
      `uncommitted changes under ${SOURCE_INPUTS.join(", ")} or tooling/release`,
    );
  if (
    publish &&
    spawnSync("git", ["merge-base", "--is-ancestor", sourceCommit, "refs/remotes/origin/main"], {
      cwd: REPO,
    }).status !== 0
  )
    throw new ReleaseRefusal(
      "source-unverified",
      `${sourceCommit} is not on origin/main; publish only reviewed, merged source`,
    );

  const staging = path.join(REPO, "generated", "factory-core-release-staging");
  const a = buildCandidate({
    profile,
    repo: REPO,
    sourceCommit,
    outDir: path.join(outDir, "a"),
    stagingRoot: staging,
  });
  const b = buildCandidate({
    profile,
    repo: REPO,
    sourceCommit,
    outDir: path.join(outDir, "b"),
    stagingRoot: staging,
  });
  assertReproducible(a, b);

  const findings = scanForDisclosure(a.dir);
  if (findings.length > 0)
    throw new ReleaseRefusal(
      "privacy-finding",
      findings.map((f) => `${f.file}:${f.line} ${f.rule}`).join("; "),
    );
  const links = brokenRelativeLinks(a.dir);
  if (links.length > 0) throw new ReleaseRefusal("broken-link", links.join("; "));
  try {
    verifyCompiledExports(a.dir, staging, a.siblingModules);
  } finally {
    for (const c of [a, b])
      if (c.siblingModules) rmSync(c.siblingModules, { recursive: true, force: true });
  }

  // The release planner's verdict for this exact commit. A dry run reports a refusal; a
  // candidate-gated publish cannot proceed without a release-ready plan.
  let releasePlan: ReleasePlan | null = null;
  let planRefusal: string | null = null;
  try {
    releasePlan = evaluatePlan(collectPlanInput(REPO, sourceCommit, profile.name));
  } catch (error) {
    if (!(error instanceof PlanRefusal)) throw error;
    planRefusal = error.message;
  }
  console.log(
    releasePlan
      ? `release plan: ${releasePlan.status} — ${releasePlan.reason}`
      : `release plan: ${planRefusal}`,
  );
  const origin = git(destDir, ["remote", "get-url", "origin"], true);
  const remoteMain = origin
    ? (git(destDir, ["ls-remote", "origin", "refs/heads/main"], true).split(/\s+/)[0] ?? "")
    : null;
  const blockers = publicationBlockers(a.dir, remoteMain);

  // A dry run with nothing due stops at the planner's verdict. Syncing would rebuild the
  // last released version from a newer commit, which the mirror rightly refuses as
  // `version-reused`; that refusal is for a publish, not for "nothing to release".
  if (!publish && releasePlan && releasePlan.status !== "release-ready") {
    mkdirSync(outDir, { recursive: true });
    const report = {
      mode: "dry-run",
      release: {
        version: a.release.version,
        tag: a.release.tag,
        sourceCommit,
        reproducible: true,
        disclosureFindings: 0,
      },
      releasePlan: {
        status: releasePlan.status,
        reason: releasePlan.reason,
        bump: releasePlan.bump,
        nextVersion: releasePlan.nextVersion,
        digest: releasePlan.digest,
      },
      blockers,
      operations: [],
      candidate: null,
      pushed: null,
    };
    writeFileSync(path.join(outDir, "plan.json"), `${JSON.stringify(report, null, 2)}\n`);
    if (process.env.GITHUB_OUTPUT)
      appendFileSync(process.env.GITHUB_OUTPUT, `changed=false\nversion=${a.release.version}\n`);
    if (process.env.GITHUB_STEP_SUMMARY)
      appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        `### ${a.release.package}: ${releasePlan.status}\n\n${releasePlan.reason}. No candidate was built; nothing to approve.\n`,
      );
    console.log(`release:build dry-run — ${releasePlan.status}: no candidate, nothing to approve`);
    return 0;
  }

  const { outcome, patch } = dryRunRelease(a.dir, destDir, path.join(outDir));
  const plan = outcome.plan;
  writeFileSync(path.join(outDir, "release.patch"), patch);
  const workflows = workflowChanges(plan, a.dir);

  const ci: CiProof | null = process.argv.includes("--ci-proof")
    ? await ciProof({
        repository: process.env.GITHUB_REPOSITORY ?? "",
        sha: sourceCommit,
        token: process.env.GITHUB_TOKEN,
      })
    : null;
  const candidateInput: Omit<CandidateInput, "ci" | "plan"> = {
    package: a.release.package,
    version: a.release.version,
    tag: a.release.tag,
    sourceCommit,
    releaseRecordSha256: createHash("sha256")
      .update(readFileSync(path.join(a.dir, "RELEASE.json")))
      .digest("hex"),
    tarball: { sha256: a.release.tarball.sha256, integrity: a.release.tarball.integrity },
    fileCount: Object.keys(a.release.files).length,
    workflowChanges: workflows,
    workflowApproval: workflows.length > 0 ? workflowApproval(workflows) : null,
  };
  const candidate = releasePlan
    ? buildCandidateRecord({ ...candidateInput, plan: releasePlan, ci })
    : null;
  mkdirSync(outDir, { recursive: true });
  if (candidate)
    writeFileSync(path.join(outDir, "candidate.json"), `${JSON.stringify(candidate, null, 2)}\n`);

  let pushed: ReturnType<typeof pushRelease> | null = null;
  if (publish) {
    if (blockers.length > 0) throw new ReleaseRefusal("publication-blocked", blockers.join("; "));
    const candidateFile = arg("--candidate");
    // In Actions the only approval is the owner's signed one; a typed VERSION@SHA is for the
    // owner's own machine, where the mirror credential is theirs.
    if (process.env.GITHUB_ACTIONS === "true" && !candidateFile)
      throw new AuthorizationRefusal(
        "authorization-missing",
        "a workflow publishes only a --candidate with the owner's signed --authorization",
      );
    let approval = arg("--approve");
    if (candidateFile) {
      if (!releasePlan)
        throw new ReleaseRefusal("publication-blocked", planRefusal ?? "no release plan");
      const approved = JSON.parse(readFileSync(candidateFile, "utf8")) as ReleaseCandidate;
      approval = approvalFromCandidate(approved, { ...candidateInput, plan: releasePlan });
      const authorizationFile = arg("--authorization");
      if (!authorizationFile)
        throw new AuthorizationRefusal(
          "authorization-missing",
          "--candidate publishes only with the owner's signed --authorization",
        );
      const authorization = verifyReleaseAuthorization(
        JSON.parse(readFileSync(authorizationFile, "utf8")),
        {
          trust: trustAt(REPO, sourceCommit),
          repository: expectedRepository(),
          candidate: approved,
          workflowSha256: workflowDigestAt(REPO, sourceCommit),
          triggeringActor: process.env.GITHUB_TRIGGERING_ACTOR,
          approveWorkflows: arg("--approve-workflows") ?? "",
          now: new Date(),
        },
      );
      console.log(
        `authorization ${authorization.authorizationId} by ${authorization.issuer} matches the rebuild`,
      );
    }
    checkoutReleaseBranch(destDir, profile);
    const real = releaseMirror(a.dir, destDir);
    pushed = pushRelease({
      destDir,
      outcome: real,
      release: a.release,
      trustedOrigin: `https://github.com/${MIRROR_REPOSITORY}.git`,
      approval,
      workflowApproval: arg("--approve-workflows"),
    });
  }

  const report = {
    mode: publish ? "publish" : "dry-run",
    destination: {
      checkout: path.basename(destDir),
      // Only a GitHub remote is named; a local path could carry a home directory.
      origin: ((url) =>
        url.startsWith("github.com/") ? url : url ? "(local or non-GitHub remote)" : "(none)")(
        normalizeRemote(git(destDir, ["remote", "get-url", "origin"], true)),
      ),
      base: plan.base,
    },
    release: {
      version: a.release.version,
      tag: a.release.tag,
      sourceCommit,
      tarball: a.release.tarball,
      reproducible: true,
      disclosureFindings: 0,
    },
    plan: {
      previousVersion: plan.previousVersion,
      write: plan.write,
      remove: plan.remove,
      unchanged: plan.unchanged.length,
    },
    // Changes to the npm Trusted Publisher's workflow: a separate owner approval, and a
    // credential with Workflows: write (docs/contributing/release-governance.md).
    workflowChanges: workflows,
    workflowApproval: workflows.length > 0 ? workflowApproval(workflows) : null,
    operations:
      outcome.changed || outcome.tagCreated
        ? [
            ...(outcome.changed
              ? [`commit ${plan.write.length} written, ${plan.remove.length} removed owned file(s)`]
              : []),
            ...(outcome.tagCreated ? [`tag ${outcome.tag}`] : []),
            `push --atomic origin ${RELEASE_BRANCH} ${outcome.tag} (fast-forward only; main is never written)`,
          ]
        : [],
    blockers,
    releasePlan: releasePlan
      ? {
          status: releasePlan.status,
          bump: releasePlan.bump,
          nextVersion: releasePlan.nextVersion,
          digest: releasePlan.digest,
        }
      : { refused: planRefusal },
    candidate: candidate ? { digest: candidate.digest, approval: candidate.approval } : null,
    pushed,
    rollback: [
      `Released tags are immutable: never delete or move ${outcome.tag}.`,
      "Consumers roll back by pinning the previous release commit in package.json and reinstalling.",
      `A bad release is superseded by a new patch version; ${RELEASE_BRANCH} is never force-pushed and main is never written.`,
    ],
  };
  writeFileSync(path.join(outDir, "plan.json"), `${JSON.stringify(report, null, 2)}\n`);
  const changed = report.operations.length > 0;
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(process.env.GITHUB_OUTPUT, `changed=${changed}\nversion=${a.release.version}\n`);
  for (const file of plan.write) console.log(`write   ${file}`);
  for (const file of plan.remove) console.log(`remove  ${file}`);
  console.log(
    `release:build ${report.mode} — ${a.release.tag} from ${sourceCommit.slice(0, 12)}, tarball sha256 ${a.release.tarball.sha256}`,
  );
  console.log(
    changed ? report.operations.join("\n") : "no-op: the mirror already holds this release",
  );
  if (workflows.length > 0)
    console.log(
      `WORKFLOW CHANGE — publishing also needs --approve-workflows ${workflowApproval(workflows)}`,
    );
  for (const blocker of blockers) console.log(`BLOCKER ${blocker}`);
  if (candidate) {
    console.log(
      `candidate ${candidate.digest} — plan ${candidate.plan.status}, approval ${candidate.approval}`,
    );
    if (process.env.GITHUB_STEP_SUMMARY)
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${renderCandidate(candidate)}\n`);
  } else console.log(`RELEASE PLAN ${planRefusal}`);
  console.log(`plan: ${path.join(outDir, "plan.json")}`);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error((error as Error).message);
    const refused =
      error instanceof ReleaseRefusal ||
      error instanceof PlanRefusal ||
      error instanceof CandidateRefusal ||
      error instanceof AuthorizationRefusal;
    process.exit(refused ? 1 : 2);
  });
