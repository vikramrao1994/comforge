/**
 * `bun tooling/verifyRuleset.ts [--repo OWNER/REPO] [--json]`
 *
 * Read-only check that the live `protect-main` ruleset enforces at least what
 * `.github/rulesets/protect-main.json` declares: active, on the default branch, no bypass,
 * deletion and force-push blocked, pull requests (with code-owner review when the file asks), and every required
 * status check (by name and by the GitHub Actions app). It only reads (`gh api`, GET); applying
 * the ruleset is an owner action. Until this prints PASS, CI is advisory: a direct push to
 * `main` would not wait for it.
 *
 * Exit 0 PASS, 1 FAIL, 2 the ruleset could not be read.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const REPO = path.resolve(import.meta.dir, "..");
export const RULESET_FILE = ".github/rulesets/protect-main.json";

type Rule = { type: string; parameters?: Record<string, unknown> };
export type Ruleset = {
  name: string;
  target: string;
  enforcement: string;
  conditions?: { ref_name?: { include?: string[]; exclude?: string[] } };
  bypass_actors?: unknown[];
  rules: Rule[];
};
type Check = { context: string; integration_id?: number };

const DEFAULT_BRANCH = new Set(["~DEFAULT_BRANCH", "refs/heads/main"]);

/** Every way `live` is weaker than `expected`; empty when it enforces at least as much. */
export function rulesetGaps(expected: Ruleset, live: Ruleset): string[] {
  const gaps: string[] = [];
  if (live.enforcement !== "active") gaps.push(`enforcement is ${live.enforcement}, not active`);
  if (live.target !== expected.target) gaps.push(`target is ${live.target}`);
  const include = live.conditions?.ref_name?.include ?? [];
  if (!include.some((r) => DEFAULT_BRANCH.has(r))) gaps.push("does not apply to main");
  if ((live.bypass_actors ?? []).length > 0)
    gaps.push(`${(live.bypass_actors ?? []).length} bypass actor(s)`);
  const liveRule = (type: string) => live.rules.find((r) => r.type === type);
  for (const rule of expected.rules) {
    const found = liveRule(rule.type);
    if (!found) {
      gaps.push(`missing rule ${rule.type}`);
      continue;
    }
    if (rule.type === "pull_request") {
      const want = rule.parameters ?? {};
      const have = found.parameters ?? {};
      if (
        Number(have.required_approving_review_count ?? 0) <
        Number(want.required_approving_review_count ?? 0)
      )
        gaps.push("pull_request: fewer required approvals");
      for (const flag of ["require_code_owner_review", "dismiss_stale_reviews_on_push"])
        if (want[flag] === true && have[flag] !== true) gaps.push(`pull_request: ${flag} is off`);
    }
    if (rule.type === "required_status_checks") {
      const want = (rule.parameters?.required_status_checks ?? []) as Check[];
      const have = (found.parameters?.required_status_checks ?? []) as Check[];
      for (const check of want) {
        const match = have.find((h) => h.context === check.context);
        if (!match) gaps.push(`required check missing: ${check.context}`);
        else if (
          check.integration_id !== undefined &&
          match.integration_id !== check.integration_id
        )
          gaps.push(`required check not bound to the GitHub Actions app: ${check.context}`);
      }
      if (
        rule.parameters?.strict_required_status_checks_policy === true &&
        found.parameters?.strict_required_status_checks_policy !== true
      )
        gaps.push("required checks do not require an up-to-date branch");
    }
  }
  return gaps;
}

function gh(args: string[]): unknown {
  const r = spawnSync("gh", ["api", ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error((r.stderr || r.stdout).trim().slice(0, 300));
  return JSON.parse(r.stdout);
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const i = argv.indexOf("--repo");
  const repo = i >= 0 ? (argv[i + 1] as string) : "vikramrao1994/comforge";
  const expected = JSON.parse(readFileSync(path.join(REPO, RULESET_FILE), "utf8")) as Ruleset;
  let live: Ruleset | null = null;
  try {
    const list = gh([`repos/${repo}/rulesets`]) as { id: number; name: string }[];
    const entry = list.find((r) => r.name === expected.name);
    if (entry) live = gh([`repos/${repo}/rulesets/${entry.id}`]) as Ruleset;
  } catch (error) {
    console.error(`verifyRuleset: cannot read ${repo} rulesets: ${(error as Error).message}`);
    process.exit(2);
  }
  const gaps = live ? rulesetGaps(expected, live) : [`no ruleset named ${expected.name}`];
  const result = {
    repository: repo,
    ruleset: expected.name,
    verdict: gaps.length === 0 ? "PASS" : "FAIL",
    gaps,
    checkedAt: new Date().toISOString(),
  };
  if (argv.includes("--json")) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`${result.verdict} ${repo} ${expected.name}`);
    for (const g of gaps) console.log(`  - ${g}`);
  }
  process.exit(gaps.length === 0 ? 0 : 1);
}
