import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

// The package's dependency boundary: Node built-ins, zod, the MCP SDK and the published
// Comforge packages only. No Bun API (it runs under Node), no application import, no import
// of another package's source, and no child process: the lifecycle runs through the
// published services, never by shelling out to the comforge executable.

const SRC = path.join(import.meta.dir, "..", "src");
const files = readdirSync(SRC, { recursive: true })
  .map(String)
  .filter((f) => f.endsWith(".ts"));
const code = (f: string) =>
  new Bun.Transpiler({ loader: "ts" }).transformSync(readFileSync(path.join(SRC, f), "utf8"));

describe("@comforge/mcp dependency boundary", () => {
  test("imports only node:, zod, the MCP SDK and @comforge/cli, core, github and the SQLite ledger", () => {
    const allowed =
      /^(node:(crypto|fs|os|path)|zod|@comforge\/(cli|core|github|ledger\/sqlite)|@modelcontextprotocol\/sdk\/(server\/(mcp|stdio|webStandardStreamableHttp)|types)\.js|\.\/[A-Za-z0-9_-]+\.ts)$/;
    const bad: string[] = [];
    for (const f of files) {
      const source = readFileSync(path.join(SRC, f), "utf8");
      for (const m of source.matchAll(/^\s*(?:import|export)\s[^;]*?\sfrom\s+"([^"]+)"/gm))
        if (!allowed.test(m[1] as string)) bad.push(`${f}: ${m[1]}`);
    }
    expect(bad).toEqual([]);
  });

  test("uses no Bun API, no application alias, and starts no process", () => {
    for (const f of files) {
      const text = code(f);
      expect(text).not.toMatch(/\bBun\.|from "bun:|from "@\/|child_process|\bspawn\(|\bexec\(/);
    }
  });

  test("the executable is the only module with a shebang", () => {
    expect(readFileSync(path.join(SRC, "bin.ts"), "utf8").startsWith("#!/usr/bin/env node\n")).toBe(
      true,
    );
    for (const f of files.filter((x) => x !== "bin.ts"))
      expect(readFileSync(path.join(SRC, f), "utf8").startsWith("#!")).toBe(false);
  });

  test("names no portfolio-specific identity", () => {
    for (const f of files)
      expect(readFileSync(path.join(SRC, f), "utf8")).not.toMatch(
        /portfolio|vikram|COMFORGE-[A-Z]+-\d/i,
      );
  });
});
