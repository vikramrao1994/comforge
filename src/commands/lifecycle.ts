import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readSpecificationIssue } from "@comforge/github";
import { authorizeWrites } from "../authorization.ts";
import type { ComforgeConfig } from "../config.ts";
import { type CommandContext, loadInitiative, requireCheckout } from "../context.ts";
import { EXIT, fail } from "../errors.ts";
import { githubError } from "../github.ts";
import { specificationProtocol } from "../protocols.ts";
import { provision } from "../provision.ts";
import {
  checkoutDir,
  checkoutParent,
  fetchBase,
  initiativeFromBranch,
  parseInitiative,
  trustedBase,
} from "../repository.ts";
import { childEnv, git, gitOk, gitRun } from "../runtime.ts";
import { type InitiativeRecord, nowIso, type ProvisionStep, type Validation } from "../state.ts";
import { legacyUnmigrated } from "./migrate.ts";

/** A command's result; `exit` overrides the default 0 for a result that is not an error (e.g. verify FAIL). */
export interface CommandResult {
  result: Record<string, unknown>;
  exit?: number;
}

// --- start ------------------------------------------------------------------------------

export async function start(
  ctx: CommandContext,
  options: {
    id: string;
    issue?: number;
    expectDigest?: string;
    provision?: boolean;
    /** Starts a cleaned initiative again as its next attempt, keeping every earlier one. */
    reopen?: boolean;
  },
): Promise<CommandResult> {
  const { rt, repo } = ctx;
  const { base: baseSha, config: trusted, digest } = trustedBase(rt, repo.root, ctx.working());
  const initiative = parseInitiative(options.id, trusted);
  if (await legacyUnmigrated(ctx, trusted, initiative.id))
    fail(
      "conflict",
      `${initiative.id} belongs to the earlier lifecycle; run comforge migrate first`,
      {
        initiative: initiative.id,
      },
    );
  const existing = await ctx.state.get(initiative.id);
  if (existing && !(options.reopen && existing.cleanedAt))
    fail(
      "conflict",
      existing.cleanedAt
        ? `${initiative.id} was cleaned up; start it again with --reopen (a new attempt)`
        : `${initiative.id} is already started; use comforge status or comforge revise`,
      {
        initiative: initiative.id,
        ...(existing.cleanedAt ? { cleanedAt: existing.cleanedAt } : {}),
      },
    );
  if (options.reopen && !existing)
    fail("not-found", `${initiative.id} has never been started; start it without --reopen`);
  if (existing?.migratedFrom?.retiredAt)
    fail("conflict", `${initiative.id} was retired by migrate --rollback; it cannot be reopened`);

  // A phase must start from the same specification its ticket started from.
  const parent = initiative.phase ? await ctx.state.get(initiative.ticket) : null;
  if (initiative.phase && trusted.lifecycle.phaseRequiresCleanParent) {
    if (!parent?.cleanedAt)
      fail(
        "conflict",
        `a phase of ${initiative.ticket} starts after ${initiative.ticket} is cleaned up`,
        {
          parent: initiative.ticket,
          parentStage: parent ? stageOf(parent) : "missing",
        },
      );
    const active = (await ctx.state.list()).filter(
      (r) => r.ticket === initiative.ticket && r.phase !== null && !r.cleanedAt,
    );
    if (active.length > 0)
      fail("conflict", `another phase of ${initiative.ticket} is still active`, {
        active: active.map((r) => r.operationId),
      });
  }
  const specification = await verifiedSpecification(
    ctx,
    trusted,
    initiative.ticket,
    options,
    parent,
  );
  ctx.checkpoint();
  const { remote, baseBranch } = trusted.repository;
  if (trusted.lifecycle.remotePreflight) await remotePreflight(ctx, trusted, initiative.branch);

  const parentDir = ctx.host.checkoutParent ?? checkoutParent(trusted, repo.root);
  const checkout = ctx.host.checkoutParent
    ? path.join(parentDir, initiative.id.toLowerCase())
    : checkoutDir(trusted, repo.root, initiative);
  if (existsSync(checkout)) fail("would-overwrite", `${checkout} already exists`, { checkout });
  mkdirSync(parentDir, { recursive: true });
  const provisioning = createCheckout(ctx, trusted, checkout, {
    branch: initiative.branch,
    at: baseSha,
    fetch: [baseBranch],
    provision: options.provision !== false,
  });
  const fields = {
    ticket: initiative.ticket,
    phase: initiative.phase,
    branch: initiative.branch,
    checkout,
    primary: repo.root,
    base: { remote, branch: baseBranch, sha: baseSha },
    trustedConfig: digest,
    specification,
    validations: [],
    revisions: [],
    publications: [],
    completions: [],
    operations: [],
    cleanedAt: null,
    provisioning,
    ...(ctx.host.checkoutParent ? { hostCheckoutParent: ctx.host.checkoutParent } : {}),
  };
  let record: InitiativeRecord;
  try {
    record = existing
      ? await reopenAttempt(ctx, initiative.id, existing.version, fields)
      : await ctx.state.create(fields, initiative.id);
  } catch (error) {
    // Only what this invocation created is removed.
    ctx.host.remove(checkout);
    throw error;
  }
  return {
    result: {
      initiative: record.operationId,
      branch: record.branch,
      checkout,
      base: record.base,
      specification,
      provisioned: provisioning.map((p) => p.command),
      provisioning,
      primaryCheckout: primaryReport(ctx),
      ...(record.attempt ? { attempt: record.attempt } : {}),
    },
  };
}

