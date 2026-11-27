import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { packDistribution } from "../../tooling/release/pack";

// COMFORGE-ADOPTION-001 A12: an ordinary consumer whose only Comforge dependencies are the
// @comforge/cli and @comforge/mcp candidates, installed fresh from their distribution tarballs
// with strict (isolated) resolution, so nothing it did not declare is importable. A plain
// JavaScript host runs under each runtime, and a TypeScript host type-checks against the
// shipped declarations. The lower-level packages come from the registry as transitive
// dependencies at the exact versions the candidates' manifests name. No GitHub, no credential.

const REPO = path.resolve(import.meta.dir, "../..");
const RUNTIMES = (process.env.COMFORGE_TEST_RUNTIMES ?? "node,bun").split(",").filter(Boolean);
let work: string;
let consumer: string;

beforeAll(() => {
  work = mkdtempSync(path.join(tmpdir(), "comforge-two-package-"));
  const cli = packDistribution(path.join(work, "pack"), path.join(REPO, "packages", "cli"));
  const mcp = packDistribution(path.join(work, "pack"), path.join(REPO, "packages", "mcp"));
  consumer = path.join(work, "consumer");
  cpSync(path.join(import.meta.dir, "fixtures", "two-package-consumer"), consumer, { recursive: true });
  const manifest = JSON.parse(readFileSync(path.join(consumer, "package.json"), "utf8"));
  manifest.dependencies = { "@comforge/cli": `file:${cli.tarball}`, "@comforge/mcp": `file:${mcp.tarball}` };
  // The MCP candidate names the CLI's next version, which exists only as this tarball.
  manifest.overrides = { "@comforge/cli": `file:${cli.tarball}` };
  writeFileSync(path.join(consumer, "package.json"), JSON.stringify(manifest));
  const install = spawnSync("bun", ["install", "--linker", "isolated", "--ignore-scripts"], {
    cwd: consumer,
    encoding: "utf8",
    // A cache of its own: Bun keys a tarball by name and version, and a candidate's change.
    env: { ...process.env, BUN_INSTALL_CACHE_DIR: path.join(work, "cache") },
  });
  if (install.status !== 0) throw new Error(install.stderr);
}, 600_000);
afterAll(() => rmSync(work, { recursive: true, force: true }));

describe("a consumer of @comforge/cli and @comforge/mcp only", () => {
  test("declares two dependencies and can reach nothing else of Comforge", () => {
    const manifest = JSON.parse(readFileSync(path.join(consumer, "package.json"), "utf8"));
    expect(Object.keys(manifest.dependencies).sort()).toEqual(["@comforge/cli", "@comforge/mcp"]);
    expect(readdirSync(path.join(consumer, "node_modules", "@comforge")).sort()).toEqual(["cli", "mcp"]);
    // One CLI serves both: the MCP package resolves the same installed copy.
    const viaMcp = realpathSync(path.join(realpathSync(path.join(consumer, "node_modules/@comforge/mcp")), "..", "cli"));
    expect(viaMcp).toBe(realpathSync(path.join(consumer, "node_modules/@comforge/cli")));
    for (const entry of ["protocolProfile", "authority"]) expect(existsSync(path.join(viaMcp, "dist", `${entry}.d.ts`))).toBe(true);
  });

  test.each(RUNTIMES)("the JavaScript host passes under %s", (runtime) => {
    const r = spawnSync(runtime, ["host.mjs"], {
      cwd: consumer,
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" } as unknown as NodeJS.ProcessEnv,
    });
    const out = JSON.parse(r.stdout.trim().split("\n").at(-1) as string) as { runtime: string; checks: string[]; failed: string[] };
    expect(out.failed).toEqual([]);
    expect(out.runtime).toBe(runtime);
    expect(out.checks).toHaveLength(15);
    expect(r.status).toBe(0);
  }, 120_000);

  test("the TypeScript host type-checks against the shipped declarations", () => {
    const r = spawnSync(path.join(REPO, "node_modules", ".bin", "tsc"), ["-p", ".", "--typeRoots", path.join(REPO, "node_modules", "@types")], {
      cwd: consumer,
      encoding: "utf8",
    });
    expect(r.stdout + r.stderr).toBe("");
    expect(r.status).toBe(0);
  }, 180_000);
});
