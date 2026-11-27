import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ANCHOR_FILE, anchoredCommit } from "../../tooling/release/releasePlan";

// Baselines built before the packages moved here name commits of the previous repository. Only
// the reviewed, committed anchor file may map one to a local commit; anything else stays
// foreign, so the planner keeps refusing it (baseline-unrelated).
const dir = mkdtempSync(path.join(tmpdir(), "release-anchor-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const git = (...args: string[]) => spawnSync("git", args, { cwd: dir, encoding: "utf8" }).stdout.trim();

test("a foreign baseline commit maps through the committed anchor, and only through it", () => {
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  writeFileSync(path.join(dir, "a.txt"), "a\n");
  git("add", "-A");
  git("commit", "-qm", "import");
  const imported = git("rev-parse", "HEAD");
  const foreign = "a".repeat(40);
  const unmapped = "b".repeat(40);
  expect(anchoredCommit(dir, imported, foreign)).toBe(foreign);
  mkdirSync(path.join(dir, path.dirname(ANCHOR_FILE)), { recursive: true });
  writeFileSync(path.join(dir, ANCHOR_FILE), JSON.stringify({ schema: "comforge-release-anchor/v1", anchors: { [foreign]: imported } }));
  // Uncommitted anchors do not count: the planner reads the committed head.
  expect(anchoredCommit(dir, imported, foreign)).toBe(foreign);
  git("add", "-A");
  git("commit", "-qm", "anchor");
  const head = git("rev-parse", "HEAD");
  expect(anchoredCommit(dir, head, foreign)).toBe(imported);
  expect(anchoredCommit(dir, head, unmapped)).toBe(unmapped);
  // A commit that exists locally is never remapped.
  expect(anchoredCommit(dir, head, imported)).toBe(imported);
});
