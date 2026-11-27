/**
 * `bun run release:adopt-migrate [plan|check|apply] [--id ID] [--execute] [--json]`
 *
 * Prepared consumer migrations: source changes of the consumer that can only land together
 * with a release it does not have yet. Each is a reviewed patch plus a manifest naming the
 * package entry points the patch needs (tooling/release/consumer-migration/).
 *
 * - `plan` (default) and `check` write nothing. They report whether the patch still applies to
 *  the working tree, whether its digest is the reviewed one, and whether the installed
 *  packages already expose what it needs.
 * - `apply --execute` applies one migration atomically (`git apply` changes every file or
 *  none) and removes its patch and manifest. It refuses unless the installed packages expose
 *  every required entry point and the files it touches are unmodified. It is one step of the
 *  adoption change that pins those releases; it commits, pushes and installs nothing.
 *
 * Undoing an applied migration is reverting that change: the patch is in Git history.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

export const MIGRATION_SCHEMA = "comforge-consumer-migration/v1";
export const MIGRATION_DIR = "tooling/release/consumer-migration";

export const MigrationSchema = z
  .object({
    schema: z.literal(MIGRATION_SCHEMA),
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{2,63}$/),
    summary: z.string().min(1).max(300),
    patch: z.string().regex(/^[a-z0-9][a-z0-9-]{2,63}\.patch$/),
    patchSha256: z.string().regex(/^[0-9a-f]{64}$/),
    /** Entry points the installed package must export before the patch can be applied. */
    requires: z.record(
      z.string().regex(/^@comforge\/[a-z]+$/),
      z.array(z.string().regex(/^\.\/[a-z-]+$/)).min(1),
    ),
    /** Direct dependencies the consumer no longer needs once the patch is applied. */
    removesDependencies: z.array(z.string().regex(/^@comforge\/[a-z]+$/)),
  })
  .strict();
export type Migration = z.infer<typeof MigrationSchema>;

export type MigrationStatus = {
  id: string;
  summary: string;
  files: string[];
  digestMatches: boolean;
  applies: boolean;
  applyError: string | null;
  missing: { package: string; installed: string | null; entryPoints: string[] }[];
  ready: boolean;
};

export const sha256 = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");

export function patchFiles(patch: string): string[] {
  return [...patch.matchAll(/^\+\+\+ b\/(.+)$/gm)].map((m) => m[1] as string);
}

export function listMigrations(repo: string): Migration[] {
  const dir = path.join(repo, MIGRATION_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => MigrationSchema.parse(JSON.parse(readFileSync(path.join(dir, f), "utf8"))));
}

/** Required entry points the installed package does not export (all of them when it is absent). */
export function missingEntryPoints(repo: string, migration: Migration): MigrationStatus["missing"] {
  return Object.entries(migration.requires).flatMap(
    ([name, entryPoints]): MigrationStatus["missing"] => {
      const file = path.join(repo, "node_modules", name, "package.json");
      if (!existsSync(file)) return [{ package: name, installed: null, entryPoints }];
      const manifest = JSON.parse(readFileSync(file, "utf8")) as {
        version: string;
        exports?: Record<string, unknown>;
      };
      const absent = entryPoints.filter((e) => !Object.hasOwn(manifest.exports ?? {}, e));
      return absent.length > 0
        ? [{ package: name, installed: manifest.version, entryPoints: absent }]
        : [];
    },
  );
}

function git(repo: string, args: string[]) {
  return spawnSync("git", args, { cwd: repo, encoding: "utf8" });
}

export function statusOf(repo: string, migration: Migration): MigrationStatus {
  const patchPath = path.join(MIGRATION_DIR, migration.patch);
  const patch = readFileSync(path.join(repo, patchPath), "utf8");
  const check = git(repo, ["apply", "--check", patchPath]);
  const missing = missingEntryPoints(repo, migration);
  const digestMatches = sha256(patch) === migration.patchSha256;
  const applies = check.status === 0;
  return {
    id: migration.id,
    summary: migration.summary,
    files: patchFiles(patch),
    digestMatches,
    applies,
    applyError: applies ? null : check.stderr.trim().split("\n").slice(0, 5).join("\n"),
    missing,
    ready: digestMatches && applies && missing.length === 0,
  };
}

