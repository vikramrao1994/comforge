import { expect, test } from "bun:test";
import { runExample } from "../../examples/core-consumer/src/main.ts";

// The independent example consumer (ENGINEERING-FACTORY-DX-001), run against the
// installed @comforge/core release. The portability pilot runs the same files under
// Node and Bun against the distribution tarball built from packages/core.
test("every example use case passes", () => {
  const { checks } = runExample();
  expect(checks.length).toBe(18);
  expect(checks.filter((c) => !c.pass).map((c) => c.id)).toEqual([]);
});

test("the example imports only the package, Node built-ins and its own files", async () => {
  const { readdirSync, readFileSync } = await import("node:fs");
  const dir = new URL("../../examples/core-consumer/src/", import.meta.url);
  for (const file of readdirSync(dir)) {
    const source = readFileSync(new URL(file, dir), "utf8");
    for (const [, specifier] of source.matchAll(/from "([^"]+)"/g))
      expect(/^(@comforge\/core|node:[a-z/]+|\.\/[\w]+\.ts)$/.test(specifier as string) ? "ok" : specifier).toBe("ok");
    expect(/portfolio/i.test(source)).toBe(false);
  }
});
