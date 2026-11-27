import { describe, expect, test } from "bun:test";
import { checkBoundaries, checkDocs, checkHarness, checkRouting, checkSkills, skillNames } from "../../tooling/checks";

// The repository's own guardrails: agent context, skills, docs and package boundaries are
// enforced by these checks (also `bun run validate` and CI), not by prompt instructions alone.
describe("repository validators", () => {
  test("context routing: schema, unique triggers, existing files, skills and docs, and the evaluation set", () => {
    expect(checkRouting()).toEqual([]);
  });
  test("skills: frontmatter, required sections, an executable example, listed in the index", () => {
    expect(checkSkills()).toEqual([]);
  });
  test("there are consumer and contributor skills", () => {
    const names = skillNames();
    expect(names.filter((n) => n.startsWith("comforge-")).length).toBeGreaterThanOrEqual(9);
    expect(names.filter((n) => n.startsWith("contributor-")).length).toBeGreaterThanOrEqual(8);
  });
  test("documentation: every relative link resolves and every page is indexed", () => {
    expect(checkDocs()).toEqual([]);
  });
  test("package boundaries: core is pure, siblings by declared name, no repository-internal imports", () => {
    expect(checkBoundaries()).toEqual([]);
  });
  test("the harness is an exact published release, isolated from the workspace candidates", () => {
    expect(checkHarness()).toEqual([]);
  });
});
