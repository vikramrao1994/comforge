import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { RULESET_FILE, type Ruleset, rulesetGaps } from "../../tooling/verifyRuleset";

const ROOT = path.resolve(import.meta.dir, "../..");
const expected = JSON.parse(readFileSync(path.join(ROOT, RULESET_FILE), "utf8")) as Ruleset;
const ci = readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf8");

test("the declared ruleset satisfies itself, and the live one today (deletion and force-push only) does not", () => {
  expect(rulesetGaps(expected, expected)).toEqual([]);
  const today: Ruleset = {
    name: "protect-main",
    target: "branch",
    enforcement: "active",
    conditions: { ref_name: { include: ["refs/heads/main"], exclude: [] } },
    bypass_actors: [],
    rules: [{ type: "deletion" }, { type: "non_fast_forward" }],
  };
  expect(rulesetGaps(expected, today)).toEqual(["missing rule pull_request", "missing rule required_status_checks"]);
  expect(rulesetGaps(expected, { ...expected, enforcement: "evaluate", bypass_actors: [{}] })).toEqual([
    "enforcement is evaluate, not active",
    "1 bypass actor(s)",
  ]);
});

test("every required check is a job CI actually runs", () => {
  const checks = (
    expected.rules.find((r) => r.type === "required_status_checks")?.parameters?.required_status_checks as {
      context: string;
    }[]
  ).map((c) => c.context);
  const names = [...ci.matchAll(/^\s{4}name: (.+)$/gm)].map((m) => (m[1] as string).trim());
  const matrix = names.find((n) => n.includes("${{ matrix.os }}")) as string;
  const expanded = names
    .filter((n) => n !== matrix)
    .concat(
      ["ubuntu-latest", "macos-latest"].flatMap((os) =>
        ["22", "24", "26"].map((node) => matrix.replace("${{ matrix.os }}", os).replace("${{ matrix.node }}", node)),
      ),
    );
  expect(checks.sort()).toEqual(expanded.sort());
});
