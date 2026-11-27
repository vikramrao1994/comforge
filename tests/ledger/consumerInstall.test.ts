import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { packDistribution } from "../../tooling/release/pack";

// the independent example consumer of @comforge/ledger,
// against the built distribution tarball as a consumer installs it. A fresh directory whose
// node_modules holds only the tarball's contents (the package has no dependencies) and
// @types/node for the type check; run under Node and under Bun. LEDGER_TEST_RUNTIMES
// (comma-separated executables, for example several Node binaries) replaces `node,bun`.

const REPO = path.resolve(import.meta.dir, "../..");
const EXAMPLE = path.join(REPO, "examples", "ledger-consumer");
const RUNTIMES = (process.env.LEDGER_TEST_RUNTIMES ?? "node,bun").split(",").filter(Boolean);
const kind = (runtime: string) => (path.basename(runtime).startsWith("bun") ? "bun" : "node");
let work: string;
let consumer: string;
let packed: { tarball: string; files: string[] };

beforeAll(() => {
  work = mkdtempSync(path.join(tmpdir(), "comforge-ledger-consumer-"));
  packed = packDistribution(path.join(work, "pack"), path.join(REPO, "packages", "ledger"));
  consumer = path.join(work, "consumer");
  cpSync(EXAMPLE, consumer, { recursive: true });
  const modules = path.join(consumer, "node_modules");
  const target = path.join(modules, "@comforge", "ledger");
  mkdirSync(target, { recursive: true });
  const untar = spawnSync("tar", ["-xzf", packed.tarball, "-C", target, "--strip-components=1"], { encoding: "utf8" });
  if (untar.status !== 0) throw new Error(untar.stderr);
  for (const dep of ["@types/node", "undici-types"])
    cpSync(path.join(REPO, "node_modules", dep), path.join(modules, dep), { recursive: true, dereference: true });
}, 180_000);

afterAll(() => rmSync(work, { recursive: true, force: true }));

/** stderr without Node's notice that node:sqlite is experimental (Node 22 and 24). */
const quiet = (err: string) =>
  err
    .split("\n")
    .filter((l) => l.trim() && !/ExperimentalWarning|--trace-warnings/.test(l))
    .join("\n");

describe("@comforge/ledger installed from its distribution tarball", () => {
  test("the tarball ships the manifest, compiled dist with declarations, README and llms.txt only", () => {
    const files = packed.files.map((f) => f.replace(/^package\//, ""));
    expect(files.filter((f) => !f.startsWith("dist/")).sort()).toEqual(["README.md", "llms.txt", "package.json"]);
    for (const module of ["conformance", "contract", "file", "index", "memory", "sqlite"])
      for (const ext of [".js", ".d.ts"]) expect(files).toContain(`dist/${module}${ext}`);
    expect(files.some((f) => f.startsWith("src/") || f.startsWith("test/"))).toBe(false);
  });

  test("nothing private ships, and the manifest has no dependencies and four entry points", () => {
    const root = path.join(consumer, "node_modules", "@comforge", "ledger");
    const text = packed.files
      .map((f) => f.replace(/^package\//, ""))
      .map((f) => readFileSync(path.join(root, f), "utf8"))
      .join("\n");
    for (const pattern of [
      /vikramrao1994\/portfolio/,
      /@\/lib\//,
      /engineering-gateway/,
      /process\.env/,
      /\/Users\//,
      /gh[pousr]_[A-Za-z0-9]{20,}/,
      /bun:sqlite"/,
    ])
      expect(pattern.test(text)).toBe(false);
    const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
    expect(manifest.dependencies).toBeUndefined();
    expect(Object.keys(manifest.exports).sort()).toEqual([".", "./conformance", "./file", "./package.json", "./sqlite"]);
    expect(manifest.exports["./sqlite"]).toEqual({ types: "./dist/sqlite.d.ts", default: "./dist/sqlite.js" });
  });

  test("the example type-checks against the shipped declarations", () => {
    const r = spawnSync(path.join(REPO, "node_modules", ".bin", "tsc"), ["-p", "tsconfig.json"], { cwd: consumer, encoding: "utf8" });
    expect(`${r.stdout}${r.stderr}`.trim()).toBe("");
    expect(r.status).toBe(0);
  }, 120_000);

  test.each(RUNTIMES)("every use case passes under %s", (runtime) => {
    const r = spawnSync(runtime, ["src/main.ts"], {
      cwd: consumer,
      encoding: "utf8",
      env: { NODE_ENV: "test", PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
    });
    expect(quiet(r.stderr)).toBe("");
    const out = JSON.parse(r.stdout) as { runtime: string; checks: { id: string; pass: boolean }[]; failed: string[] };
    expect(out.runtime.startsWith(kind(runtime))).toBe(true);
    console.log(`packed consumer: ${out.runtime}, ${out.checks.length} checks passed`);
    expect(out.checks).toHaveLength(48);
    expect(out.failed).toEqual([]);
    expect(r.status).toBe(0);
  }, 60_000);

  test("the example imports only the package, Node built-ins and nothing of the portfolio", () => {
    const source = readFileSync(path.join(EXAMPLE, "src", "main.ts"), "utf8");
    for (const [, specifier] of source.matchAll(/from "([^"]+)"/g))
      expect(/^(@comforge\/ledger(\/(file|sqlite|conformance))?|node:[a-z/]+)$/.test(specifier as string) ? "ok" : specifier).toBe("ok");
    expect(/portfolio/i.test(source)).toBe(false);
  });
});
