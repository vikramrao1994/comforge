import { afterEach, expect, test } from "bun:test";
import { createWorld, type World } from "./harness.ts";

// M12: opt-in context modes. The default JSON is the contract and is unchanged; --compact is the
// same content on one line; --summary is a bounded projection, with full detail one call away.

let world: World;
afterEach(() => world?.dispose());

test("--compact carries exactly the default JSON's content on one line", async () => {
  world = createWorld();
  const full = await world.cli(["capabilities"]);
  const compact = await world.cli(["capabilities", "--compact"]);
  expect(compact.out.trim().split("\n")).toHaveLength(1);
  expect(JSON.parse(compact.out)).toEqual(full.json);
  expect(compact.out.length).toBeLessThan(full.out.length);
});

test("--summary keeps scalars, counts arrays and never invents fields", async () => {
  world = createWorld();
  const full = (await world.cli(["capabilities"])).json;
  const summary = (await world.cli(["capabilities", "--summary"])).json;
  expect(summary.summary).toBe(true);
  expect(summary.version).toBe(full.version);
  expect(summary.commands).toMatchObject({
    count: full.commands.length,
    first: { name: full.commands[0].name },
  });
  for (const key of Object.keys(summary)) if (key !== "summary") expect(key in full).toBe(true);
});

test("errors keep their full shape in every mode", async () => {
  world = createWorld();
  const plain = await world.cli(["status", "NOPE-1"]);
  const summarized = await world.cli(["status", "NOPE-1", "--summary", "--compact"]);
  expect(summarized.code).toBe(plain.code);
  expect(summarized.json).toEqual(plain.json);
});
