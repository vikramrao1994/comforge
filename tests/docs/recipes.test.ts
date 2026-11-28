import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { listRecipes, parseRecipe, RECIPES_DIR, runRecipe } from "../../tooling/docs/recipes";

// Each recipe runs exactly as written, against the published harness and a synthetic GitHub.
describe("executable recipes", () => {
  const names = listRecipes();

  test("there are at least ten recipes, each with an executable block", () => {
    expect(names.length).toBeGreaterThanOrEqual(10);
    for (const name of names) expect(parseRecipe(name, readFileSync(path.join(RECIPES_DIR, name), "utf8")).blocks.length).toBeGreaterThan(0);
  });

  for (const name of names)
    test(name, async () => {
      const recipe = parseRecipe(name, readFileSync(path.join(RECIPES_DIR, name), "utf8"));
      const result = await runRecipe(recipe, "node");
      const failed = result.steps.filter((s) => !s.pass);
      expect(failed).toEqual([]);
      expect(result.steps.length).toBe(recipe.blocks.length);
    }, 300_000);
});
