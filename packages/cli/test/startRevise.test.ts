import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { baseConfig, createWorld, type World } from "./harness.ts";

// R4: provisioning commands and their typed, checked result.
// R9: start preflight and phase prerequisites; revise re-creates, fast-forwards, reports.

let world: World;
afterEach(() => world?.dispose());
const TICKET = "DEMO-001";

const provisioned = (script: string) =>
  baseConfig({ checkout: { provision: [["sh", "-c", script]] } });

const issues = new WeakMap<World, Map<string, number>>();
/** Starts `id` with its ticket's specification issue (one issue per ticket, as phases require). */
async function start(w: World, id = TICKET) {
  const ticket = id.split(".")[0] as string;
  const known = issues.get(w) ?? new Map<string, number>();
  issues.set(w, known);
  const issue = known.get(ticket) ?? w.specIssue(ticket);
  known.set(ticket, issue);
  return w.cli(["start", id, "--issue", String(issue)]);
}

describe("R4: provisioning results", () => {
  test("a command's result is recorded; it sees the primary and never the credential", async () => {
    world = createWorld({
      config: provisioned(
        // A shell parameter expansion, not a template placeholder.
        // biome-ignore lint/suspicious/noTemplateCurlyInString: shell syntax
        'test -z "${ACME_TOKEN:-}" || exit 9; test -d "$COMFORGE_PRIMARY/.git" || exit 8; ' +
          `printf '{"schema":"comforge-provision-result/v1","steps":[{"name":"diagnostics","detail":"copied 2 files","digest":"${"a".repeat(64)}"}]}' > "$COMFORGE_PROVISION_RESULT"`,
      ),
    });
    const r = await start(world);
    expect(r.code).toBe(0);
    expect(r.json.provisioning).toEqual([
      {
        command: expect.stringContaining("sh -c"),
        steps: [{ name: "diagnostics", detail: "copied 2 files", digest: "a".repeat(64) }],
      },
    ]);
    expect(r.json.primaryCheckout).toEqual({
      untouched: true,
      trackedChanges: 0,
      untrackedFiles: 0,
    });
  });

  test("an unsafe or malformed result fails provisioning and leaves nothing behind", async () => {
    for (const script of [
      'ln -s /etc/hosts "$COMFORGE_PROVISION_RESULT"',
      `printf '{"schema":"comforge-provision-result/v1","steps":[{"name":"x","detail":"ghp_${"A".repeat(36)}"}]}' > "$COMFORGE_PROVISION_RESULT"`,
      `printf '{"schema":"other/v1","steps":[]}' > "$COMFORGE_PROVISION_RESULT"`,
      "exit 3",
    ]) {
      world = createWorld({ config: provisioned(script) });
      const r = await start(world);
      expect([r.code, r.json.error]).toEqual([3, "io"]);
      expect(existsSync(path.join(path.dirname(world.primary), "widgets-agents", "demo-001"))).toBe(
        false,
      );
      expect((await world.cli(["status"])).json.initiatives).toEqual([]);
      world.dispose();
    }
    world = createWorld({ config: provisioned("exit 3") });
    const skipped = await world.cli([
      "start",
      TICKET,
      "--issue",
      String(world.specIssue(TICKET)),
      "--no-provision",
    ]);
    expect([skipped.code, skipped.json.provisioning]).toEqual([0, []]);
  }, 60_000);
});

describe("R9: start preflight and phases", () => {
  test("remotePreflight refuses a branch the remote already has, or a pull request for it", async () => {
    world = createWorld({ config: baseConfig({ lifecycle: { remotePreflight: true } }) });
    world.sh(world.primary, "git", "push", "--quiet", "origin", "main:refs/heads/agent/demo-001");
    const r = await start(world);
    expect([r.code, r.json.error]).toEqual([1, "conflict"]);
    world.sh(world.primary, "git", "push", "--quiet", "origin", "--delete", "agent/demo-001");
    world.gh.seedPull("agent/demo-001", "c".repeat(40), { state: "closed" });
    const pr = await start(world);
    expect([pr.code, pr.json.error]).toEqual([1, "conflict"]);
    expect(pr.json.message).toContain("pull request already exists");
  });

  test("phaseRequiresCleanParent: a phase waits for its ticket's cleanup and for the other phases", async () => {
    world = createWorld({ config: baseConfig({ lifecycle: { phaseRequiresCleanParent: true } }) });
    expect((await start(world)).code).toBe(0);
    const early = await start(world, `${TICKET}.b`);
    expect([early.code, early.json.error]).toEqual([1, "conflict"]);
    const clean = await world.cli(["cleanup", TICKET, "--allow-missing-completion", "--execute"]);
    expect(clean.code).toBe(0);
    expect((await start(world, `${TICKET}.b`)).code).toBe(0);
    const second = await start(world, `${TICKET}.c`);
    expect([second.code, second.json.error]).toEqual([1, "conflict"]);
    expect(second.json.message).toContain("another phase");
  });
});