/**
 * Turns a cleaned initiative into its next attempt, by compare-and-swap on the version start
 * read: a concurrent reopen (or any other change) makes this one fail instead of both
 * succeeding. The finished attempt is archived verbatim; grant uses stay on the record, so a
 * grant's attempts are never refunded by reopening.
 */
async function reopenAttempt(
  ctx: CommandContext,
  id: string,
  expectedVersion: number,
  fields: Omit<InitiativeRecord, "version" | "schema" | "operationId">,
): Promise<InitiativeRecord> {
  return ctx.state.update(id, (r) => {
    if (r.version !== expectedVersion || !r.cleanedAt)
      fail("conflict", `${id} changed while it was being reopened; rerun`, { initiative: id });
    const { attempts = [], grantUses, version: _v, schema: _s, ...finished } = r;
    const attempt = (r.attempt ?? 1) + 1;
    const archived = {
      attempt: r.attempt ?? 1,
      archivedAt: nowIso(ctx.rt.now()),
      record: finished,
    };
    for (const key of Object.keys(r) as (keyof InitiativeRecord)[])
      if (key !== "version" && key !== "schema" && key !== "operationId") delete r[key];
    Object.assign(r, fields, {
      attempt,
      attempts: [...attempts, archived],
      ...(grantUses ? { grantUses } : {}),
    });
  });
}

/**
 * A new isolated checkout: a clone of the primary (no shared objects), pointed at the real
 * remote, on `branch` at `at`, provisioned. Anything this call created is removed on failure.
 */
function createCheckout(
  ctx: CommandContext,
  trusted: ComforgeConfig,
  checkout: string,
  options: { branch: string; at: string; fetch: string[]; provision: boolean },
): ProvisionStep[] {
  const { rt, repo } = ctx;
  const { remote } = trusted.repository;
  const remoteUrl = git(rt, repo.root, ["config", "--get", `remote.${remote}.url`]);
  git(rt, repo.root, [
    "clone",
    "--quiet",
    "--no-hardlinks",
    "--no-checkout",
    "--origin",
    remote,
    repo.root,
    checkout,
  ]);
  try {
    git(rt, checkout, ["remote", "set-url", remote, remoteUrl]);
    for (const branch of options.fetch)
      git(rt, checkout, [
        "fetch",
        "--quiet",
        remote,
        `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`,
      ]);
    git(rt, checkout, ["checkout", "--quiet", "-b", options.branch, options.at]);
    ctx.host.prepareCheckout(checkout);
    return options.provision
      ? provision(rt, trusted, checkout, repo.root, credentialVariables(trusted))
      : [];
  } catch (error) {
    // Only what this invocation created is removed.
    ctx.host.remove(checkout);
    throw error;
  }
}

/** The primary checkout is only read (and fetched into); this reports that it was left alone. */
function primaryReport(ctx: CommandContext) {
  const lines = git(ctx.rt, ctx.repo.root, ["status", "--porcelain", "--untracked-files=normal"])
    .split("\n")
    .filter(Boolean);
  return {
    untouched: true,
    trackedChanges: lines.filter((l) => !l.startsWith("??")).length,
    untrackedFiles: lines.filter((l) => l.startsWith("??")).length,
  };
}

/** start refuses when the remote already has the branch, or GitHub a pull request for it. */
async function remotePreflight(ctx: CommandContext, trusted: ComforgeConfig, branch: string) {
  const { owner, name, remote } = trusted.repository;
  const remoteLine = git(ctx.rt, ctx.repo.root, ["ls-remote", remote, `refs/heads/${branch}`]);
  if (remoteLine)
    fail(
      "conflict",
      `${remote} already has ${branch}; revise its pull request or remove the branch`,
      {
        branch,
        sha: remoteLine.split(/\s/)[0] as string,
      },
    );
  const pulls = (await ctx
    .github(trusted)
    .transport.get(`/repos/${owner}/${name}/pulls`, {
      head: `${owner}:${branch}`,
      state: "all",
      per_page: "10",
    })
    .catch(githubError)) as unknown;
  if (Array.isArray(pulls) && pulls.length > 0)
    fail("conflict", `a pull request already exists for ${branch}`, {
      branch,
      pullRequests: pulls.map((p) => (p as { number?: unknown }).number as number),
    });
}

export const credentialVariables = (config: ComforgeConfig): string[] =>
  config.security.credentials.source === "env" ? [config.security.credentials.variable] : [];

