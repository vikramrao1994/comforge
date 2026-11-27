import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// The adapter's dependency boundary (COMFORGE-GITHUB-001). It talks to GitHub only through
// the injected transport, holds no credential of its own, and never reaches into the
// application: it may import its own files, zod, and @comforge/core *types* (governance
// stays in core; the adapter needs no core code at runtime). No environment, filesystem,
// clock, randomness, process spawning or runtime-specific API.

const PACKAGE_ROOT = resolve(import.meta.dir, "..");
const SOURCE_ROOT = join(PACKAGE_ROOT, "src");
// Both core lines: 0.2.0 adds command scopes, and a consumer pinning it must share one core copy.
const ALLOWED_PACKAGES: Record<string, string> = {
  "@comforge/core": "^0.1.2 || ^0.2.0",
  zod: "^4.6.6",
};
const TYPE_ONLY_PACKAGES = new Set(["@comforge/core"]);
// The advisory-review reader applies core's own pure review predicates (staleness, provenance)
// instead of restating them, so it alone may import @comforge/core at runtime.
const CORE_RUNTIME_MODULES = new Set(["src/reviews.ts"]);
const FORBIDDEN_SOURCE = [
  /\bprocess\./,
  /\bBun\./,
  /\bDeno\./,
  /\bimport\.meta\b/,
  /\brequire\(/,
  /\bimport\(/,
  // An ambient clock; converting a time the consumer's injected clock supplied is fine.
  /\bDate\.now\(|\bnew Date\(\s*\)/,
  /\bMath\.random\(/,
  /\bchild_process\b|\bspawn(?:Sync)?\(/,
  /\bgh\s+api\b/,
];
// A write method may be named only in the writer's request module (COMFORGE-GITHUB-003), and never
// DELETE or PUT: the writer creates and edits, it never removes, merges or replaces.
const WRITE_METHOD = /["'](?:POST|PUT|PATCH|DELETE)["']/;
const WRITE_MODULE = "src/request.ts";

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

describe("@comforge/github dependency boundary", () => {
  test("has source files to check", () => expect(files.length).toBeGreaterThan(0));

  for (const file of files) {
    const name = relative(PACKAGE_ROOT, file);
    const source = readFileSync(file, "utf8");

    test(`${name} imports only package files, zod and @comforge/core types`, () => {
      // Runtime imports survive transpilation; type-only imports are erased.
      for (const specifier of transpiler.scanImports(source).map((entry) => entry.path)) {
        if (specifier.startsWith(".")) {
          expect(specifier).toMatch(/\.ts$/);
          expect(relative(SOURCE_ROOT, resolve(dirname(file), specifier)).startsWith("..")).toBe(
            false,
          );
        } else
          expect(
            specifier in ALLOWED_PACKAGES &&
              (!TYPE_ONLY_PACKAGES.has(specifier) || CORE_RUNTIME_MODULES.has(name))
              ? specifier
              : `forbidden runtime import: ${specifier}`,
          ).toBe(specifier);
      }
      for (const match of source.matchAll(/from\s+["']([^"'.][^"']*)["']/g))
        expect(
          match[1] && match[1] in ALLOWED_PACKAGES ? match[1] : `forbidden import: ${match[1]}`,
        ).toBe(match[1] ?? "");
    });

    test(`${name} uses no environment, filesystem, clock, process or write method`, () => {
      const code = transpiler.transformSync(source);
      for (const pattern of FORBIDDEN_SOURCE) expect(code).not.toMatch(pattern);
      if (name !== WRITE_MODULE) expect(code).not.toMatch(WRITE_METHOD);
      else expect(code).not.toMatch(/["'](?:PUT|DELETE)["']/);
    });
  }

  test("the manifest declares only the allowed dependencies and stays private", () => {
    const manifest = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")) as Record<
      string,
      unknown
    >;
    expect(manifest.name).toBe("@comforge/github");
    expect(manifest.private).toBe(true);
    // The release planner (comforge:release:version-pr) is the only writer of this field.
    expect(manifest.version).toMatch(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
    expect(manifest.dependencies).toEqual(ALLOWED_PACKAGES);
    for (const field of ["peerDependencies", "optionalDependencies", "devDependencies"])
      expect(manifest[field]).toBeUndefined();
  });

  test("the package type-checks on its own under Node module resolution and erasable syntax only", () => {
    const tsc = join(PACKAGE_ROOT, "..", "..", "node_modules", ".bin", "tsc");
    const result = spawnSync(tsc, ["-p", join(PACKAGE_ROOT, "tsconfig.json")], {
      encoding: "utf8",
    });
    expect(`${result.stdout}${result.stderr}`.trim()).toBe("");
    expect(result.status).toBe(0);
  }, 60_000);

  test("the source loads in plain Node with type stripping", () => {
    const probe = spawnSync("node", ["-p", "process.versions.node"], { encoding: "utf8" });
    const [major = 0, minor = 0] = probe.stdout.trim().split(".").map(Number);
    if (!(major > 23 || (major === 23 && minor >= 6) || (major === 22 && minor >= 18))) return;
    const script = `
      const m = await import(${JSON.stringify(pathToFileURL(join(SOURCE_ROOT, "index.ts")).href)});
      const t = m.createFetchTransport({ token: "x", fetchImpl: async () => new Response(JSON.stringify({ total_count: 0, check_runs: [] })) });
      const e = m.createGitHubEvidence({ transport: t, repository: { owner: "acme", name: "widgets" } });
      const c = await e.getChecks("${"a".repeat(40)}", ["Validate"]);
      process.stdout.write(JSON.stringify({ ok: c.ok, required: c.required }));
    `;
    const r = spawnSync("node", ["--input-type=module", "-e", script], {
      encoding: "utf8",
      cwd: PACKAGE_ROOT,
      env: { NODE_ENV: "test", PATH: process.env.PATH ?? "" },
    });
    expect(r.stderr).toBe("");
    expect(JSON.parse(r.stdout)).toEqual({
      ok: false,
      required: [{ name: "Validate", conclusion: null, satisfied: false }],
    });
  }, 30_000);
});
