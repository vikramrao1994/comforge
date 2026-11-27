/**
 * `bun tooling/route.ts "<task>"` — the routing category for a task (context/routing.json),
 * through the same matcher as `comforge context`. Guidance only; it grants nothing.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { RoutingManifestSchema, routeTask } from "../packages/cli/src/routing.ts";

const REPO = path.resolve(import.meta.dir, "..");
export const loadRouting = () =>
  RoutingManifestSchema.parse(
    JSON.parse(readFileSync(path.join(REPO, "context", "routing.json"), "utf8")),
  );

if (import.meta.main) {
  const task = process.argv.slice(2).join(" ").trim();
  if (!task) {
    console.error('usage: bun tooling/route.ts "<task>"');
    process.exit(2);
  }
  const manifest = loadRouting();
  const r = routeTask(manifest, task);
  const id = r.match?.id ?? "general";
  console.log(
    JSON.stringify(
      {
        task,
        category: id,
        ...manifest.categories[id],
        ambiguous: r.ambiguous,
        alternatives: r.alternatives,
      },
      null,
      2,
    ),
  );
}
