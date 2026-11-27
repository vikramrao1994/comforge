/**
 * `bun run release:pack [--out DIR]` — builds the consumer distribution of
 * packages/core as a local tarball.
 *
 * The source package exports TypeScript source, which Bun and this repository's
 * bundler load directly. Node refuses to strip types under node_modules
 * (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING), and a TypeScript consumer without
 * `allowImportingTsExtensions` cannot type-check the source's `.ts` imports, so an
 * installed copy needs JavaScript and declarations. This compiles `src/` with the
 * repository's TypeScript into `dist/` (`.js` + `.d.ts`, imports rewritten to `.js`),
 * writes a manifest whose exports point at `dist/`, and packs it with `npm pack`.
 *
 * The source package is not modified, and nothing is published: the manifest keeps
 * `private: true`, which makes `npm publish` refuse it.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const REPO = path.resolve(import.meta.dir, "..", "..");
export const PACKAGE_DIR = path.join(REPO, "packages", "core");
/** Shipped beside `dist/`; both are documentation, never executable configuration. */
export const DOCUMENTS = ["README.md", "llms.txt"] as const;

export type Manifest = Record<string, unknown> & { exports: Record<string, string> };

/** The distributable manifest: each `./src/x.ts` export becomes `dist/x.d.ts` + `dist/x.js`. */
export function distributionManifest(source: Manifest): Record<string, unknown> {
  const exports: Record<string, unknown> = {};
  for (const [key, target] of Object.entries(source.exports)) {
    const match = /^\.\/src\/(.+)\.ts$/.exec(target);
    exports[key] = match
      ? { types: `./dist/${match[1]}.d.ts`, default: `./dist/${match[1]}.js` }
      : target;
  }
  // An executable maps the same way: `./src/x.ts` becomes `./dist/x.js` (its shebang is kept).
  const bin =
    source.bin && typeof source.bin === "object"
      ? Object.fromEntries(
          Object.entries(source.bin as Record<string, string>).map(([name, target]) => {
            const m = /^\.\/src\/(.+)\.ts$/.exec(target);
            return [name, m ? `./dist/${m[1]}.js` : target];
          }),
        )
      : undefined;
  return {
    ...source,
    ...(bin ? { bin } : {}),
    private: true,
    exports,
    types: "./dist/index.d.ts",
    files: ["dist", ...DOCUMENTS],
    // JavaScript output needs no type stripping; ES2022 and Ed25519 in node:crypto.
    engines: { ...(source.engines as Record<string, string> | undefined), node: ">=22" },
  };
}

export function run(cmd: string, args: string[], cwd: string) {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  if (r.status !== 0)
    throw new Error(
      `${cmd} ${args.join(" ")} failed (status ${r.status}${r.error ? `, ${r.error.message}` : ""}): ${(r.stderr || r.stdout).slice(0, 2000)}`,
    );
  return r.stdout.trim();
}

/** The repository TypeScript compiler's version: release provenance names the toolchain. */
export function compilerVersion(): string {
  return (
    JSON.parse(
      readFileSync(path.join(REPO, "node_modules", "typescript", "package.json"), "utf8"),
    ) as { version: string }
  ).version;
}

/**
 * Compiles a factory-core source tree (`packageDir` holds package.json, tsconfig.json and
 * src/) into `distDir` with the repository's TypeScript. `packageDir` must sit inside this
 * repository, so the compiler finds `zod` and `@types/node` in its node_modules.
 */
export function compileDistribution(packageDir: string, distDir: string): void {
  run(
    path.join(REPO, "node_modules", ".bin", "tsc"),
    [
      "-p",
      path.join(packageDir, "tsconfig.json"),
      "--noEmit",
      "false",
      "--declaration",
      "--rewriteRelativeImportExtensions",
      "--rootDir",
      path.join(packageDir, "src"),
      "--outDir",
      distDir,
    ],
    REPO,
  );
}

/** Packs a staged distribution directory (manifest + dist + documents) with `npm pack`. */
export function packStaged(
  staging: string,
  outDir: string,
): { tarball: string; sha256: string; integrity: string; files: string[] } {
  mkdirSync(outDir, { recursive: true });
  // A private cache and log directory per pack: concurrent npm processes started in the same
  // millisecond share one debug-log file and prune each other's logs, and a pack under the
  // parallel test runner then exited 243 with no output.
  const npmState = mkdtempSync(path.join(tmpdir(), "factory-core-npm-"));
  let name: string;
  try {
    name = run(
      "npm",
      [
        "pack",
        staging,
        "--pack-destination",
        outDir,
        "--offline",
        "--loglevel=error",
        "--cache",
        path.join(npmState, "cache"),
        "--logs-dir",
        path.join(npmState, "logs"),
      ],
      REPO,
    )
      .split("\n")
      .at(-1) as string;
  } finally {
    rmSync(npmState, { recursive: true, force: true });
  }
  const tarball = path.join(outDir, name);
  const files = run("tar", ["-tzf", tarball], REPO).split("\n").filter(Boolean).sort();
  const bytes = readFileSync(tarball);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  return { tarball, sha256, integrity, files };
}

export function packDistribution(
  outDir: string,
  packageDir: string = PACKAGE_DIR,
): {
  tarball: string;
  sha256: string;
  files: string[];
} {
  const staging = mkdtempSync(path.join(tmpdir(), "factory-core-dist-"));
  try {
    compileDistribution(packageDir, path.join(staging, "dist"));
    const source = JSON.parse(
      readFileSync(path.join(packageDir, "package.json"), "utf8"),
    ) as Manifest;
    writeFileSync(
      path.join(staging, "package.json"),
      `${JSON.stringify(distributionManifest(source), null, 2)}\n`,
    );
    for (const doc of DOCUMENTS) copyFileSync(path.join(packageDir, doc), path.join(staging, doc));
    const { tarball, sha256, files } = packStaged(staging, outDir);
    return { tarball, sha256, files };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const outIndex = process.argv.indexOf("--out");
  const outDir = path.resolve(outIndex > 0 ? (process.argv[outIndex + 1] ?? ".") : ".");
  const pkgIndex = process.argv.indexOf("--package");
  const { profileOf } = await import("./packages");
  const packageDir = path.join(
    REPO,
    profileOf(pkgIndex > 0 ? process.argv[pkgIndex + 1] : "@comforge/core").dir,
  );
  process.stdout.write(`${JSON.stringify(packDistribution(outDir, packageDir), null, 2)}\n`);
}
