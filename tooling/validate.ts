/**
 * `bun run validate [routing|skills|docs|boundaries|harness|disclosure|reference|invented|versions|recipes|benchmarks|links|excerpts|brand|demos ...]`
 * — the repository validators (all of them without arguments). Exit 0 only when every selected
 * check is clean.
 */

import { checkBrand } from "./brand/brand";
import { checkDiagrams } from "./brand/diagrams";
import { checkBoundaries, checkDocs, checkHarness, checkRouting, checkSkills } from "./checks";
import { checkDemos, checkExcerpts } from "./demos/demos";
import { scan } from "./disclosure";
import {
  checkBenchmarks,
  checkInvented,
  checkRecipes,
  checkReference,
  checkVersions,
} from "./docs/checks";
import { checkLinks } from "./docs/links";

const CHECKS: Record<string, () => string[] | Promise<string[]>> = {
  routing: checkRouting,
  skills: checkSkills,
  docs: checkDocs,
  boundaries: checkBoundaries,
  harness: checkHarness,
  disclosure: () => {
    const r = scan();
    return [
      ...r.findings.map((f) => `${f.file}:${f.line} ${f.rule}`),
      ...r.unusedAllowances.map((a) => `unused allowance ${a.path} ${a.rule}`),
    ];
  },
  reference: checkReference,
  invented: checkInvented,
  versions: checkVersions,
  recipes: checkRecipes,
  benchmarks: checkBenchmarks,
  links: checkLinks,
  excerpts: checkExcerpts,
  brand: () => [...checkBrand(), ...checkDiagrams()],
  // Re-records every terminal demo (needs the harness: bun run harness:install).
  demos: () => checkDemos(),
};
const selected = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(CHECKS);
let failed = 0;
for (const name of selected) {
  const check = CHECKS[name];
  if (!check) {
    console.error(`unknown check ${name}; one of ${Object.keys(CHECKS).join(", ")}`);
    process.exit(2);
  }
  const problems = await check();
  console.log(
    `${problems.length === 0 ? "PASS" : "FAIL"} ${name}${problems.length ? ` (${problems.length})` : ""}`,
  );
  for (const p of problems) console.log(`  ${p}`);
  if (problems.length) failed += 1;
}
process.exit(failed ? 1 : 0);
