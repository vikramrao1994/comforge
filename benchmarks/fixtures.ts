/**
 * Cost: none — writes synthetic repositories with local git only
 *
 * Deterministic fixture generators: a small TypeScript service (bun test) and a small Python
 * library (unittest). Same seed, same bytes and same commit ids (commit dates are fixed). Each
 * repository starts with a passing base; each feature a task asks for is delivered as a
 * visible failing test plus a reference solution the harness uses only to validate itself.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randInt, rng, sha256 } from "./prng.ts";
import { buildChildEnv, type ChildEnv } from "./redact.ts";
import type { RepoId } from "./types.ts";

export type FeatureId = "restock" | "report" | "reorder" | "supplier";

interface Item {
  sku: string;
  qty: number;
  reorderAt: number;
}
export interface FeatureFiles {
  feature: FeatureId;
  /** Where the solution belongs and what the visible test imports. */
  sourcePath: string;
  testPath: string;
  testContent: string;
  /** Reference solution, used only by harness self-checks and tests. */
  solution: Record<string, string>;
  /** A test the task's reviewer asks for (T2); run by the success check, never shown. */
  hiddenTestPath?: string;
  hiddenTestContent?: string;
  /** The reference solution after the reviewer's requested change (T2 only). */
  revisedSolution?: Record<string, string>;
  /** The deliberately incomplete implementation that sits on the T2 pull request's branch. */
  prBranchSolution?: Record<string, string>;
  functionName: string;
}

export interface Fixture {
  repo: RepoId;
  language: "typescript" | "python";
  seed: string;
  testCommand: string[];
  files: Record<string, string>;
}

const WORDS = ["bolt", "gear", "valve", "cable", "relay", "panel", "sensor", "clamp", "spring"];
const SUPPLIERS = ["northwind", "contoso", "fabrikam"];

const items = (seed: string, feature: string, target: number): Item[] => {
  const next = rng(`${seed}:${feature}:items`);
  const prefix = WORDS[randInt(next, 0, WORDS.length - 1)] as string;
  const out = Array.from({ length: 5 }, (_, i) => ({
    sku: `${prefix}-${String(randInt(next, 10, 99)).padStart(2, "0")}${i}`,
    qty: randInt(next, 0, 40),
    reorderAt: randInt(next, 3, 15),
  }));
  (out[0] as Item).qty = target; // an item exactly at target is an edge case every solution must treat the same
  return out;
};
const bySku = (a: { sku: string }, b: { sku: string }) =>
  a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0;
