/**
 * Cost: none — a temp directory, local git and a local HTTP server; no model
 *
 * One isolated world per run: a fresh temp directory, a fresh HOME and git config, the arm's
 * workspace cloned from the run's own bare remote, and its own synthetic GitHub. The child
 * environment is built from an explicit allowlist; the parent's secrets never reach it.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildFixture, type Fixture, fixtureDigest, git, materialize } from "./fixtures.ts";
import { buildChildEnv, type ChildEnv } from "./redact.ts";
import { type SyntheticGitHub, startSyntheticGitHub } from "./syntheticGitHub.ts";
import { evaluateRun, type RepoSetup, setupRepo, TASK_CONTRACTS, taskPrompts } from "./tasks.ts";
import type { ArmAdapter, ArmInputs, ArmPrepared, RepoId, TaskId } from "./types.ts";

export interface RunWorld {
  root: string;
  home: string;
  runDir: string;
  workspace: string;
  remoteDir: string;
  fixture: Fixture;
  fixtureDigest: string;
  github: SyntheticGitHub;
  setup: RepoSetup;
  prepared: ArmPrepared;
  prNumber: number | null;
  prompts: string[];
  /** Environment for the client and its tools: allowlist + the arm's synthetic variables. */
  childEnv: ChildEnv;
  evaluate(): ReturnType<typeof evaluateRun>;
  stop(): void;
}

export interface WorldOptions {
  repo: RepoId;
  task: TaskId;
  arm: ArmAdapter;
  seed: string;
  inputs?: ArmInputs;
  /** Client credential variable names to copy from the parent environment (live runs only). */
  clientCredentials?: string[];
  parentRoot?: string;
}

export async function createRunWorld(o: WorldOptions): Promise<RunWorld> {
  const root = mkdtempSync(path.join(o.parentRoot ?? tmpdir(), "bench-run-"));
  const home = path.join(root, "home");
  const runDir = path.join(root, "run");
  mkdirSync(runDir, { recursive: true });
  const seedDir = path.join(root, "seed");
  const fixture = buildFixture(o.repo, o.seed);
  const { env: seedEnv } = materialize(fixture, seedDir, home);
  const setupPart = setupRepo(o.task, fixture, seedDir, seedEnv);

  const remoteDir = path.join(root, "remote.git");
  const workspace = path.join(root, "widgets");
  git(root, seedEnv, "init", "--quiet", "--bare", remoteDir);
  git(seedDir, seedEnv, "push", "--quiet", remoteDir, "--all");
  git(root, seedEnv, "clone", "--quiet", remoteDir, workspace);
  rmSync(seedDir, { recursive: true, force: true });

  const contract = TASK_CONTRACTS[o.task];
  const github = await startSyntheticGitHub({
    remoteDir,
    env: seedEnv,
    logPath: path.join(runDir, "github-writes.jsonl"),
    ...(contract.lostAnswer ? { lostAnswerOn: "pr-create" as const } : {}),
  });
  const stopAll = () => {
    github.stop();
    rmSync(root, { recursive: true, force: true });
  };
  try {
    const prepared = o.arm.prepare({
      task: o.task,
      fixture,
      workspace,
      remoteDir,
      runDir,
      github,
      env: seedEnv,
      inputs: o.inputs ?? {},
    });
    let prNumber: number | null = null;
    if (setupPart.prBranch) {
      const sha = git(remoteDir, seedEnv, "rev-parse", `refs/heads/${setupPart.prBranch}`);
      const pull = github.gh.seedPull(setupPart.prBranch, sha, {
        title: setupPart.feature.functionName,
      });
      prNumber = pull.number;
      if (contract.hasReview)
        github.gh.reviews.set(9001, {
          id: 9001,
          pull: pull.number,
          commit_id: sha,
          state: "CHANGES_REQUESTED",
          body: "A negative quantity is data corruption. The function must refuse it with an error instead of returning a plan.",
          user: { login: "reviewer" },
        });
    }
    // Snapshot after the arm's own preparation (comforge arms commit their config to main).
    const mainShaBefore = git(remoteDir, seedEnv, "rev-parse", "refs/heads/main");
    const branchesBefore = Object.fromEntries(
      git(
        remoteDir,
        seedEnv,
        "for-each-ref",
        "--format=%(refname:short) %(objectname)",
        "refs/heads",
      )
        .split("\n")
        .filter(Boolean)
        .map((l) => l.split(" ") as [string, string]),
    );
    const setup: RepoSetup = { ...setupPart, mainShaBefore, branchesBefore };
    const prompts = taskPrompts(o.task, {
      feature: setup.feature,
      trackingIssue: prepared.trackingIssue,
      prNumber,
      prBranch: setup.prBranch,
    });
    const childEnv = buildChildEnv({
      home,
      ...(o.clientCredentials ? { clientCredentials: o.clientCredentials } : {}),
      extra: {
        ...prepared.extraEnv,
        PATH: `${prepared.pathPrepend.join(path.delimiter)}${path.delimiter}${process.env.PATH ?? ""}`,
      },
    });
    return {
      root,
      home,
      runDir,
      workspace,
      remoteDir,
      fixture,
      fixtureDigest: fixtureDigest(fixture),
      github,
      setup,
      prepared,
      prNumber,
      prompts,
      childEnv,
      evaluate: () =>
        evaluateRun({
          task: o.task,
          fixture,
          setup,
          remoteDir,
          env: buildChildEnv({ home, extra: { PATH: process.env.PATH ?? "" } }),
          github,
          prNumber,
          completionPattern: new RegExp(prepared.completionPattern, "im"),
        }),
      stop: stopAll,
    };
  } catch (e) {
    stopAll();
    throw e;
  }
}
