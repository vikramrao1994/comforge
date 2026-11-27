import { pathToFileURL } from "node:url";
import { authorizationFlow, type Check, lifecycleFlow, recordsFlow, specificationFlow } from "./flows.ts";

/** Runs every use case; deterministic, offline, and free of any credential. */
export function runExample(): { runtime: string; checks: Check[] } {
  const runtime =
    typeof (globalThis as { Bun?: { version: string } }).Bun === "undefined"
      ? `node ${process.version}`
      : `bun ${(globalThis as unknown as { Bun: { version: string } }).Bun.version}`;
  return {
    runtime,
    checks: [...specificationFlow(), ...authorizationFlow(), ...lifecycleFlow(), ...recordsFlow()],
  };
}

// Run when executed directly (`node src/main.ts`, `bun src/main.ts`), not when imported.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = runExample();
  const failed = result.checks.filter((c) => !c.pass);
  process.stdout.write(`${JSON.stringify({ ...result, failed: failed.map((c) => c.id) })}\n`);
  process.exit(failed.length === 0 ? 0 : 1);
}
