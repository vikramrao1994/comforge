/**
 * Cost: none — deterministic scheduling
 *
 * Seeded randomized scheduling. Within each repetition every (repository, task, arm) run is
 * shuffled together, so no arm systematically runs first, last or warm; the order is recorded
 * and digested. The fixture seed is per repository, so every arm and repetition of a cell sees
 * the same snapshot.
 */
import { canonicalJson, sha256, shuffled } from "./prng.ts";
import type { ArmId, RepoId, TaskId } from "./types.ts";

export interface ScheduledRun {
  runId: string;
  index: number;
  repetition: number;
  repo: RepoId;
  task: TaskId;
  arm: ArmId;
  /** The first repetition of a cell is recorded separately (cache warmth). */
  firstOfCell: boolean;
  fixtureSeed: string;
}

export interface ScheduleInput {
  seed: string;
  repetitions: number;
  arms: readonly ArmId[];
  tasks: readonly TaskId[];
  repos: readonly RepoId[];
}

export function buildSchedule(i: ScheduleInput): { runs: ScheduledRun[]; digest: string } {
  const runs: ScheduledRun[] = [];
  for (let rep = 1; rep <= i.repetitions; rep++) {
    const block = i.repos.flatMap((repo) =>
      i.tasks.flatMap((task) => i.arms.map((arm) => ({ repo, task, arm }))),
    );
    for (const c of shuffled(block, `${i.seed}:schedule:rep${rep}`))
      runs.push({
        runId: `r${rep}-${c.repo}-${c.task}-${c.arm}`,
        index: runs.length + 1,
        repetition: rep,
        ...c,
        firstOfCell: rep === 1,
        fixtureSeed: `${i.seed}:${c.repo}`,
      });
  }
  return { runs, digest: sha256(canonicalJson(runs)) };
}

export const cellKey = (r: Pick<ScheduledRun, "repo" | "task" | "arm">) =>
  `${r.repo}|${r.task}|${r.arm}`;

export function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return Number.NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return (sorted[lo] as number) + ((sorted[hi] as number) - (sorted[lo] as number)) * (pos - lo);
}

/** Median, interquartile range and min/max; never a pooled mean. */
export function summarize(values: number[]) {
  const s = [...values].sort((a, b) => a - b);
  const q = (p: number) => Math.round(quantile(s, p) * 1e6) / 1e6;
  return { n: s.length, median: q(0.5), q1: q(0.25), q3: q(0.75), min: q(0), max: q(1) };
}
