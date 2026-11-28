import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// The server's checkout-free governance calls createRemoteGovernance (first exported by
// @comforge/cli 0.6.0) with the writer's identity (0.7.0). The planner writes version fields only, never a dependent's sibling pin, so
// the version PR that moves this package past 0.3.0 must also move its @comforge/cli dependency;
// until it does, this fails and the candidate cannot be released against a CLI without it.

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
  dependencies: Record<string, string>;
};
const parts = (v: string) =>
  v
    .replace(/^[\^~]/, "")
    .split(".")
    .map(Number) as [number, number, number];
const atLeast = (v: string, floor: string) => {
  const [a, b, c] = parts(v);
  const [x, y, z] = parts(floor);
  return a !== x ? a > x : b !== y ? b > y : c >= z;
};

test("each release depends on an @comforge/cli with the governance API it calls", () => {
  const cli = manifest.dependencies["@comforge/cli"] as string;
  if (atLeast(manifest.version, "0.4.1")) expect(atLeast(cli, "0.7.0")).toBe(true);
  else if (atLeast(manifest.version, "0.3.1")) expect(atLeast(cli, "0.6.0")).toBe(true);
  else expect(manifest.version).toBe("0.3.0");
});
