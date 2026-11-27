import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

// The kernel's dependency boundary: pure code
// that any runtime can import. It may import only its own files, the Node built-ins
// and the one npm package listed here; it reads no environment, filesystem, clock or
// Bun API, and it verifies signatures but can never create a key, sign or draw
// randomness: issuing grants and signing receipts stay with the trusted caller.

const PACKAGE_ROOT = resolve(import.meta.dir, "..");
const SOURCE_ROOT = join(PACKAGE_ROOT, "src");
const ALLOWED_BUILTINS = new Set(["node:crypto", "node:buffer"]);
// Pure schema validation; the same major version the application uses.
const ALLOWED_PACKAGES: Record<string, string> = { zod: "^4.6.6" };
// Runtime access the kernel must never have, whatever the import list says.
const FORBIDDEN_SOURCE = [
  /\bprocess\./,
  /\bBun\./,
  /\bDeno\./,
  /\bimport\.meta\b/,
  /\brequire\(/,
  /\bimport\(/,
  /\bfetch\(/,
  /\bDate\.now\(|\bnew Date\(/,
  /\bMath\.random\(/,
  /\bcreatePrivateKey\b|\bgenerateKeyPair(?:Sync)?\b|\bcreateSign\b/,
  /(?<![.\w])sign\(/,
  /\brandomBytes\b|\brandomUUID\b|\bgetRandomValues\b/,
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? sourceFiles(join(dir, entry.name))
      : entry.name.endsWith(".ts")
        ? [join(dir, entry.name)]
        : [],
  );
}

const transpiler = new Bun.Transpiler({ loader: "ts" });
const files = sourceFiles(SOURCE_ROOT);

describe("factory-core dependency boundary", () => {
  test("has source files to check", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    const name = relative(PACKAGE_ROOT, file);
    const source = readFileSync(file, "utf8");

    test(`${name} imports only package files with explicit extensions and allowed built-ins`, () => {
      const typeOnly = [
        ...source.matchAll(/(?:import|export)\s+type\s[^;]*?from\s+["']([^"']+)["']/g),
      ].map((match) => match[1] ?? "");
      const specifiers = [
        ...transpiler.scanImports(source).map((entry) => entry.path),
        ...typeOnly,
      ];
      for (const specifier of specifiers) {
        if (specifier.startsWith(".")) {
          expect(specifier).toMatch(/\.ts$/);
          const target = resolve(dirname(file), specifier);
          expect(relative(SOURCE_ROOT, target).startsWith("..")).toBe(false);
        } else {
          expect(
            ALLOWED_BUILTINS.has(specifier) || specifier in ALLOWED_PACKAGES
              ? specifier
              : `forbidden import: ${specifier}`,
          ).toBe(specifier);
        }
      }
    });

    test(`${name} uses no environment, filesystem, clock, randomness or runtime-specific API`, () => {
      const code = transpiler.transformSync(source);
      for (const pattern of FORBIDDEN_SOURCE) expect(code).not.toMatch(pattern);
    });
  }

  test("the manifest declares only the allowed dependencies and stays private", () => {
    const manifest = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")) as Record<
      string,
      unknown
    >;
    expect(manifest.private).toBe(true);
    // The release planner (comforge:release:version-pr) is the only writer of this field.
    expect(manifest.version).toMatch(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
    expect(manifest.dependencies).toEqual(ALLOWED_PACKAGES);
    for (const field of ["peerDependencies", "optionalDependencies", "devDependencies"]) {
      expect(manifest[field]).toBeUndefined();
    }
  });

  test("the package type-checks on its own under Node module resolution and erasable syntax only", () => {
    const tsc = join(PACKAGE_ROOT, "..", "..", "node_modules", ".bin", "tsc");
    const result = spawnSync(tsc, ["-p", join(PACKAGE_ROOT, "tsconfig.json")], {
      encoding: "utf8",
    });
    expect(`${result.stdout}${result.stderr}`.trim()).toBe("");
    expect(result.status).toBe(0);
  }, 60_000);
});
