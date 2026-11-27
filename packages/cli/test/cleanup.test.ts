import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createFileLedger } from "@comforge/ledger/file";
import { openContext } from "../src/context.ts";
import { baseConfig, createWorld, type World } from "./harness.ts";

// R8: cleanup proves the merge reached the base, removes only an isolated, fully published
// clone, and runs its configured steps once each, resumably.

let world: World;
afterEach(() => world?.dispose());
const TICKET = "DEMO-001";

const SECURITY = {
  credentials: { source: "env", variable: "ACME_TOKEN" },
  authorization: { mode: "operator" },
  capabilities: ["pulls:create", "pulls:update", "issues:comment", "branches:delete"],
};

/** Started, published and merged (by fast-forward unless `onBase` is false). */
async function merged(w: World, onBase = true) {
  const issue = w.specIssue(TICKET);
  const { checkout } = (await w.cli(["start", TICKET, "--issue", String(issue)])).json;
  w.commitFile(checkout, "a.txt", "a\n", `feat: a\n\nTicket: ${TICKET}`);
  await w.cli(["verify", TICKET]);
  const pr = (await w.cli(["publish", TICKET, "--title", "A", "--execute"])).json.pullRequest
    .number as number;
  const head = w.sh(checkout, "git", "rev-parse", "HEAD");
  const pull = w.gh.pulls.get(pr);
  if (pull)
    Object.assign(pull, { state: "closed", merged: true, merged_at: "2026-01-02T00:00:00Z" });
  if (onBase) w.sh(w.remote, "git", "update-ref", "refs/heads/main", head);
  return { checkout, pr, head };
}

const remoteBranch = (w: World) =>
  w.sh(w.remote, "git", "for-each-ref", "--format=%(objectname)", "refs/heads/agent/demo-001");
const cleanup = (w: World, ...extra: string[]) =>
  w.cli(["cleanup", TICKET, "--allow-missing-completion", ...extra]);

describe("R8: proofs before anything is removed", () => {
  test("a merge that has not reached the base is refused", async () => {
    world = createWorld();
    const { checkout } = await merged(world, false);
    const r = await cleanup(world, "--execute");
    expect([r.code, r.json.error]).toEqual([1, "stale"]);
    expect(existsSync(checkout)).toBe(true);
  });

  test("a squash merge is proven by its merge commit on the base", async () => {
    world = createWorld();
    const { pr } = await merged(world, false);
    world.sh(world.primary, "git", "pull", "--quiet", "--ff-only");
    const squash = world.commitFile(world.primary, "a.txt", "a\n", "feat: a (squashed)");
    world.sh(world.primary, "git", "push", "--quiet", "origin", "main");
    const pull = world.gh.pulls.get(pr) as unknown as Record<string, unknown>;
    pull.merge_commit_sha = squash;
    expect((await cleanup(world, "--execute")).code).toBe(0);
  });

  test("dirty, stashed, unpublished, foreign or unresolved: refused, nothing removed", async () => {
    world = createWorld();
    const { checkout } = await merged(world);
    writeFileSync(path.join(checkout, "scratch.txt"), "x\n");
    expect((await cleanup(world, "--execute")).json.error).toBe("dirty-checkout");
    world.sh(checkout, "git", "add", "scratch.txt");
    world.sh(checkout, "git", "stash", "--quiet");
    expect((await cleanup(world, "--execute")).json.message).toContain("stashes");
    world.sh(checkout, "git", "stash", "drop", "--quiet");
    world.sh(checkout, "git", "switch", "--quiet", "-c", "side");
    world.commitFile(checkout, "side.txt", "s\n", `feat: side\n\nTicket: ${TICKET}`);
    world.sh(checkout, "git", "switch", "--quiet", "agent/demo-001");
    expect((await cleanup(world, "--execute")).json.message).toContain("unpublished commits");
    world.sh(checkout, "git", "branch", "--quiet", "-D", "side");

    const ctx = openContext(world.rt());
    await ctx.state.update(TICKET, (r) => {
      r.checkout = world.primary;
    });
    expect((await cleanup(world, "--execute")).json.message).toContain(
      "not under the checkout parent",
    );
    await ctx.state.update(TICKET, (r) => {
      r.checkout = checkout;
    });

    const ledger = createFileLedger({
      directory: path.join(world.primary, ".git", "comforge"),
      namespace: "writes",
    });
    await ledger.create({
      schema: "comforge-github-operation/v1",
      operationId: "pending-x",
      version: 1,
      state: "indeterminate",
    } as never);
    await ctx.state.update(TICKET, (r) => {
      r.operations.push("pending-x");
    });
    expect((await cleanup(world, "--execute")).json.error).toBe("ambiguous");
    expect(existsSync(checkout)).toBe(true);
  });
});