export class MigrationRefusal extends Error {}

/** Applies one migration to the working tree and removes its patch and manifest. */
export function applyMigration(repo: string, migration: Migration): MigrationStatus {
  const status = statusOf(repo, migration);
  if (!status.digestMatches)
    throw new MigrationRefusal("the patch is not the reviewed one (digest mismatch)");
  if (status.missing.length > 0)
    throw new MigrationRefusal(
      `the installed packages do not expose what the patch needs: ${status.missing
        .map(
          (m) =>
            `${m.package}${m.installed ? `@${m.installed}` : " (not installed)"} lacks ${m.entryPoints.join(", ")}`,
        )
        .join("; ")}`,
    );
  const dirty = git(repo, ["status", "--porcelain", "--", ...status.files]);
  if (dirty.status !== 0 || dirty.stdout.trim() !== "")
    throw new MigrationRefusal("files the patch touches have uncommitted changes");
  if (!status.applies)
    throw new MigrationRefusal(`the patch no longer applies:\n${status.applyError}`);
  const applied = git(repo, ["apply", path.join(MIGRATION_DIR, migration.patch)]);
  if (applied.status !== 0)
    throw new MigrationRefusal(`git apply failed: ${applied.stderr.trim()}`);
  rmSync(path.join(repo, MIGRATION_DIR, migration.patch));
  rmSync(path.join(repo, MIGRATION_DIR, `${migration.id}.json`));
  return status;
}

if (import.meta.main) {
  const repo = path.resolve(import.meta.dir, "../..");
  const argv = process.argv.slice(2);
  const command = argv.find((a) => !a.startsWith("--")) ?? "plan";
  const idAt = argv.indexOf("--id");
  const migrations = listMigrations(repo).filter((m) => idAt < 0 || m.id === argv[idAt + 1]);
  if (!["plan", "check", "apply"].includes(command)) {
    console.error("usage: release:adopt-migrate [plan|check|apply] [--id ID] [--execute] [--json]");
    process.exit(2);
  }
  if (command === "apply") {
    if (migrations.length !== 1) {
      console.error("apply needs exactly one migration (--id ID)");
      process.exit(2);
    }
    const migration = migrations[0] as Migration;
    if (!argv.includes("--execute")) {
      console.log(
        `would apply ${migration.id} (${statusOf(repo, migration).files.length} files); add --execute`,
      );
      process.exit(0);
    }
    try {
      const status = applyMigration(repo, migration);
      console.log(
        `applied ${migration.id}: ${status.files.length} files changed, patch and manifest removed`,
      );
      if (migration.removesDependencies.length > 0)
        console.log(
          `no longer needed as direct dependencies: ${migration.removesDependencies.join(", ")}`,
        );
      console.log("next: bun run test:verify, then commit on the adoption branch");
    } catch (error) {
      if (!(error instanceof MigrationRefusal)) throw error;
      console.error(`refused: ${error.message}`);
      process.exit(1);
    }
    process.exit(0);
  }
  const statuses = migrations.map((m) => statusOf(repo, m));
  if (argv.includes("--json"))
    console.log(JSON.stringify({ schema: MIGRATION_SCHEMA, migrations: statuses }, null, 2));
  else if (statuses.length === 0) console.log("no prepared consumer migration");
  else
    for (const s of statuses) {
      console.log(`${s.id}: ${s.summary}`);
      console.log(
        `  files: ${s.files.length}; patch ${s.digestMatches ? "is the reviewed one" : "DIGEST MISMATCH"}; ${s.applies ? "applies cleanly" : "DOES NOT APPLY"}`,
      );
      for (const m of s.missing)
        console.log(
          `  waiting for a release: ${m.package}${m.installed ? `@${m.installed}` : ""} does not export ${m.entryPoints.join(", ")}`,
        );
      console.log(`  ${s.ready ? "READY to apply" : "not ready"}`);
    }
  // `check` fails on drift; a release that is still pending is not a failure.
  process.exit(command === "check" && statuses.some((s) => !s.digestMatches || !s.applies) ? 1 : 0);
}
