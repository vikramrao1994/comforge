import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { packDistribution } from "../../tooling/release/pack";

// COMFORGE-GITHUB-001: the independent example consumer of @comforge/github, against the
// built distribution tarball as a consumer installs it: a fresh directory whose
// node_modules holds only the tarball's contents and copies of its dependencies
// (@comforge/core as installed here, zod) plus @types/node for the type check. The
// application never imports the unreleased package; this is its only consumer until the
// first npm release.

const REPO = path.resolve(import.meta.dir, "../..");
const EXAMPLE = path.join(REPO, "examples", "github-consumer");
let work: string;
let consumer: string;
let packed: { tarball: string; files: string[] };

beforeAll(() => {
  work = mkdtempSync(path.join(tmpdir(), "comforge-github-consumer-"));
  packed = packDistribution(path.join(work, "pack"), path.join(REPO, "packages", "github"));
  consumer = path.join(work, "consumer");
  cpSync(EXAMPLE, consumer, { recursive: true });
  const modules = path.join(consumer, "node_modules");
  const target = path.join(modules, "@comforge", "github");
  mkdirSync(target, { recursive: true });
  const untar = spawnSync("tar", ["-xzf", packed.tarball, "-C", target, "--strip-components=1"], { encoding: "utf8" });
  if (untar.status !== 0) throw new Error(untar.stderr);
  // @comforge/core from its built distribution (what a release ships), never the workspace link.
  const core = path.join(modules, "@comforge", "core");
  mkdirSync(core, { recursive: true });
  const coreTar = packDistribution(path.join(work, "core-pack"), path.join(REPO, "packages", "core")).tarball;
  if (spawnSync("tar", ["-xzf", coreTar, "-C", core, "--strip-components=1"]).status !== 0) throw new Error("core untar failed");
  for (const dep of ["zod", "@types/node", "undici-types"])
    cpSync(path.join(REPO, "node_modules", dep), path.join(modules, dep), { recursive: true, dereference: true });
}, 180_000);

afterAll(() => rmSync(work, { recursive: true, force: true }));

describe("@comforge/github installed from its distribution tarball", () => {
  test("the tarball ships the manifest, compiled dist with declarations, README and llms.txt only", () => {
    // The developer pack; the release candidate's tarball also carries LICENSE (release tests).
    const files = packed.files.map((f) => f.replace(/^package\//, ""));
    expect(files.filter((f) => !f.startsWith("dist/")).sort()).toEqual(["README.md", "llms.txt", "package.json"]);
    for (const module of ["errors", "evidence", "index", "operations", "request", "specification", "transport", "writer"])
      for (const ext of [".js", ".d.ts"]) expect(files).toContain(`dist/${module}${ext}`);
    expect(files.some((f) => f.startsWith("src/"))).toBe(false);
  });

  test("nothing private ships: no portfolio identifiers, application imports or credentials", () => {
    const root = path.join(consumer, "node_modules", "@comforge", "github");
    const text = packed.files
      .map((f) => f.replace(/^package\//, ""))
      .map((f) => readFileSync(path.join(root, f), "utf8"))
      .join("\n");
    for (const pattern of [/vikramrao1994\/portfolio/, /@\/lib\//, /engineering-gateway/, /process\.env/, /\/Users\//, /gh[pousr]_[A-Za-z0-9]{20,}/])
      expect(pattern.test(text.replace(/process\.env\.GITHUB_TOKEN/g, ""))).toBe(false);
    const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
    expect(manifest.exports["."]).toEqual({ types: "./dist/index.d.ts", default: "./dist/index.js" });
    expect(manifest.dependencies).toEqual({ "@comforge/core": "^0.1.2 || ^0.2.0", zod: "^4.6.6" });
  });

  test("the example type-checks against the shipped declarations", () => {
    const r = spawnSync(path.join(REPO, "node_modules", ".bin", "tsc"), ["-p", "tsconfig.json"], { cwd: consumer, encoding: "utf8" });
    expect(`${r.stdout}${r.stderr}`.trim()).toBe("");
    expect(r.status).toBe(0);
  }, 120_000);

  test.each(["node", "bun"])("every use case passes under %s", (runtime) => {
    const r = spawnSync(runtime, ["src/main.ts"], {
      cwd: consumer,
      encoding: "utf8",
      env: { NODE_ENV: "test", PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
    });
    expect(r.stderr).toBe("");
    const out = JSON.parse(r.stdout) as { runtime: string; checks: { id: string; pass: boolean }[]; failed: string[] };
    expect(out.runtime.startsWith(runtime)).toBe(true);
    expect(out.checks).toHaveLength(32);
    expect(out.failed).toEqual([]);
    expect(r.status).toBe(0);
  }, 60_000);

  test("the example imports only the packages, Node built-ins and its own files", () => {
    for (const file of ["main.ts", "fakeGitHub.ts", "writer.ts"]) {
      const source = readFileSync(path.join(EXAMPLE, "src", file), "utf8");
      for (const [, specifier] of source.matchAll(/from "([^"]+)"/g))
        expect(/^(@comforge\/(core|github)|node:[a-z/]+|\.\/[\w]+\.ts)$/.test(specifier as string) ? "ok" : specifier).toBe("ok");
      expect(/portfolio/i.test(source)).toBe(false);
    }
  });
});