describe("R9: revise", () => {
  async function published(w: World) {
    const { checkout } = (await start(w)).json;
    w.commitFile(checkout, "a.txt", "a\n", `feat: a\n\nTicket: ${TICKET}`);
    await w.cli(["verify", TICKET]);
    const r = await w.cli(["publish", TICKET, "--title", "A", "--execute"]);
    return { checkout, pr: r.json.pullRequest.number as number };
  }

  /** Another machine pushes a commit to the branch; GitHub's pull request follows it. */
  function pushElsewhere(w: World, pr: number) {
    const other = path.join(w.root, "other");
    if (!existsSync(other))
      w.sh(w.root, "git", "clone", "--quiet", "--branch", "agent/demo-001", w.remote, other);
    else w.sh(other, "git", "pull", "--quiet", "--ff-only");
    const sha = w.commitFile(other, `b-${Date.now()}.txt`, "b\n", `feat: b\n\nTicket: ${TICKET}`);
    w.sh(other, "git", "push", "--quiet", "origin", "HEAD:agent/demo-001");
    const pull = w.gh.pulls.get(pr);
    if (pull) pull.head.sha = sha;
    return sha;
  }

  test("in sync, then behind (fast-forwarded), then ahead (reported)", async () => {
    world = createWorld();
    const { checkout, pr } = await published(world);
    expect((await world.cli(["revise", String(pr)])).json).toMatchObject({
      relation: "in-sync",
      fastForwarded: false,
    });
    const sha = pushElsewhere(world, pr);
    const behind = await world.cli(["revise", String(pr)]);
    expect(behind.json).toMatchObject({
      relation: "behind",
      fastForwarded: true,
      checkoutHead: sha,
    });
    world.commitFile(checkout, "c.txt", "c\n", `feat: c\n\nTicket: ${TICKET}`);
    const ahead = await world.cli(["revise", String(pr)]);
    expect(ahead.json).toMatchObject({
      relation: "ahead",
      unpublishedCommits: 1,
      fastForwarded: false,
    });
    expect(ahead.json.baseDivergence.commitsBehindBase).toBe(0);
  });

  test("a missing checkout is re-created at the pull request head", async () => {
    world = createWorld();
    const { checkout, pr } = await published(world);
    const head = world.sh(checkout, "git", "rev-parse", "HEAD");
    rmSync(checkout, { recursive: true, force: true });
    const r = await world.cli(["revise", String(pr)]);
    expect(r.json).toMatchObject({
      checkoutCreated: true,
      relation: "in-sync",
      checkoutHead: head,
    });
    expect(world.sh(checkout, "git", "rev-parse", "--abbrev-ref", "HEAD")).toBe("agent/demo-001");
  });

  test("diverged is refused; behind with local changes is refused; nothing is rewritten", async () => {
    world = createWorld();
    const { checkout, pr } = await published(world);
    pushElsewhere(world, pr);
    world.commitFile(checkout, "local.txt", "x\n", `feat: local\n\nTicket: ${TICKET}`);
    const local = world.sh(checkout, "git", "rev-parse", "HEAD");
    const diverged = await world.cli(["revise", String(pr)]);
    expect([diverged.code, diverged.json.error]).toEqual([1, "stale"]);
    expect(world.sh(checkout, "git", "rev-parse", "HEAD")).toBe(local);

    world.sh(checkout, "git", "reset", "--quiet", "--hard", "HEAD~1");
    pushElsewhere(world, pr);
    world.sh(checkout, "sh", "-c", "echo dirty > a.txt");
    const dirty = await world.cli(["revise", String(pr)]);
    expect([dirty.code, dirty.json.error]).toEqual([1, "dirty-checkout"]);
  });
});
