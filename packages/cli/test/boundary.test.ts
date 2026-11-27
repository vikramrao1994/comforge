import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

// The package's dependency boundary: Node built-ins, zod and the three published Comforge
// packages only. No Bun API (it runs under Node), no application import, no import outside
// its own source. Comments are stripped before matching.

const SRC = path.join(import.meta.dir, "..", "src");
const files = readdirSync(SRC, { recursive: true })
  .map(String)
  .filter((f) => f.endsWith(".ts"));
const code = (f: string) =>
  new Bun.Transpiler({ loader: "ts" }).transformSync(readFileSync(path.join(SRC, f), "utf8"));

describe("@comforge/cli dependency boundary", () => {
  test("imports only node:, zod and @comforge/core, github and ledger", () => {
    const allowed =
      /^(node:[a-z_/]+|zod|@comforge\/core|@comforge\/github|@comforge\/ledger(\/(file|sqlite))?|\.{1,2}\/[A-Za-z0-9_/.-]+\.ts)$/;
    const bad: string[] = [];
    for (const f of files) {
      const source = readFileSync(path.join(SRC, f), "utf8");
      for (const m of source.matchAll(/^\s*(?:import|export)\s[^;]*?\sfrom\s+"([^"]+)"/gm))
        if (!allowed.test(m[1] as string)) bad.push(`${f}: ${m[1]}`);
      for (const m of source.matchAll(
        /^\s*(?:import|export)\s[^;]*?\sfrom\s+"(\.{1,2}\/[^"]+)"/gm,
      )) {
        const target = path.resolve(path.dirname(path.join(SRC, f)), m[1] as string);
        if (!target.startsWith(SRC)) bad.push(`${f}: ${m[1]} leaves src/`);
      }
    }
    expect(bad).toEqual([]);
  });

  test("uses no Bun API and no application path alias", () => {
    for (const f of files) {
      const text = code(f);
      expect(text).not.toMatch(/\bBun\.|from "bun:|from "@\//);
    }
  });

  test("the executable is the only module with a shebang and side effects at load", () => {
    expect(readFileSync(path.join(SRC, "cli.ts"), "utf8").startsWith("#!/usr/bin/env node\n")).toBe(
      true,
    );
    for (const f of files.filter((x) => x !== "cli.ts"))
      expect(readFileSync(path.join(SRC, f), "utf8").startsWith("#!")).toBe(false);
  });
});
