import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { baseConfig, createWorld, type World } from "./harness.ts";

// R5: exact-snapshot verification. A fresh clone of the commit, provisioned as a snapshot,
// PASS / FAIL / UNAVAILABLE kept apart, a recorded summary, optional commands.

let world: World;
afterEach(() => world?.dispose());
const TICKET = "DEMO-001";

function snapshotWorld(
  verification: Record<string, unknown>,
  validation?: Record<string, unknown>,
) {
  const w = createWorld({
    config: baseConfig({
      checkout: {
        provision: [["sh", "-c", 'printf "%s" "$COMFORGE_PROVISION_PURPOSE" > purpose.txt']],
      },
      ...(validation ? { validation } : {}),
      verification: { snapshot: true, ...verification },
    }),
  });
  // purpose.txt, local.txt and summary.json are never committed.
  w.commitFile(w.primary, ".gitignore", "purpose.txt\nlocal.txt\nsummary.json\n", "ignore");
  w.sh(w.primary, "git", "push", "--quiet", "origin", "main");
  return w;
}

async function committed(w: World) {
  const issue = w.specIssue(TICKET);
  const { checkout } = (await w.cli(["start", TICKET, "--issue", String(issue)])).json;
  w.commitFile(checkout, "a.txt", "a\n", `feat: a\n\nTicket: ${TICKET}`);
  return checkout as string;
}

const cmd = (name: string, script: string) => ({ name, run: ["sh", "-c", script] });

describe("R5: snapshot verification", () => {
  test("validates a fresh, snapshot-provisioned clone: the working checkout's ignored files are absent", async () => {
    world = snapshotWorld(
      {},
      {
        commands: [cmd("check", 'test ! -f local.txt && test "$(cat purpose.txt)" = snapshot')],
      },
    );
    const checkout = await committed(world);
    writeFileSync(path.join(checkout, "local.txt"), "only here\n");
    expect(world.sh(checkout, "cat", "purpose.txt")).toBe("checkout");
    const r = await world.cli(["verify", TICKET]);
    expect([r.code, r.json.status, r.json.snapshot]).toEqual([0, "PASS", true]);
    expect(r.json.kept).toBeUndefined();
  });

  test("a test failure is FAIL; an environment that cannot run is UNAVAILABLE, and neither publishes", async () => {
    world = snapshotWorld(
      { unavailableExitStatuses: [75] },
      { commands: [cmd("check", "exit 75")] },
    );
    await committed(world);
    const r = await world.cli(["verify", TICKET]);
    expect([r.code, r.json.status]).toEqual([3, "UNAVAILABLE"]);
    expect(r.json.reason).toContain("could not run");
    const pub = await world.cli(["publish", TICKET, "--title", "A"]);
    expect(pub.code).toBe(1);
    world.dispose();

    world = snapshotWorld(
      { unavailableExitStatuses: [75] },
      { commands: [cmd("check", "exit 1")] },
    );
    await committed(world);
    expect((await world.cli(["verify", TICKET])).json.status).toBe("FAIL");
  });

  test("a snapshot that cannot be provisioned is UNAVAILABLE, not FAIL", async () => {
    world = createWorld({
      config: baseConfig({
        checkout: { provision: [["sh", "-c", 'test "$COMFORGE_PROVISION_PURPOSE" = checkout']] },
        verification: { snapshot: true },
      }),
    });
    await committed(world);
    const r = await world.cli(["verify", TICKET]);
    expect([r.code, r.json.status]).toEqual([3, "UNAVAILABLE"]);
    expect(r.json.reason).toContain("snapshot could not be prepared");
  });

  test("the summary artifact is recorded with its digest; a missing or oversized one is UNAVAILABLE", async () => {
    world = snapshotWorld(
      { summary: { path: "summary.json", maxBytes: 100 } },
      { commands: [cmd("check", `printf '{"status":"PASS","tests":3}' > summary.json`)] },
    );
    await committed(world);
    const r = await world.cli(["verify", TICKET]);
    expect(r.json.status).toBe("PASS");
    expect(r.json.summary).toMatchObject({
      path: "summary.json",
      bytes: 27,
      content: { status: "PASS", tests: 3 },
    });
    expect(r.json.summary.sha256).toMatch(/^[0-9a-f]{64}$/);
    world.dispose();

    for (const script of ["true", `printf '%0200d' 0 > summary.json`]) {
      world = snapshotWorld(
        { summary: { path: "summary.json", maxBytes: 100 } },
        { commands: [cmd("check", script)] },
      );
      await committed(world);
      expect((await world.cli(["verify", TICKET])).json.status).toBe("UNAVAILABLE");
      world.dispose();
    }
    world = createWorld();
  });

  test("optional commands run only when named; --keep keeps the snapshot", async () => {
    world = snapshotWorld({ optional: [cmd("e2e", "exit 1")] });
    await committed(world);
    expect((await world.cli(["verify", TICKET])).json.status).toBe("PASS");
    const withE2e = await world.cli(["verify", TICKET, "--with", "e2e"]);
    expect([withE2e.json.status, withE2e.json.optional]).toEqual(["FAIL", ["e2e"]]);
    expect((await world.cli(["verify", TICKET, "--with", "nope"])).json.error).toBe("usage");
    const kept = await world.cli(["verify", TICKET, "--keep"]);
    expect(existsSync(kept.json.kept)).toBe(true);
    rmSync(path.dirname(kept.json.kept), { recursive: true, force: true });
  });
});
