import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildFixture, fixtureDigest } from "../../benchmarks/fixtures";
import { buildSchedule } from "../../benchmarks/scheduler";
import { runSelfCheck, SELF_CHECKS } from "../../benchmarks/selfCheck";
import { REPO_IDS, TASK_IDS } from "../../benchmarks/types";

// Dry run only: scripted behaviour against the synthetic GitHub, no model, no network.
test("fixtures are deterministic per seed and differ across seeds", () => {
  for (const repo of REPO_IDS) {
    expect(fixtureDigest(buildFixture(repo, "s1"))).toBe(fixtureDigest(buildFixture(repo, "s1")));
    expect(fixtureDigest(buildFixture(repo, "s1"))).not.toBe(fixtureDigest(buildFixture(repo, "s2")));
  }
});

test("the schedule is a seeded, recorded shuffle of every cell", () => {
  const input = { seed: "s", repetitions: 2, arms: ["a", "b"], tasks: TASK_IDS, repos: REPO_IDS };
  const one = buildSchedule(input);
  expect(one.digest).toBe(buildSchedule(input).digest);
  expect(one.runs).toHaveLength(2 * 2 * TASK_IDS.length * REPO_IDS.length);
});

test("every task's checks accept the right scripted behaviour and flag the wrong ones", async () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "bench-selfcheck-"));
  try {
    const results = [];
    for (const c of SELF_CHECKS) results.push(await runSelfCheck(c, "selfcheck", scratch));
    expect(results.filter((r) => !r.pass).map((r) => r.id)).toEqual([]);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}, 300_000);
