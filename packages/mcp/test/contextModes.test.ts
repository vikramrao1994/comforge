import { afterEach, expect, test } from "bun:test";
import { RESULT_SCHEMA } from "../src/contracts.ts";
import { connect, createWorld, principal, type World } from "./harness.ts";

// M12: opt-in context modes. compactDiscovery leaves output schemas out of discovery;
// textContent "summary" stops a structured result being sent to the model twice. Defaults
// keep the full, interoperable shape.

let world: World;
afterEach(() => world?.dispose());

const open = (extra: Record<string, unknown> = {}) =>
  connect({
    repositories: [world.binding],
    host: world.host(),
    principal: principal(["read-only"]),
    transport: "stdio",
    ...extra,
  });

test("default: text carries the full result, identical to structuredContent", async () => {
  world = createWorld();
  const s = await open();
  const r = await s.call("comforge_capabilities");
  expect(r.body).toEqual(r.structured);
  const tools = (await s.client.listTools()).tools;
  expect(tools.every((t) => t.outputSchema !== undefined)).toBe(true);
  await s.close();
});

test("summary text: one line pointing at the structured result, which is unchanged", async () => {
  world = createWorld();
  const full = await open();
  const reference = await full.call("comforge_capabilities");
  await full.close();
  const s = await open({ textContent: "summary", compactDiscovery: true });
  const r = await s.call("comforge_capabilities");
  expect(r.text.split("\n")).toHaveLength(1);
  expect(r.text).toContain(RESULT_SCHEMA);
  expect(r.text.length).toBeLessThan(reference.text.length / 4);
  expect(r.structured).toEqual(reference.structured);
  expect((await s.client.listTools()).tools.every((t) => t.outputSchema === undefined)).toBe(true);
  // An error has no structured content, so it keeps its full JSON in text.
  const refused = await s.call("comforge_status", { repository: "nope" });
  expect(refused.isError).toBe(true);
  expect(refused.body.schema).toBe("comforge-mcp-error/v1");
  await s.close();
});
