/**
 * `bun tooling/release/releaseSelect.ts [--registry] [--package ID]` — the packages the release
 * workflow releases from this commit: every registry package (dependency order) the release
 * planner reports release-ready, or only `--package ID`. Prints `packages=["cli","mcp"]` for
 * `$GITHUB_OUTPUT`, and one line per package on stderr with the planner's verdict.
 *
 * Read-only: it runs the planner's `plan` command and nothing else. A refusal (for example a
 * version already on the registry, with `--registry`) is never selected, so a release that
 * finished is not started again.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { PACKAGE_NAMES, profileOf } from "./packages";

const REPO = path.resolve(import.meta.dir, "..", "..");

export interface Verdict {
  id: string;
  status: string;
}

/** The planner's status of one package, or `refused` when it refuses to plan. */
export function planStatus(name: string, registry: boolean, repo = REPO): string {
  const r = spawnSync(
    "bun",
    [
      "tooling/release/releasePlan.ts",
      "plan",
      "--package",
      name,
      "--json",
      ...(registry ? ["--registry"] : []),
    ],
    { cwd: repo, encoding: "utf8" },
  );
  if (r.status !== 0) return "refused";
  try {
    return (JSON.parse(r.stdout) as { status?: string }).status ?? "refused";
  } catch {
    return "refused";
  }
}

export function selectPackages(
  options: { registry: boolean; only?: string },
  status: (name: string) => string = (name) => planStatus(name, options.registry),
): { selected: string[]; verdicts: Verdict[] } {
  const names = options.only ? [profileOf(`@comforge/${options.only}`).name] : PACKAGE_NAMES;
  const verdicts = names.map((name) => ({ id: profileOf(name).id, status: status(name) }));
  return {
    selected: verdicts.filter((v) => v.status === "release-ready").map((v) => v.id),
    verdicts,
  };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const i = argv.indexOf("--package");
  const only = i >= 0 ? argv[i + 1] : undefined;
  const { selected, verdicts } = selectPackages({ registry: argv.includes("--registry"), only });
  for (const v of verdicts) console.error(`${v.id}: ${v.status}`);
  console.log(`packages=${JSON.stringify(selected)}`);
}
