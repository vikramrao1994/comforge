import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

// The package's dependency boundary: no dependencies at all, no runtime-specific API, no
// environment, and filesystem access only in the file adapter. The SQLite adapter imports no
// SQLite module; the caller passes its connection.

const ROOT = resolve(import.meta.dir, "..");
const SRC = join(ROOT, "src");
const files = readdirSync(SRC).filter((f) => f.endsWith(".ts"));
const transpiler = new Bun.Transpiler({ loader: "ts" });

const ALLOWED: Record<string, RegExp> = {
  "file.ts": /^(?:node:(?:fs|path|crypto|buffer)|\.\/contract\.ts)$/,
  default: /^\.\/(?:contract|memory)\.ts$/,
};
const FORBIDDEN = [
  /\bBun\./,
  /\bDeno\./,
  /\bimport\.meta\b/,
  /\brequire\(/,
  /\bimport\(/,
  /\bprocess\.env\b/,
  /\bchild_process\b/,
  /\bfetch\(/,
];

describe("@comforge/ledger dependency boundary", () => {
  test("has no dependencies", () => {
    const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    expect(manifest.dependencies).toBeUndefined();
    expect(manifest.peerDependencies).toBeUndefined();
  });

  test.each(files)("%s imports only what its role allows", (file) => {
    const source = readFileSync(join(SRC, file), "utf8");
    const code = transpiler.transformSync(source);
    const allowed = ALLOWED[file] ?? ALLOWED.default;
    const imports = transpiler.scanImports(source).map((i) => i.path);
    expect(imports.filter((p) => !(allowed as RegExp).test(p))).toEqual([]);
    expect(FORBIDDEN.filter((re) => re.test(code)).map(String)).toEqual([]);
  });

  test("only the file adapter reads the process (platform, user and liveness of temp-file owners)", () => {
    for (const file of files.filter((f) => f !== "file.ts"))
      expect(
        /\bprocess\./.test(transpiler.transformSync(readFileSync(join(SRC, file), "utf8"))),
      ).toBe(false);
  });
});
