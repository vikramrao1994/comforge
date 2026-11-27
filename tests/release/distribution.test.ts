import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { DOCUMENTS, distributionManifest, PACKAGE_DIR } from "../../tooling/release/pack";

// The consumer distribution manifest (ENGINEERING-FACTORY-DX-001): every source export
// maps to compiled JavaScript plus declarations, nothing but dist and the documents
// ship, and the package stays private so it cannot be published by accident.
const source = JSON.parse(readFileSync(path.join(PACKAGE_DIR, "package.json"), "utf8"));
const dist = distributionManifest(source) as Record<string, unknown> & {
  exports: Record<string, unknown>;
};

test("every source export points at dist JavaScript and declarations", () => {
  expect(Object.keys(dist.exports)).toEqual(Object.keys(source.exports));
  expect(dist.exports["."]).toEqual({ types: "./dist/index.d.ts", default: "./dist/index.js" });
  expect(dist.exports["./lifecycle"]).toEqual({
    types: "./dist/lifecycle.d.ts",
    default: "./dist/lifecycle.js",
  });
  expect(dist.exports["./package.json"]).toBe("./package.json");
});

test("ships only dist and documentation, keeps the dependency set, and stays private", () => {
  expect(dist.files).toEqual(["dist", ...DOCUMENTS]);
  expect(dist.private).toBe(true);
  expect(dist.version).toBe(source.version);
  expect(dist.dependencies).toEqual(source.dependencies);
  expect(dist.types).toBe("./dist/index.d.ts");
});

test("the source manifest itself is unchanged: source exports for Bun and the bundler", () => {
  expect(source.exports["."]).toBe("./src/index.ts");
  expect(source.files).toBeUndefined();
});
