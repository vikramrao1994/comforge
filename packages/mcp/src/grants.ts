/**
 * An inline owner grant, handed to @comforge/cli as the file it reads.
 *
 * The envelope is signed by the owner; @comforge/cli verifies the signature against the
 * trusted keys, the ticket, the specification, the head and the branch, and spends one of
 * its attempts in the initiative's state. This module only stages the bytes in a private
 * directory the server creates (0700, file 0600) and removes it after the call. A caller
 * never names a path.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export async function withGrantFile<T>(
  envelope: unknown,
  run: (grantFile: string | undefined) => Promise<T>,
): Promise<T> {
  if (envelope === undefined) return run(undefined);
  const dir = mkdtempSync(path.join(tmpdir(), "comforge-mcp-grant-"));
  try {
    const file = path.join(dir, "grant.json");
    writeFileSync(file, `${JSON.stringify(envelope)}\n`, { mode: 0o600, flag: "wx" });
    return await run(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
