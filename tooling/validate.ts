/**
 * `bun run validate [routing|skills|docs|boundaries|harness|disclosure ...]` — the repository
 * validators (all of them without arguments). Exit 0 only when every selected check is clean.
 */
import { checkBoundaries, checkDocs, checkHarness, checkRouting, checkSkills } from "./checks";
import { scan } from "./disclosure";

const CHECKS: Record<string, () => string[]> = {
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
};
const selected = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(CHECKS);
let failed = 0;
for (const name of selected) {
  const check = CHECKS[name];
  if (!check) {
    console.error(`unknown check ${name}; one of ${Object.keys(CHECKS).join(", ")}`);
    process.exit(2);
  }
  const problems = check();
  console.log(
    `${problems.length === 0 ? "PASS" : "FAIL"} ${name}${problems.length ? ` (${problems.length})` : ""}`,
  );
  for (const p of problems) console.log(`  ${p}`);
  if (problems.length) failed += 1;
}
process.exit(failed ? 1 : 0);
