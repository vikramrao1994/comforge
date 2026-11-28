import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import * as kernel from "@comforge/core";

// The core README, its walkthrough page (docs/reference/core.md) and llms.txt are the package's
// consumer documentation: every TypeScript block is a verbatim region of the runnable example
// consumer, every runtime export is named in the walkthrough's export reference, and every
// relative link resolves, so the documentation cannot drift from code that is executed.

const REPO = path.resolve(import.meta.dir, "..", "..");
const PACKAGE = path.join(REPO, "packages", "core");
const readme = readFileSync(path.join(PACKAGE, "README.md"), "utf8");
const llms = readFileSync(path.join(PACKAGE, "llms.txt"), "utf8");
const walkthrough = readFileSync(path.join(REPO, "docs", "reference", "core.md"), "utf8");

function region(file: string, name: string): string {
  const lines = readFileSync(path.join(REPO, file), "utf8").split("\n");
  const start = lines.findIndex((l) => l.trim() === `// #region ${name}`);
  const end = lines.findIndex((l, i) => i > start && l.trim() === `// #endregion ${name}`);
  if (start < 0 || end < 0) throw new Error(`${file} has no region ${name}`);
  const body = lines.slice(start + 1, end);
  const indent = Math.min(...body.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length));
  return body.map((l) => l.slice(indent)).join("\n");
}

const exampleBlocks = (text: string) => [
  ...text.matchAll(/<!-- example: ([^#\s]+)#([\w-]+) -->\n```ts\n([\s\S]*?)\n```/g),
];
const blocks = exampleBlocks(readme);
const walkthroughBlocks = exampleBlocks(walkthrough);

describe("core README and walkthrough", () => {
  test("every ts block of both is example-backed, and the walkthrough covers the protocols", () => {
    expect(blocks.length).toBeGreaterThanOrEqual(1);
    expect((readme.match(/```ts\n/g) ?? []).length).toBe(blocks.length);
    expect(walkthroughBlocks.length).toBeGreaterThanOrEqual(8);
    expect((walkthrough.match(/```ts\n/g) ?? []).length).toBe(walkthroughBlocks.length);
  });

  for (const [where, list] of [["README", blocks], ["walkthrough", walkthroughBlocks]] as const)
    for (const [, file, name, code] of list)
      test(`${where}: ${file}#${name} is copied verbatim`, () => {
        expect(code).toBe(region(file as string, name as string));
      });

  test("names every runtime export in the export reference", () => {
    const reference = walkthrough.slice(walkthrough.indexOf("## Export reference"));
    const missing = Object.keys(kernel).filter((name) => !reference.includes(`\`${name}\``));
    expect(missing).toEqual([]);
  });

  test("relative links resolve in the source repository", () => {
    for (const [doc, text] of [
      ["README.md", readme],
      ["llms.txt", llms],
    ] as const)
      for (const [, target] of text.matchAll(/\]\((\.{1,2}\/[^)#\s]+|[\w-]+\.md)(?:#[^)]*)?\)/g))
        expect(`${doc} → ${target}: ${existsSync(path.resolve(PACKAGE, target as string))}`).toBe(`${doc} → ${target}: true`);
  });

  test("llms.txt states it is guidance, not authorization, and keeps the trust rules", () => {
    expect(llms.startsWith("# @comforge/core\n\n> ")).toBe(true);
    for (const phrase of [
      "not a permission or authorization mechanism",
      "Do not generate, read or use signing keys",
      "A lifecycle `allow` is not an authorization",
      "do not claim it does",
    ])
      expect(llms).toContain(phrase);
  });
});