describe("R8: configured steps, journalled and resumable", () => {
  test("remote and local branch, primary fast-forward and an after hook, each once", async () => {
    world = createWorld({
      config: baseConfig({
        security: SECURITY,
        cleanup: {
          deleteRemoteBranch: true,
          deleteLocalBranch: true,
          fastForwardPrimary: true,
          after: [{ name: "index", run: ["sh", "-c", "echo indexed > .indexed"] }],
        },
      }),
    });
    const { checkout, head } = await merged(world);
    world.sh(world.primary, "git", "fetch", "--quiet", "origin", "agent/demo-001:agent/demo-001");
    const plan = await cleanup(world);
    expect(plan.json.actions).toEqual([
      `remove ${checkout}`,
      `delete origin/agent/demo-001 at ${head}`,
      "delete the primary's agent/demo-001",
      "fast-forward the primary's main",
      "run index in the primary",
      "mark the initiative cleaned",
    ]);
    const r = await cleanup(world, "--execute");
    expect(r.code).toBe(0);
    expect(r.json.authorization).toMatchObject({ mode: "operator" });
    expect(existsSync(checkout)).toBe(false);
    expect(remoteBranch(world)).toBe("");
    expect(world.sh(world.primary, "git", "branch", "--list", "agent/demo-001")).toBe("");
    expect(world.sh(world.primary, "git", "rev-parse", "HEAD")).toBe(head);
    expect(existsSync(path.join(world.primary, ".indexed"))).toBe(true);
    const record = await openContext(world.rt()).state.get(TICKET);
    expect(Object.keys(record?.cleanup?.steps ?? {})).toEqual([
      "remove-checkout",
      "delete-remote-branch",
      "delete-local-branch",
      "fast-forward-primary",
      "after:index",
      "mark-cleaned",
    ]);
    expect(record?.cleanedAt).not.toBeNull();
  });

  test("a moved remote branch is never deleted; the cleanup stops and resumes where it stopped", async () => {
    world = createWorld({
      config: baseConfig({ security: SECURITY, cleanup: { deleteRemoteBranch: true } }),
    });
    const { checkout, head } = await merged(world);
    // Someone pushed to the branch after the merge.
    const other = path.join(world.root, "other");
    world.sh(
      world.root,
      "git",
      "clone",
      "--quiet",
      "--branch",
      "agent/demo-001",
      world.remote,
      other,
    );
    const moved = world.commitFile(other, "late.txt", "late\n", "late");
    world.sh(other, "git", "push", "--quiet", "origin", "HEAD:agent/demo-001");
    const r = await cleanup(world, "--execute");
    expect([r.code, r.json.failedStep]).toEqual([4, "delete-remote-branch"]);
    expect(existsSync(checkout)).toBe(false);
    expect(remoteBranch(world)).toBe(moved);
    // Put back where it was published: the rerun does only the remaining steps.
    world.sh(world.remote, "git", "update-ref", "refs/heads/agent/demo-001", head);
    const resumed = await cleanup(world, "--execute");
    expect(resumed.code).toBe(0);
    expect(resumed.json.steps.map((s: { step: string }) => s.step)).toEqual([
      "delete-remote-branch",
      "mark-cleaned",
    ]);
    expect(remoteBranch(world)).toBe("");
  });

  test("deleting the remote branch needs the branches:delete capability", async () => {
    world = createWorld({ config: baseConfig({ cleanup: { deleteRemoteBranch: true } }) });
    await merged(world);
    expect((await cleanup(world)).json.error).toBe("config-invalid");
  });
});
