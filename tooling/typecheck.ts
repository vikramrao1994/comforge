/**
 * `bun run typecheck` — every package's source under its own tsconfig (nodenext, the shipped
 * resolution), then the repository tooling and tests under the root tsconfig.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";

const REPO = path.resolve(import.meta.dir, "..");
const TSC = path.join(REPO, "node_modules", ".bin", "tsc");
const projects = [
  ...["core", "github", "ledger", "cli", "mcp"].map((id) => `packages/${id}/tsconfig.json`),
  "tsconfig.json",
];
let failed = 0;
for (const project of projects) {
  const r = spawnSync(TSC, ["-p", project], { cwd: REPO, stdio: "inherit" });
  if (r.status !== 0) {
    failed += 1;
    console.error(`typecheck failed: ${project}`);
  }
}
if (failed > 0) process.exit(1);
console.log(`typecheck passed: ${projects.length} projects`);
