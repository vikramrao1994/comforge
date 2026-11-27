import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

type Job = {
  if?: string;
  environment?: string;
  needs?: string | string[];
  permissions?: Record<string, string>;
  steps: { name?: string; run?: string; uses?: string; env?: Record<string, string> }[];
};
const REPO = path.resolve(import.meta.dir, "../..");
const load = (f: string) =>
  Bun.YAML.parse(readFileSync(path.join(REPO, ".github/workflows", f), "utf8")) as {
    on: unknown;
    permissions: Record<string, string>;
    jobs: Record<string, Job>;
  };

describe("release.yml", () => {
  const wf = load("release.yml");
  test("is manual only, read-only by default, one run at a time", () => {
    expect(Object.keys(wf.on as object)).toEqual(["workflow_dispatch"]);
    expect(wf.permissions).toEqual({ contents: "read" });
  });
  test("only the release job sees a credential, through the main-restricted environment", () => {
    for (const [name, job] of Object.entries(wf.jobs)) {
      const usesSecret = JSON.stringify(job).includes("secrets.");
      expect([name, usesSecret]).toEqual([name, name === "release"]);
    }
    expect(wf.jobs.release?.environment).toBe("comforge-release");
  });
  test("authorize and release run only when this repository is the active publisher", () => {
    for (const name of ["authorize", "release"]) expect(wf.jobs[name]?.if).toContain("vars.COMFORGE_PUBLISHER == 'comforge'");
    expect(wf.jobs.candidate?.if).not.toContain("COMFORGE_PUBLISHER");
  });
  test("the exact branch is checked before any step that receives a secret", () => {
    const steps = wf.jobs.release?.steps ?? [];
    const first = steps.findIndex((s) => JSON.stringify(s).includes("secrets."));
    expect(steps[0]?.run).toBe('test "$GITHUB_REF" = "refs/heads/main"');
    expect(first).toBeGreaterThan(0);
  });
  test("every action is pinned to a full commit SHA", () => {
    for (const f of ["release.yml", "ci.yml"])
      for (const job of Object.values(load(f).jobs)) for (const s of job.steps) if (s.uses) expect(s.uses).toMatch(/@[0-9a-f]{40}$/);
  });
});

describe("ci.yml", () => {
  const wf = load("ci.yml");
  test("holds no credential and writes nothing", () => {
    expect(JSON.stringify(wf)).not.toContain("secrets.");
    expect(wf.permissions).toEqual({ contents: "read" });
  });
  test("tests every supported runtime on Linux and macOS", () => {
    const matrix = (wf.jobs.test as unknown as { strategy: { matrix: { os: string[]; node: number[] } } }).strategy.matrix;
    expect(matrix.os).toEqual(["ubuntu-latest", "macos-latest"]);
    expect(matrix.node).toEqual([22, 24, 26]);
  });
});