async function verifiedSpecification(
  ctx: CommandContext,
  trusted: ComforgeConfig,
  ticket: string,
  options: { issue?: number; expectDigest?: string },
  parent: InitiativeRecord | null,
): Promise<{ issueNumber: number; digest: string } | null> {
  const protocol = specificationProtocol(trusted);
  if (options.issue === undefined) {
    if (protocol && trusted.specification?.required)
      fail(
        "specification-invalid",
        "this repository requires --issue N naming the published specification",
      );
    if (parent?.specification)
      fail(
        "specification-invalid",
        `the phase must name #${parent.specification.issueNumber}, as ${ticket} did`,
      );
    return null;
  }
  if (!protocol)
    fail("config-invalid", "--issue needs a specification section in the configuration");
  const read = await readSpecificationIssue(
    ctx.github(trusted).evidence,
    protocol as NonNullable<typeof protocol>,
    options.issue,
  ).catch(githubError);
  if (read.issue.isPullRequest)
    fail("specification-invalid", `#${options.issue} is a pull request`);
  if (read.issue.state !== "open") fail("stale", `#${options.issue} is ${read.issue.state}`);
  const v = read.verification;
  if (!v) fail("specification-invalid", `#${options.issue} is not a published specification`);
  const verification = v as NonNullable<typeof v>;
  if (verification.ticketId !== ticket)
    fail("conflict", `#${options.issue} specifies ${verification.ticketId}, not ${ticket}`);
  if (!verification.digestMatches)
    fail("stale", `#${options.issue} was edited after publication; its digest no longer matches`);
  if (options.expectDigest && options.expectDigest !== verification.digest)
    fail("conflict", "the specification digest is not the expected one", {
      expected: options.expectDigest,
      actual: verification.digest,
    });
  if (
    parent?.specification &&
    (parent.specification.issueNumber !== options.issue ||
      parent.specification.digest !== verification.digest)
  )
    fail("conflict", `${ticket} started from another specification; a phase keeps it`);
  return { issueNumber: options.issue, digest: verification.digest };
}

// --- revise -----------------------------------------------------------------------------

export async function revise(
  ctx: CommandContext,
  options: { pr: number; reviewedHead?: string; provision?: boolean },
): Promise<CommandResult> {
  const { rt } = ctx;
  const working = ctx.working();
  const pull = await ctx.github(working).evidence.getPullRequest(options.pr).catch(githubError);
  const initiative = initiativeFromBranch(pull.head.ref, working);
  if (!initiative)
    fail("not-found", `#${options.pr} (${pull.head.ref}) is not an initiative branch`);
  const id = (initiative as { id: string }).id;
  if (await legacyUnmigrated(ctx, working, id))
    fail("conflict", `${id} belongs to the earlier lifecycle; run comforge migrate first`, {
      initiative: id,
    });
  const { record, trusted } = await loadInitiative(ctx, id);
  if (pull.head.repository !== `${trusted.repository.owner}/${trusted.repository.name}`)
    fail("policy-denied", "the pull request head is not in this repository");
  if (pull.state !== "open")
    fail("stale", `#${options.pr} is ${pull.merged ? "merged" : "closed"}`);
  if (options.reviewedHead && options.reviewedHead !== pull.head.sha)
    fail("stale", "the review is of an older head than the pull request's", {
      reviewed: options.reviewedHead,
      current: pull.head.sha,
    });
  const { remote, baseBranch } = trusted.repository;
  ctx.checkpoint();

  // A missing checkout is re-created at the pull request head (the record keeps its path).
  let checkoutCreated = false;
  let provisioning: ProvisionStep[] | null = null;
  if (!existsSync(record.checkout)) {
    git(rt, ctx.repo.root, [
      "fetch",
      "--quiet",
      remote,
      `+refs/heads/${record.branch}:refs/remotes/${remote}/${record.branch}`,
    ]);
    const fetched = git(rt, ctx.repo.root, [
      "rev-parse",
      `refs/remotes/${remote}/${record.branch}`,
    ]);
    if (fetched !== pull.head.sha)
      fail("stale", "the remote branch is not at the pull request head; rerun", {
        remote: fetched,
        pullRequest: pull.head.sha,
      });
    mkdirSync(path.dirname(record.checkout), { recursive: true });
    provisioning = createCheckout(ctx, trusted, record.checkout, {
      branch: record.branch,
      at: pull.head.sha,
      fetch: [baseBranch, record.branch],
      provision: options.provision !== false,
    });
    git(rt, record.checkout, [
      "branch",
      "--quiet",
      "--set-upstream-to",
      `${remote}/${record.branch}`,
    ]);
    checkoutCreated = true;
  }
  const checkout = record.checkout;
  git(rt, checkout, [
    "fetch",
    "--quiet",
    remote,
    `+refs/heads/${record.branch}:refs/remotes/${remote}/${record.branch}`,
    `+refs/heads/${baseBranch}:refs/remotes/${remote}/${baseBranch}`,
  ]);
  if (!gitOk(rt, checkout, ["cat-file", "-e", `${pull.head.sha}^{commit}`]))
    fail("stale", "the pull request head is not on the remote branch; rerun", {
      pullRequest: pull.head.sha,
    });
  const head = git(rt, checkout, ["rev-parse", "HEAD"]);
  const contains = (a: string, b: string) =>
    gitOk(rt, checkout, ["merge-base", "--is-ancestor", a, b]);
  let relation: "in-sync" | "behind" | "ahead" | "diverged";
  if (head === pull.head.sha) relation = "in-sync";
  else if (contains(head, pull.head.sha)) relation = "behind";
  else if (contains(pull.head.sha, head)) relation = "ahead";
  else relation = "diverged";
  if (relation === "diverged")
    fail("stale", "the checkout and the pull request have diverged; reconcile them by hand", {
      checkout: head,
      pullRequest: pull.head.sha,
    });
  let fastForwarded = false;
  if (relation === "behind") {
    if (git(rt, checkout, ["status", "--porcelain", "--untracked-files=normal"]))
      fail("dirty-checkout", "the checkout is behind the pull request and has local changes", {
        checkout: head,
        pullRequest: pull.head.sha,
      });
    git(rt, checkout, ["merge", "--quiet", "--ff-only", pull.head.sha]);
    fastForwarded = true;
  }
  const now = git(rt, checkout, ["rev-parse", "HEAD"]);
  const unpublishedCommits = Number(
    git(rt, checkout, ["rev-list", "--count", `${pull.head.sha}..${now}`]),
  );
  const baseHead = git(rt, checkout, ["rev-parse", `refs/remotes/${remote}/${baseBranch}`]);
  const commitsBehindBase = Number(
    git(rt, checkout, ["rev-list", "--count", `${now}..${baseHead}`]),
  );
  const updated = await ctx.state.update(record.operationId, (r) => {
    r.revisions.push({
      prNumber: options.pr,
      reviewedHead: pull.head.sha,
      at: nowIso(rt.now()),
    });
    if (provisioning) r.provisioning = provisioning;
  });
  return {
    result: {
      initiative: updated.operationId,
      checkout,
      pullRequest: options.pr,
      reviewedHead: pull.head.sha,
      checkoutHead: now,
      checkoutCreated,
      relation,
      fastForwarded,
      unpublishedCommits,
      baseDivergence: { base: baseHead, commitsBehindBase },
    },
  };
}

