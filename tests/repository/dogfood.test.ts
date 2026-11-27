import { expect, test } from "bun:test";
import { dogfood } from "../../tooling/dogfood";

// The published harness (harness/) against the fake GitHub: governed publication with a lost
// answer, recovery, delivery, an advisory review and its read-back. Synthetic, never live.
test("the published harness governs a repository end to end against a synthetic GitHub", async () => {
  const r = await dogfood(process.env.COMFORGE_DOGFOOD_RUNTIME ?? "node");
  expect(r.steps.filter((s) => !s.pass)).toEqual([]);
  expect(r.harness).toMatch(/^@comforge\/cli@\d+\.\d+\.\d+$/);
}, 180_000);
