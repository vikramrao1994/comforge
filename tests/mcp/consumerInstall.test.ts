import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, lstatSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { packCandidates } from "../../tooling/release/candidates";
import { packDistribution } from "../../tooling/release/pack";

// @comforge/mcp as a consumer installs it. Its distribution tarball goes
// into a copy of the independent example; every dependency (the published @comforge
// packages, the MCP SDK and theirs) resolves from the npm registry at the exact versions the
// manifest names, as it would for any consumer (`--prefer-offline` reuses npm's cache). The
// example then runs as its own process under each runtime in COMFORGE_TEST_RUNTIMES (default
// node,bun). No GitHub, no credential.

const REPO = path.resolve(import.meta.dir, "../..");
const RUNTIMES = (process.env.COMFORGE_TEST_RUNTIMES ?? "node,bun").split(",").filter(Boolean);
let work: string;
let consumer: string;
let packed: { tarball: string; files: string[] };

beforeAll(() => {
  work = mkdtempSync(path.join(tmpdir(), "comforge-mcp-consumer-"));
  packed = packDistribution(path.join(work, "pack"), path.join(REPO, "packages", "mcp"));
  consumer = path.join(work, "consumer");
  cpSync(path.join(REPO, "examples", "mcp-consumer"), consumer, { recursive: true });
  const manifest = JSON.parse(readFileSync(path.join(consumer, "package.json"), "utf8"));
  // The unreleased core, github and cli candidates it pins come from this repository's
  // candidate wiring (and override every exact pin on them); the rest from the registry.
  const candidates = packCandidates("@comforge/mcp", path.join(work, "pack"));
  // Every other sibling is installed from its built distribution (what a release ships), never
  // from the workspace link (TypeScript source) and never through npm's cache.
  const declared = JSON.parse(readFileSync(path.join(REPO, "packages", "mcp", "package.json"), "utf8")).dependencies as Record<string, string>;
  const released: Record<string, string> = {};
  for (const dep of Object.keys(declared).filter((d) => d.startsWith("@comforge/") && !(d in candidates)))
    released[dep] = `file:${packDistribution(path.join(work, "pack"), path.join(REPO, "packages", dep.slice("@comforge/".length))).tarball}`;
  manifest.dependencies = { ...manifest.dependencies, ...candidates, ...released, "@comforge/mcp": `file:${packed.tarball}` };
  manifest.overrides = { ...candidates, ...released };
  writeFileSync(path.join(consumer, "package.json"), JSON.stringify(manifest));
  const install = spawnSync("npm", ["install", "--prefer-offline", "--no-audit", "--no-fund", "--ignore-scripts"], { cwd: consumer, encoding: "utf8" });
  if (install.status !== 0) throw new Error(install.stderr);
}, 600_000);
afterAll(() => rmSync(work, { recursive: true, force: true }));

describe("@comforge/mcp installed from its distribution tarball", () => {
  test("the tarball ships the manifest, compiled dist with declarations, README and llms.txt only", () => {
    const files = packed.files.map((f) => f.replace(/^package\//, ""));
    expect(files.filter((f) => !f.startsWith("dist/")).sort()).toEqual(["README.md", "llms.txt", "package.json"]);
    for (const m of ["bin", "index", "server", "http", "stdio", "tools", "contracts"])
      for (const ext of [".js", ".d.ts"]) expect(files).toContain(`dist/${m}${ext}`);
    expect(files.some((f) => f.startsWith("src/") || f.startsWith("test/"))).toBe(false);
  });

  test("manifest: an executable, typed exports and exact published dependencies", () => {
    const manifest = JSON.parse(readFileSync(path.join(consumer, "node_modules", "@comforge", "mcp", "package.json"), "utf8"));
    expect(manifest.bin).toEqual({ "comforge-mcp": "./dist/bin.js" });
    expect(manifest.exports["."]).toEqual({ types: "./dist/index.d.ts", default: "./dist/index.js" });
    // Exactly the source manifest's dependencies; every Comforge sibling is an exact version.
    const source = JSON.parse(readFileSync(path.join(REPO, "packages", "mcp", "package.json"), "utf8"));
    expect(manifest.dependencies).toEqual(source.dependencies);
    for (const [name, version] of Object.entries(manifest.dependencies as Record<string, string>))
      if (name.startsWith("@comforge/")) expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(manifest.dependencies["@modelcontextprotocol/sdk"]).toBe("1.32.2");
    const bin = path.join(consumer, "node_modules", ".bin", "comforge-mcp");
    expect(lstatSync(bin).isSymbolicLink()).toBe(true);
    expect(readFileSync(bin, "utf8").startsWith("#!/usr/bin/env node\n")).toBe(true);
    expect(statSync(bin).mode & 0o111).not.toBe(0);
  });

  test("nothing private ships: no portfolio identifiers, application imports, paths or credentials", () => {
    const root = path.join(consumer, "node_modules", "@comforge", "mcp");
    const text = packed.files.map((f) => readFileSync(path.join(root, f.replace(/^package\//, "")), "utf8")).join("\n");
    for (const pattern of [
      /vikramrao1994\/portfolio/,
      /@\/lib\//,
      /engineering-gateway/,
      /\/Users\//,
      /gh[pousr]_[A-Za-z0-9]{30,}/,
      /portfolio-lifecycle|portfolio-mcp/,
      /COMFORGE-[A-Z]+-\d{3}/,
    ])
      expect(pattern.test(text)).toBe(false);
  });

  test.each(RUNTIMES)("the example (a Makefile and a TypeScript repository, stdio and HTTP) passes under %s", (runtime) => {
    const r = spawnSync(runtime, ["demo.mjs"], {
      cwd: consumer,
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" } as unknown as NodeJS.ProcessEnv,
    });
    const out = JSON.parse(r.stdout) as { runtime: string; checks: unknown[]; failed: string[] };
    expect(out.failed).toEqual([]);
    expect(out.checks).toHaveLength(13);
    expect(r.status).toBe(0);
  }, 120_000);
});
