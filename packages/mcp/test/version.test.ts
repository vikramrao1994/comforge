import { expect, test } from "bun:test";
import pkg from "../package.json" with { type: "json" };
import { SERVER_VERSION } from "../src/tools.ts";

// serverInfo.version is a literal (a bundler cannot read package.json at runtime); this keeps it honest.
test("SERVER_VERSION equals the package version", () => {
  expect(SERVER_VERSION).toBe(pkg.version);
});
