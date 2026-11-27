import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { candidateClosure, candidateDependencies, ensure, isCurrent } from "../../tooling/release/candidates";
import { PACKAGES, type PackageName } from "../../tooling/release/packages";

// COMFORGE-MCP-001 M14: unreleased sibling candidates are wired only into the package that
// pins them, and nothing the application builds can resolve one.

const REPO = path.resolve(import.meta.dir, "../..");
const names = Object.keys(PACKAGES) as PackageName[];
const consumers = names.filter((n) => candidateDependencies(n).length > 0);

describe("candidate wiring", () => {
  test("closures are dependency-ordered and never include the consumer itself", () => {
    for (const n of names) {
      const closure = candidateClosure(n);
      expect(closure).not.toContain(n);
      for (const [i, c] of closure.entries()) for (const dep of candidateClosure(c)) expect(closure.indexOf(dep)).toBeLessThan(i);
    }
  });

  test("ensure leaves every consumer current", () => {
    for (const n of consumers) ensure(n);
    for (const n of names) expect(isCurrent(n)).toBe(true);
  });
});