// --- status -----------------------------------------------------------------------------

export function stageOf(record: InitiativeRecord): string {
  if (record.cleanedAt) return "cleaned";
  if (record.completions.length > 0) return "completed";
  if (record.publications.length > 0) return "published";
  if (record.validations.at(-1)?.status === "PASS") return "verified";
  return "started";
}

const summary = (r: InitiativeRecord) => ({
  initiative: r.operationId,
  stage: stageOf(r),
  branch: r.branch,
  checkout: r.checkout,
  base: r.base,
  specification: r.specification,
  lastValidation: r.validations.at(-1) ?? null,
  lastPublication: r.publications.at(-1) ?? null,
  lastCompletion: r.completions.at(-1) ?? null,
  cleanedAt: r.cleanedAt,
});

export async function status(
  ctx: CommandContext,
  options: { id?: string },
): Promise<CommandResult> {
  if (options.id) {
    const record = await ctx.state.get(options.id);
    if (!record) fail("not-found", `${options.id} has no local state`, { initiative: options.id });
    const r = record as InitiativeRecord;
    return {
      result: {
        ...summary(r),
        validations: r.validations,
        publications: r.publications,
        completions: r.completions,
        revisions: r.revisions,
        operations: r.operations,
      },
    };
  }
  const all = await ctx.state.list();
  return { result: { initiatives: all.map(summary) } };
}

// --- verify -----------------------------------------------------------------------------