const snake = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(snake)
    : v && typeof v === "object"
      ? Object.fromEntries(
          Object.entries(v).map(([k, x]) => [
            k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`),
            snake(x),
          ]),
        )
      : v;
const lit = (v: unknown, lang: Fixture["language"], indent = 2) =>
  JSON.stringify(lang === "python" ? snake(v) : v, null, indent);

function expected(
  feature: FeatureId,
  data: Item[],
  target: number,
  suppliers: Record<string, string>,
) {
  const plan = data
    .filter((i) => i.qty < target)
    .map((i) => ({ sku: i.sku, order: target - i.qty }))
    .sort(bySku);
  if (feature === "restock") return plan;
  if (feature === "report")
    return {
      totalQty: data.reduce((s, i) => s + i.qty, 0),
      lowSkus: data
        .filter((i) => i.qty <= i.reorderAt)
        .map((i) => i.sku)
        .sort(),
    };
  if (feature === "reorder")
    return `sku,order\n${plan.map((l) => `${l.sku},${l.order}\n`).join("")}`;
  const totals: Record<string, number> = {};
  for (const i of data) {
    const s = suppliers[i.sku] ?? "unassigned";
    totals[s] = (totals[s] ?? 0) + i.qty;
  }
  return Object.fromEntries(Object.entries(totals).sort(([a], [b]) => (a < b ? -1 : 1)));
}

export function featureFiles(
  language: Fixture["language"],
  feature: FeatureId,
  seed: string,
): FeatureFiles {
  const target = 12 + randInt(rng(`${seed}:${feature}:target`), 0, 12);
  const data = items(seed, feature, target);
  const suppliers = Object.fromEntries(
    data.slice(0, 4).map((i, n) => [i.sku, SUPPLIERS[n % SUPPLIERS.length] as string]),
  );
  const want = expected(feature, data, target, suppliers);
  const plan = expected("restock", data, target, suppliers);
  const ts = language === "typescript";
  const fn = {
    restock: ts ? "restockPlan" : "restock_plan",
    report: ts ? "stockReport" : "stock_report",
    reorder: ts ? "reorderCsv" : "reorder_csv",
    supplier: ts ? "supplierTotals" : "supplier_totals",
  }[feature];
  const mod = { restock: "restock", report: "report", reorder: "reorder", supplier: "supplier" }[
    feature
  ];
  const args = {
    restock: `ITEMS, ${target}`,
    report: "ITEMS",
    reorder: "PLAN",
    supplier: "ITEMS, SUPPLIERS",
  }[feature];
  const emptyCall = {
    restock: `${fn}([], ${target})`,
    report: `${fn}([])`,
    reorder: `${fn}([])`,
    supplier: `${fn}([], {})`,
  }[feature];
  const emptyWant = {
    restock: "[]",
    report: ts ? "{ totalQty: 0, lowSkus: [] }" : '{"total_qty": 0, "low_skus": []}',
    reorder: '"sku,order\\n"',
    supplier: ts ? "{}" : "{}",
  }[feature];
  const dataLit = `ITEMS = ${lit(data, language)}`;
  const extra =
    feature === "reorder"
      ? `PLAN = ${lit(plan, language)}`
      : feature === "supplier"
        ? `SUPPLIERS = ${lit(suppliers, language)}`
        : "";
  const wantLit = typeof want === "string" ? JSON.stringify(want) : lit(want, language);

  let testPath: string;
  let testContent: string;
  let sourcePath: string;
  let solution: Record<string, string>;
  if (ts) {
    sourcePath = `src/${mod}.ts`;
    testPath = `test/${mod}.test.ts`;
    const decl = (n: string, body: string) =>
      body ? `const ${n} = ${body.replace(/^[A-Z]+ = /, "")};\n` : "";
    testContent = `import { expect, test } from "bun:test";
import { ${fn} } from "../src/${mod}";

${decl("ITEMS", dataLit)}${decl("PLAN", feature === "reorder" ? extra : "")}${decl("SUPPLIERS", feature === "supplier" ? extra : "")}
test("${fn} matches the specified result", () => {
  expect(${fn}(${args})).toEqual(${wantLit});
});

test("${fn} handles an empty input", () => {
  expect(${emptyCall}).toEqual(${emptyWant});
});
`;
    const body = {
      restock: `import type { Item } from "./inventory";

export interface RestockLine {
  sku: string;
  order: number;
}

export function restockPlan(items: Item[], target: number): RestockLine[] {
  return items
    .filter((i) => i.qty < target)
    .map((i) => ({ sku: i.sku, order: target - i.qty }))
    .sort((a, b) => (a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0));
}
`,
      report: `import type { Item } from "./inventory";

export function stockReport(items: Item[]): { totalQty: number; lowSkus: string[] } {
  return {
    totalQty: items.reduce((s, i) => s + i.qty, 0),
    lowSkus: items.filter((i) => i.qty <= i.reorderAt).map((i) => i.sku).sort(),
  };
}
`,
      reorder: `export function reorderCsv(plan: { sku: string; order: number }[]): string {
  return \`sku,order\\n\${plan.map((l) => \`\${l.sku},\${l.order}\\n\`).join("")}\`;
}
`,
      supplier: `import type { Item } from "./inventory";

export function supplierTotals(items: Item[], supplierBySku: Record<string, string>): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const i of items) {
    const s = supplierBySku[i.sku] ?? "unassigned";
    totals[s] = (totals[s] ?? 0) + i.qty;
  }
  return Object.fromEntries(Object.entries(totals).sort(([a], [b]) => (a < b ? -1 : 1)));
}
`,
    }[feature];
    solution = { [sourcePath]: body };
  } else {
    sourcePath = `inventory/${mod}.py`;
    testPath = `tests/test_${mod}.py`;
    const decl = (s: string) => (s ? `${s}\n` : "");
    testContent = `import unittest

from inventory.${mod} import ${fn}

${dataLit}
${decl(extra)}

class ${fn
      .split("_")
      .map((w) => w[0]?.toUpperCase() + w.slice(1))
      .join("")}Test(unittest.TestCase):
    def test_matches_the_specified_result(self):
        self.assertEqual(${fn}(${args}), ${wantLit})

    def test_handles_an_empty_input(self):
        self.assertEqual(${emptyCall}, ${emptyWant})


if __name__ == "__main__":
    unittest.main()
`;
    const body = {
      restock: `def restock_plan(items, target):
    lines = [{"sku": i["sku"], "order": target - i["qty"]} for i in items if i["qty"] < target]
    return sorted(lines, key=lambda line: line["sku"])
`,
      report: `def stock_report(items):
    return {
        "total_qty": sum(i["qty"] for i in items),
        "low_skus": sorted(i["sku"] for i in items if i["qty"] <= i["reorder_at"]),
    }
`,
      reorder: `def reorder_csv(plan):
    return "sku,order\\n" + "".join(f"{line['sku']},{line['order']}\\n" for line in plan)
`,
      supplier: `def supplier_totals(items, supplier_by_sku):
    totals = {}
    for i in items:
        supplier = supplier_by_sku.get(i["sku"], "unassigned")
        totals[supplier] = totals.get(supplier, 0) + i["qty"]
    return dict(sorted(totals.items()))
`,
    }[feature];
    solution = { [sourcePath]: body };
  }

  const out: FeatureFiles = {
    feature,
    sourcePath,
    testPath,
    testContent,
    solution,
    functionName: fn,
  };
  if (feature === "restock") {
    // T2: the branch ships a working solution; the reviewer then asks for negative-quantity validation.
    out.prBranchSolution = solution;
    if (ts) {
      out.hiddenTestPath = "test/restock.review.test.ts";
      out.hiddenTestContent = `import { expect, test } from "bun:test";
import { restockPlan } from "../src/restock";

test("a negative quantity is data corruption and is refused", () => {
  expect(() => restockPlan([{ sku: "x-1", qty: -1, reorderAt: 3 }], 10)).toThrow(RangeError);
});
`;
      out.revisedSolution = {
        [sourcePath]: (solution[sourcePath] as string).replace(
          "  return items\n",
          '  if (items.some((i) => i.qty < 0)) throw new RangeError("negative quantity");\n  return items\n',
        ),
      };
    } else {
      out.hiddenTestPath = "tests/test_restock_review.py";
      out.hiddenTestContent = `import unittest

from inventory.restock import restock_plan


class NegativeQuantityTest(unittest.TestCase):
    def test_negative_quantity_is_refused(self):
        with self.assertRaises(ValueError):
            restock_plan([{"sku": "x-1", "qty": -1, "reorder_at": 3}], 10)


if __name__ == "__main__":
    unittest.main()
`;
      out.revisedSolution = {
        [sourcePath]: (solution[sourcePath] as string).replace(
          "    lines =",
          '    if any(i["qty"] < 0 for i in items):\n        raise ValueError("negative quantity")\n    lines =',
        ),
      };
    }
  }
  return out;
}

export function buildFixture(repo: RepoId, seed: string): Fixture {
  const ts = repo === "ts-service";
  const next = rng(`${seed}:${repo}:base`);
  const tests = [randInt(next, 2, 9), randInt(next, 10, 99)];
  const sample = [
    { sku: "base-01", qty: tests[0] as number, reorderAt: 3 },
    { sku: "base-02", qty: tests[1] as number, reorderAt: 5 },
  ];
  const total = sample.reduce((s, i) => s + i.qty, 0);
  const files: Record<string, string> = ts
    ? {
        "README.md":
          "# inventory service\n\nSynthetic fixture for the Comforge benchmark. Run `bun test`.\n",
        "package.json": `${JSON.stringify({ name: "fixture-ts-service", private: true, type: "module", scripts: { test: "bun test" } }, null, 2)}\n`,
        ".gitignore": "node_modules\n",
        "src/inventory.ts": `export interface Item {
  sku: string;
  qty: number;
  reorderAt: number;
}

export function totalQuantity(items: Item[]): number {
  return items.reduce((sum, i) => sum + i.qty, 0);
}
`,
        "test/inventory.test.ts": `import { expect, test } from "bun:test";
import { totalQuantity } from "../src/inventory";

test("totalQuantity sums the quantities", () => {
  expect(totalQuantity(${JSON.stringify(sample)})).toBe(${total});
});
`,
        "CONTRIBUTING.md":
          "Keep each module small, export one function per feature module, and do not edit existing tests.\n",
      }
    : {
        "README.md":
          "# inventory library\n\nSynthetic fixture for the Comforge benchmark. Run `python3 -m unittest discover -s tests`.\n",
        "pyproject.toml": '[project]\nname = "fixture-py-library"\nversion = "0.0.0"\n',
        ".gitignore": "__pycache__\n*.pyc\n",
        "inventory/__init__.py": "",
        "inventory/core.py": `def total_quantity(items):
    return sum(i["qty"] for i in items)
`,
        "tests/test_core.py": `import unittest

from inventory.core import total_quantity


class TotalQuantityTest(unittest.TestCase):
    def test_sums_the_quantities(self):
        items = ${JSON.stringify(snake(sample))}
        self.assertEqual(total_quantity(items), ${total})


if __name__ == "__main__":
    unittest.main()
`,
        "CONTRIBUTING.md":
          "Keep each module small, one function per feature module, and do not edit existing tests.\n",
      };
  return {
    repo,
    language: ts ? "typescript" : "python",
    seed,
    testCommand: ts ? ["bun", "test"] : ["python3", "-m", "unittest", "discover", "-s", "tests"],
    files,
  };
}

/** Digest of the fixture's file tree (path-sorted), independent of git. */
export const fixtureDigest = (f: Fixture) =>
  sha256(
    Object.keys(f.files)
      .sort()
      .map((p) => `${p}\0${sha256(f.files[p] as string)}`)
      .join("\n"),
  );

const FIXED_DATE = "2026-01-01T00:00:00+0000";

export function git(cwd: string, env: ChildEnv, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd, env, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

export function writeFiles(dir: string, files: Record<string, string>) {
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
    writeFileSync(path.join(dir, p), c);
  }
}

/** Commits with a fixed date so identical inputs give identical commit ids. */
export function commitAll(dir: string, env: ChildEnv, message: string, dayOffset = 0) {
  const date = new Date(Date.parse(FIXED_DATE) + dayOffset * 86_400_000).toISOString();
  const e = { ...env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
  git(dir, e, "add", "-A");
  git(dir, e, "commit", "--quiet", "-m", message);
  return git(dir, e, "rev-parse", "HEAD");
}

/** Materializes the fixture as a three-commit repository on `main` and returns its head. */
export function materialize(fixture: Fixture, dir: string, home: string) {
  mkdirSync(path.join(home, "tmp"), { recursive: true });
  writeFileSync(
    path.join(home, "gitconfig"),
    "[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n[advice]\n\tdetachedHead = false\n",
  );
  const env = buildChildEnv({ home });
  mkdirSync(dir, { recursive: true });
  git(dir, env, "init", "--quiet");
  const skeleton = ["README.md", "package.json", "pyproject.toml", ".gitignore"];
  const paths = Object.keys(fixture.files);
  const first = Object.fromEntries(
    paths.filter((p) => skeleton.includes(p)).map((p) => [p, fixture.files[p] as string]),
  );
  const second = Object.fromEntries(
    paths
      .filter((p) => !skeleton.includes(p) && p !== "CONTRIBUTING.md")
      .map((p) => [p, fixture.files[p] as string]),
  );
  writeFiles(dir, first);
  commitAll(dir, env, "chore: project skeleton", 0);
  writeFiles(dir, second);
  commitAll(dir, env, "feat: inventory totals", 1);
  writeFiles(dir, { "CONTRIBUTING.md": fixture.files["CONTRIBUTING.md"] as string });
  const head = commitAll(dir, env, "docs: contributing notes", 2);
  return { head, env };
}
