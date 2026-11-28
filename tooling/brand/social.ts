/**
 * `bun tooling/brand/social.ts` — rasterizes docs/assets/brand/social-preview.svg to the PNG
 * GitHub's social-preview setting requires (it accepts no SVG). Uses agent-browser (headless
 * Chromium) when installed; it is not a repository dependency and CI does not run this — CI
 * checks only that the PNG exists beside its SVG source (tooling/brand/brand.ts --check).
 */
import { spawnSync } from "node:child_process";
import path from "node:path";

const dir = path.resolve(import.meta.dir, "../../docs/assets/brand");
const run = (...args: string[]) => {
  const r = spawnSync("agent-browser", args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`agent-browser ${args.join(" ")}: ${r.stderr || r.stdout}`);
};
run("set", "viewport", "1280", "640");
run("open", `file://${path.join(dir, "social-preview.svg")}`);
run("screenshot", path.join(dir, "social-preview.png"));
console.log("wrote docs/assets/brand/social-preview.png");