export async function verify(
  ctx: CommandContext,
  options: { id: string; commit?: string; with?: string[]; keep?: boolean },
): Promise<CommandResult> {
  const { rt } = ctx;
  const { record, trusted } = await loadInitiative(ctx, options.id);
  const checkout = requireCheckout(record);
  const dirty = git(rt, checkout, ["status", "--porcelain", "--untracked-files=normal"]);
  if (dirty)
    fail("dirty-checkout", "commit or remove local changes first; verification is of a commit", {
      changes: dirty.split("\n").slice(0, 20),
    });
  const head = git(rt, checkout, ["rev-parse", "HEAD"]);
  if (options.commit && options.commit !== head)
    fail("stale", "the checkout is not at the requested commit", {
      requested: options.commit,
      head,
    });
  const tree = git(rt, checkout, ["rev-parse", "HEAD^{tree}"]);
  const missingTrailer = commitsWithoutTrailer(ctx, trusted, record, checkout);
  if (missingTrailer.length > 0)
    fail("policy-denied", `commits without "${trusted.commits.trailer}: ${record.ticket}"`, {
      commits: missingTrailer,
    });
  const optional = (options.with ?? []).map(
    (name) =>
      trusted.verification.optional.find((c) => c.name === name) ??
      fail("usage", `--with ${name} names no verification.optional command`, {
        known: trusted.verification.optional.map((c) => c.name),
      }),
  );
  // A host validation policy replaces the configured commands; optional ones still add.
  const commandsToRun = [...(ctx.host.validation ?? trusted.validation.commands), ...optional];
  const snapshot = trusted.verification.snapshot;
  ctx.checkpoint();

  // Validation runs the candidate's code: never with the GitHub credential, never with the
  // developer's gh login. The CLI is not a sandbox; see the README's security section.
  const scratch = mkdtempSync(path.join(tmpdir(), "comforge-verify-"));
  const ghHome = path.join(scratch, "gh");
  mkdirSync(ghHome);
  const runDir = snapshot ? path.join(scratch, "snapshot") : checkout;
  const commands: Validation["commands"] = [];
  let status: Validation["status"] = "FAIL";
  let reason: string | undefined;
  let summary: Validation["summary"] = null;
  let note: string | undefined;
  try {
    if (snapshot) {
      // A fresh clone of exactly this commit: nothing from the working checkout's ignored files.
      try {
        git(rt, scratch, ["clone", "--quiet", "--no-hardlinks", "--no-checkout", checkout, runDir]);
        git(rt, runDir, ["checkout", "--quiet", "--detach", head]);
        // The same hand-over as an isolated checkout (a worker user runs validation here).
        if (ctx.host.prepares) {
          chmodSync(scratch, 0o711);
          ctx.host.prepareCheckout(runDir);
        }
        provision(rt, trusted, runDir, ctx.repo.root, credentialVariables(trusted), "snapshot");
      } catch (error) {
        throw new Unavailable(
          `the snapshot could not be prepared: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    const env = {
      ...childEnv(rt.env, { dropCredentials: credentialVariables(trusted) }),
      GH_CONFIG_DIR: ghHome,
      COMFORGE_VERIFY: "1",
    };
    for (const command of commandsToRun) {
      ctx.checkpoint();
      const started = rt.now();
      const r = rt.run(command.run[0] as string, command.run.slice(1), {
        cwd: runDir,
        env,
        timeoutMs: trusted.validation.timeoutSeconds * 1000,
      });
      commands.push({
        name: command.name,
        exitStatus: r.status,
        timedOut: r.timedOut,
        durationMs: rt.now() - started,
      });
      if (
        r.status !== 0 &&
        !r.timedOut &&
        r.status !== null &&
        trusted.verification.unavailableExitStatuses.includes(r.status)
      )
        throw new Unavailable(`${command.name} reported that it could not run (exit ${r.status})`);
      if (r.status !== 0) break;
    }
    const after = git(rt, runDir, ["rev-parse", "HEAD"]);
    const changed = git(rt, runDir, ["status", "--porcelain", "--untracked-files=normal"]);
    const passed =
      commands.length === commandsToRun.length &&
      commands.every((c) => c.exitStatus === 0) &&
      after === head &&
      changed === "";
    if (after !== head || changed) note = "validation changed the checkout; the result is FAIL";
    status = passed ? "PASS" : "FAIL";
    if (passed && trusted.verification.summary) {
      summary = readSummary(runDir, trusted.verification.summary);
      if (!summary)
        throw new Unavailable(`the summary ${trusted.verification.summary.path} was not written`);
    }
  } catch (error) {
    if (!(error instanceof Unavailable)) throw error;
    status = "UNAVAILABLE";
    reason = error.message;
  } finally {
    rmSync(ghHome, { recursive: true, force: true });
    if (!options.keep) {
      // The snapshot holds files the candidate's commands wrote: the host removes exactly the
      // directory it prepared (a worker user cannot list the private scratch parent), then the
      // CLI removes its own scratch.
      if (snapshot && existsSync(runDir)) ctx.host.remove(runDir);
      rmSync(scratch, { recursive: true, force: true });
    }
  }
  const validation: Validation = {
    commit: head,
    tree,
    status,
    at: nowIso(rt.now()),
    commands,
    snapshot,
    ...(optional.length > 0 ? { optional: optional.map((c) => c.name) } : {}),
    ...(trusted.verification.summary ? { summary } : {}),
    ...(reason ? { reason } : {}),
    ...(ctx.host.validation ? { policy: "host" as const } : {}),
  };
  await ctx.state.update(record.operationId, (r) => {
    r.validations.push(validation);
  });
  return {
    result: {
      initiative: record.operationId,
      ...validation,
      ...(note ? { note } : {}),
      ...(options.keep && snapshot ? { kept: runDir } : {}),
    },
    exit: status === "PASS" ? EXIT.ok : status === "UNAVAILABLE" ? EXIT.failed : EXIT.refused,
  };
}

/** The environment could not run validation: not a test failure, recorded as UNAVAILABLE. */
class Unavailable extends Error {}

function readSummary(
  dir: string,
  config: { path: string; maxBytes: number },
): NonNullable<Validation["summary"]> | null {
  const file = path.join(dir, config.path);
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(file);
  } catch {
    return null;
  }
  if (!stat.isFile() || stat.size > config.maxBytes)
    throw new Unavailable(
      `the summary ${config.path} is not a regular file of at most ${config.maxBytes} bytes`,
    );
  const bytes = readFileSync(file);
  try {
    return {
      path: config.path,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
      content: JSON.parse(bytes.toString("utf8")),
    };
  } catch {
    throw new Unavailable(`the summary ${config.path} is not JSON`);
  }
}

function commitsWithoutTrailer(
  ctx: CommandContext,
  trusted: ComforgeConfig,
  record: InitiativeRecord,
  checkout: string,
): string[] {
  const trailer = trusted.commits.trailer;
  if (!trailer) return [];
  const log = git(ctx.rt, checkout, [
    "log",
    "--no-merges",
    `--format=%H%x1f%(trailers:key=${trailer},valueonly,separator=%x1e)%x1d`,
    `${record.base.sha}..HEAD`,
  ]);
  return log
    .split("\x1d")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .filter((entry) => {
      const [sha, values = ""] = entry.split("\x1f");
      return (
        !values
          .split("\x1e")
          .map((v) => v.trim())
          .includes(record.ticket) && sha
      );
    })
    .map((entry) => entry.split("\x1f")[0] as string);
}

// --- cleanup ----------------------------------------------------------------------------

type CleanupStep = { id: string; action: string };

/**
 * R8: after a merge, the initiative's local and (optionally) remote leftovers, resumable.
 *
 * Proof first: the pull request is merged, its head is the published commit, and the merge
 * reached the base branch (its merge commit, or for a fast-forward the head, is an ancestor of
 * the fetched base). The checkout must be this initiative's isolated clone (under the
 * checkout parent, a repository root), clean, without stashes or extra worktrees, and every
 * local branch in it must be published or on the base. No write of the initiative may be
 * unresolved: its identities are kept in the write ledger either way.
 *
 * Steps run in order and each is journalled when done, so an interrupted cleanup resumes
 * where it stopped. Remote branch deletion needs `branches:delete` and an authorization, and
 * uses a lease on the published commit (a moved branch is never deleted). Nothing restores a
 * removed checkout; a deleted branch can be pushed again from the published commit the
 * journal records.
 */
export async function cleanup(
  ctx: CommandContext,
  options: {
    target: string;
    execute: boolean;
    allowMissingCompletion?: boolean;
    grantFile?: string;
  },
): Promise<CommandResult> {
  const { rt, repo } = ctx;
  let id = options.target;
  if (/^\d+$/.test(options.target)) {
    const working = ctx.working();
    const pull = await ctx
      .github(working)
      .evidence.getPullRequest(Number(options.target))
      .catch(githubError);
    const initiative = initiativeFromBranch(pull.head.ref, working);
    if (!initiative) fail("not-found", `#${options.target} is not an initiative's pull request`);
    id = (initiative as { id: string }).id;
  }
  const { record, trusted } = await loadInitiative(ctx, id);
  const policy = trusted.cleanup;
  const { remote, baseBranch } = trusted.repository;
  const published = record.publications.at(-1) ?? null;
  let mergeCommit: string | null = null;
  if (published) {
    const gh = ctx.github(trusted);
    const { owner, name } = trusted.repository;
    const raw = (await gh.transport
      .get(`/repos/${owner}/${name}/pulls/${published.prNumber}`)
      .catch(githubError)) as {
      merged_at?: string | null;
      merge_commit_sha?: string | null;
      state?: string;
      head?: { sha?: string };
    };
    if (!raw.merged_at)
      fail("policy-denied", `#${published.prNumber} is not merged; cleanup follows a merge`, {
        state: raw.state ?? null,
      });
    if (raw.head?.sha !== published.commit)
      fail("stale", "the merged head is not the published one", {
        merged: raw.head?.sha ?? null,
        published: published.commit,
      });
    const base = fetchBase(rt, repo.root, trusted);
    const onBase = (sha: string) =>
      gitOk(rt, repo.root, ["cat-file", "-e", `${sha}^{commit}`]) &&
      gitOk(rt, repo.root, ["merge-base", "--is-ancestor", sha, base]);
    mergeCommit = raw.merge_commit_sha ?? null;
    if (!(mergeCommit && onBase(mergeCommit)) && !onBase(published.commit))
      fail(
        "stale",
        `the merge of #${published.prNumber} is not on ${baseBranch} yet; fetch and retry`,
        {
          mergeCommit,
          base,
        },
      );
    const open = (await gh.transport
      .get(`/repos/${owner}/${name}/pulls`, { head: `${owner}:${record.branch}`, state: "open" })
      .catch(githubError)) as unknown[];
    if (Array.isArray(open) && open.length > 0)
      fail("conflict", `another open pull request uses ${record.branch}`, {
        pullRequests: open.map((p) => (p as { number?: number }).number ?? null),
      });
    await requireResolvedWrites(ctx, trusted, record);
  }
  const delivered = published?.commit ?? null;
  const completion = record.completions.find((c) => delivered === null || c.commit === delivered);
  if (!completion && !options.allowMissingCompletion)
    fail(
      "policy-denied",
      "no completion record for the delivered head; run comforge complete, or pass --allow-missing-completion",
      { head: delivered },
    );
  if (existsSync(record.checkout)) checkIsolatedClone(ctx, trusted, record, delivered);

  const done = record.cleanup?.steps ?? {};
  const steps: CleanupStep[] = [];
  if (existsSync(record.checkout))
    steps.push({ id: "remove-checkout", action: `remove ${record.checkout}` });
  if (policy.deleteRemoteBranch && delivered) {
    if (!trusted.security.capabilities.includes("branches:delete"))
      fail("config-invalid", "cleanup.deleteRemoteBranch needs the branches:delete capability");
    steps.push({
      id: "delete-remote-branch",
      action: `delete ${remote}/${record.branch} at ${delivered}`,
    });
  }
  if (policy.deleteLocalBranch && delivered)
    steps.push({ id: "delete-local-branch", action: `delete the primary's ${record.branch}` });
  if (policy.fastForwardPrimary)
    steps.push({ id: "fast-forward-primary", action: `fast-forward the primary's ${baseBranch}` });
  for (const command of policy.after)
    steps.push({ id: `after:${command.name}`, action: `run ${command.name} in the primary` });
  steps.push({ id: "mark-cleaned", action: "mark the initiative cleaned" });
  const pending = steps.filter((st) => !done[st.id]);
  const actions = pending.map((st) => st.action);
  if (!options.execute)
    return { result: { initiative: id, executed: false, actions, resumed: Object.keys(done) } };

  // Remote deletion is a remote side effect: authorized before any step runs.
  const authorization = pending.some((st) => st.id === "delete-remote-branch")
    ? await authorizeWrites(ctx, trusted, record, {
        head: delivered as string,
        grantFile: options.grantFile,
        command: "cleanup",
        // Proved above: merged, and the merge reached the base.
        pullRequest: {
          number: published?.prNumber as number,
          headSha: delivered as string,
          open: false,
          merged: true,
        },
      })
    : null;
  await ctx.state.update(id, (r) => {
    r.cleanup ??= {
      prNumber: published?.prNumber ?? null,
      mergeCommit,
      steps: {},
      completedAt: null,
    };
  });
  const results: { step: string; detail: string }[] = [];
  for (const step of pending) {
    ctx.checkpoint();
    let detail: string;
    try {
      detail = runCleanupStep(ctx, trusted, record, step.id, delivered);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        result: {
          initiative: id,
          executed: true,
          cleanup: "incomplete",
          failedStep: step.id,
          error: message,
          steps: results,
          authorization,
        },
        exit: EXIT.incomplete,
      };
    }
    results.push({ step: step.id, detail });
    const at = nowIso(rt.now());
    await ctx.state.update(id, (r) => {
      r.cleanup ??= {
        prNumber: published?.prNumber ?? null,
        mergeCommit,
        steps: {},
        completedAt: null,
      };
      r.cleanup.steps[step.id] = { at, detail };
      if (step.id === "mark-cleaned") {
        r.cleanedAt = at;
        r.cleanup.completedAt = at;
      }
    });
  }
  return { result: { initiative: id, executed: true, actions, steps: results, authorization } };
}

async function requireResolvedWrites(
  ctx: CommandContext,
  trusted: ComforgeConfig,
  record: InitiativeRecord,
): Promise<void> {
  if (record.operations.length === 0) return;
  const gh = ctx.github(trusted);
  const open: string[] = [];
  for (const opId of record.operations) {
    const op = await gh.ledger.get(opId).catch(githubError);
    if (op && ["reserved", "sending", "indeterminate"].includes(op.state)) open.push(opId);
  }
  if (open.length > 0)
    fail(
      "ambiguous",
      "writes of this initiative are unresolved; run comforge recover before cleanup",
      {
        operations: open,
      },
    );
}

/** The recorded checkout is this initiative's own, disposable clone, with nothing unpublished. */
function checkIsolatedClone(
  ctx: CommandContext,
  trusted: ComforgeConfig,
  record: InitiativeRecord,
  delivered: string | null,
): void {
  const { rt } = ctx;
  const checkout = record.checkout;
  // A checkout made under a host policy is removed only under that same policy.
  if (record.hostCheckoutParent && record.hostCheckoutParent !== ctx.host.checkoutParent)
    fail(
      "conflict",
      "the checkout was created under a host checkout parent this caller does not hold",
      {
        checkout,
        hostCheckoutParent: record.hostCheckoutParent,
      },
    );
  const parent = record.hostCheckoutParent ?? checkoutParent(trusted, ctx.repo.root);
  // Real paths: Git reports the top level through symlinks (a temporary directory, for example).
  const real = (p: string) => (existsSync(p) ? realpathSync(p) : path.resolve(p));
  if (path.dirname(real(checkout)) !== real(parent))
    fail(
      "conflict",
      "the recorded checkout is not under the checkout parent; refusing to remove it",
      {
        checkout,
        parent,
      },
    );
  const top = git(rt, checkout, ["rev-parse", "--show-toplevel"]);
  if (real(top) !== real(checkout))
    fail("conflict", "the recorded checkout is not a repository root; refusing to remove it");
  const dirty = git(rt, checkout, ["status", "--porcelain", "--untracked-files=normal"]);
  if (dirty)
    fail("dirty-checkout", "the checkout has uncommitted changes", {
      changes: dirty.split("\n").slice(0, 20),
    });
  if (git(rt, checkout, ["stash", "list"]))
    fail("dirty-checkout", "the checkout has stashes; keep or drop them first");
  const worktrees = git(rt, checkout, ["worktree", "list", "--porcelain"])
    .split("\n")
    .filter((l) => l.startsWith("worktree "));
  if (worktrees.length > 1)
    fail("dirty-checkout", "the checkout has other worktrees", { worktrees: worktrees.length });
  const head = git(rt, checkout, ["rev-parse", "HEAD"]);
  if (delivered && head !== delivered)
    fail("dirty-checkout", "the checkout has commits that were never published", {
      head,
      published: delivered,
    });
  const { remote, baseBranch } = trusted.repository;
  const base = gitRun(rt, checkout, [
    "rev-parse",
    "--verify",
    `refs/remotes/${remote}/${baseBranch}`,
  ]);
  const kept = (tip: string) =>
    (delivered !== null && gitOk(rt, checkout, ["merge-base", "--is-ancestor", tip, delivered])) ||
    (base.status === 0 &&
      gitOk(rt, checkout, ["merge-base", "--is-ancestor", tip, base.stdout.trim()]));
  const unpublished = git(rt, checkout, [
    "for-each-ref",
    "--format=%(refname:short) %(objectname)",
    "refs/heads",
  ])
    .split("\n")
    .filter(Boolean)
    .map((l) => l.split(" ") as [string, string])
    .filter(([, tip]) => !kept(tip))
    .map(([name]) => name);
  if (unpublished.length > 0)
    fail("dirty-checkout", "the checkout has branches with unpublished commits", {
      branches: unpublished,
    });
}

function runCleanupStep(
  ctx: CommandContext,
  trusted: ComforgeConfig,
  record: InitiativeRecord,
  step: string,
  delivered: string | null,
): string {
  const { rt, repo } = ctx;
  const { remote, baseBranch } = trusted.repository;
  if (step === "remove-checkout") {
    ctx.host.remove(record.checkout);
    return `removed ${record.checkout}`;
  }
  if (step === "delete-remote-branch") {
    const line = git(rt, repo.root, ["ls-remote", remote, `refs/heads/${record.branch}`]);
    if (!line) return "already absent";
    // The lease: deleted only while the remote branch is exactly the published commit.
    git(rt, repo.root, [
      "push",
      "--quiet",
      "--no-verify",
      `--force-with-lease=refs/heads/${record.branch}:${delivered}`,
      remote,
      `:refs/heads/${record.branch}`,
    ]);
    return `deleted at ${delivered}`;
  }
  if (step === "delete-local-branch") {
    const tip = gitRun(rt, repo.root, ["rev-parse", "--verify", `refs/heads/${record.branch}`]);
    if (tip.status !== 0) return "absent";
    if (tip.stdout.trim() !== delivered)
      return `kept: at ${tip.stdout.trim()}, not the published commit`;
    if (git(rt, repo.root, ["rev-parse", "--abbrev-ref", "HEAD"]) === record.branch)
      return "kept: checked out in the primary";
    git(rt, repo.root, ["branch", "--quiet", "-D", record.branch]);
    return `deleted at ${delivered}`;
  }
  if (step === "fast-forward-primary") {
    if (git(rt, repo.root, ["rev-parse", "--abbrev-ref", "HEAD"]) !== baseBranch)
      return `skipped: the primary is not on ${baseBranch}`;
    if (git(rt, repo.root, ["status", "--porcelain", "--untracked-files=no"]))
      return "skipped: the primary has local changes";
    const base = fetchBase(rt, repo.root, trusted);
    const head = git(rt, repo.root, ["rev-parse", "HEAD"]);
    if (head === base) return "up to date";
    if (!gitOk(rt, repo.root, ["merge-base", "--is-ancestor", head, base]))
      return `skipped: the primary's ${baseBranch} has its own commits`;
    git(rt, repo.root, ["merge", "--quiet", "--ff-only", base]);
    return `fast-forwarded to ${base}`;
  }
  if (step.startsWith("after:")) {
    const command = trusted.cleanup.after.find((c) => `after:${c.name}` === step);
    if (!command) return "skipped: no longer configured";
    const r = rt.run(command.run[0] as string, command.run.slice(1), {
      cwd: repo.root,
      env: childEnv(rt.env, { dropCredentials: credentialVariables(trusted) }),
      timeoutMs: trusted.validation.timeoutSeconds * 1000,
    });
    if (r.status !== 0)
      throw new Error(`${command.name} exited ${r.status}: ${r.stderr.trim().slice(-300)}`);
    return "ok";
  }
  if (step === "mark-cleaned") return "cleaned";
  throw new Error(`unknown cleanup step ${step}`);
}
