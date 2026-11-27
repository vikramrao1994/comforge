/**
 * Release intents: the reviewed, version-controlled statement of how a change affects a
 * releasable Comforge package.
 *
 * A Conventional Commit type is not a SemVer signal here. The audit measured it against the
 * real release history of `@comforge/core` and found `feat`/`fix` mostly on publisher and
 * consumer work that never changed the package, and a package rename with no `!`. The scope
 * (`architecture` on nearly every SDK commit) carries no package information at all. So the
 * only input the release planner accepts as a bump is an intent file a person committed and
 * the owner reviewed in its pull request. `bun commit` may suggest one, deterministically and
 * from the diff alone, and never writes one without the developer's answer.
 *
 * An intent is immutable once committed: an edit is refused by the planner, and a correction
 * is a new intent. Squashed, bulk, agent-produced or legacy commits that added no intent of
 * their own are classified by a later intent that names them in `covers`.
 */
import { z } from "zod";
import { isPackageName, PACKAGES, type PackageName, profileOf } from "./packages";

export const INTENT_SCHEMA = "comforge-release-intent/v1";
export const INTENT_DIR = "release-intents";

/** A releasable package (registry: tooling/release/packages.ts); each is versioned on its own. */
export type ReleasePackage = PackageName;
export const isReleasePackage = (name: string): name is ReleasePackage => isPackageName(name);

export const BUMPS = ["none", "patch", "minor", "major"] as const;
export type Bump = (typeof BUMPS)[number];
export const bumpRank = (bump: Bump) => BUMPS.indexOf(bump);

const SHA = /^[0-9a-f]{40}$/;
/** The text a drafted major intent carries until a person replaces it; never accepted. */
export const BREAKING_PLACEHOLDER = "DESCRIBE WHAT BREAKS AND HOW TO MIGRATE";

export const ReleaseIntentSchema = z
  .object({
    schema: z.literal(INTENT_SCHEMA),
    // One package, or several when one change ships in each of them with the same bump and
    // changelog line. A single name keeps its original meaning.
    package: z.union([
      z.string().refine(isReleasePackage, "not a releasable package"),
      z
        .array(z.string().refine(isReleasePackage, "not a releasable package"))
        .min(1)
        .refine((names) => new Set(names).size === names.length, "a package is listed twice"),
    ]),
    bump: z.enum(BUMPS),
    // One changelog line, written for the package's consumers.
    summary: z
      .string()
      .trim()
      .min(1)
      .max(300)
      .refine((s) => !s.includes("\n"), "one line"),
    // What breaks and how to migrate; required exactly when bump is major.
    breaking: z
      .string()
      .trim()
      .min(1)
      .max(1000)
      .refine((s) => s !== BREAKING_PLACEHOLDER, "still the drafted placeholder")
      .nullable(),
    // Earlier commits (full SHA) this intent classifies, for commits that added none.
    covers: z.array(z.string().regex(SHA, "a full 40-hex commit")).default([]),
  })
  .strict()
  .superRefine((intent, ctx) => {
    if ((intent.bump === "major") !== (intent.breaking !== null))
      ctx.addIssue({
        code: "custom",
        path: ["breaking"],
        message: "breaking is required for a major bump and only for one",
      });
  });
export type ReleaseIntent = z.infer<typeof ReleaseIntentSchema>;

/** The packages an intent applies to. */
export const intentPackages = (intent: Pick<ReleaseIntent, "package">): ReleasePackage[] =>
  (Array.isArray(intent.package) ? intent.package : [intent.package]) as ReleasePackage[];
export const intentTargets = (intent: Pick<ReleaseIntent, "package">, pkg: ReleasePackage) =>
  intentPackages(intent).includes(pkg);

export class IntentError extends Error {
  constructor(
    readonly file: string,
    message: string,
  ) {
    super(`${file}: ${message}`);
  }
}

export function parseIntent(file: string, text: string): ReleaseIntent {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new IntentError(file, "not valid JSON");
  }
  const parsed = ReleaseIntentSchema.safeParse(raw);
  if (!parsed.success)
    throw new IntentError(
      file,
      parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"} ${i.message}`).join("; "),
    );
  return parsed.data;
}

export const isIntentFile = (file: string) =>
  file.startsWith(`${INTENT_DIR}/`) &&
  file.endsWith(".json") &&
  !file.slice(INTENT_DIR.length + 1).includes("/");

/** Which releasable package a repository path belongs to, if any. */
export function packageOf(file: string): ReleasePackage | null {
  for (const pkg of Object.values(PACKAGES))
    if (file.startsWith(`${pkg.dir}/`) || file.startsWith(`${pkg.example}/`)) return pkg.name;
  return null;
}

/** Paths whose change can alter what a package ships. Tests are not shipped. */
export function isShippedPath(file: string): boolean {
  const pkg = packageOf(file);
  if (!pkg) return false;
  return !file.startsWith(`${profileOf(pkg).dir}/test/`);
}

/**
 * A deterministic suggestion from the staged diff, never a decision: removed exports suggest
 * major, added exports minor, other source or manifest changes patch, and shipped
 * documentation or example changes patch. Returns null when nothing shipped changed.
 */
export function suggestBump(
  pkg: ReleasePackage,
  files: string[],
  diff: string,
): { bump: Bump; reason: string } | null {
  const shipped = files.filter((f) => packageOf(f) === pkg && isShippedPath(f));
  if (shipped.length === 0) return null;
  const { dir } = profileOf(pkg);
  const exportLines = (sign: "+" | "-") =>
    diff
      .split("\n")
      .filter((l) => l.startsWith(sign) && !l.startsWith(`${sign}${sign}${sign}`))
      .map((l) => l.slice(1).trim())
      .filter((l) => /^export\s/.test(l) || /^"\.\/?[^"]*":\s*"\.\/src\//.test(l));
  const removed = exportLines("-").filter((l) => !exportLines("+").includes(l));
  const added = exportLines("+").filter((l) => !exportLines("-").includes(l));
  const source = shipped.filter((f) => f.startsWith(`${dir}/src/`) || f === `${dir}/package.json`);
  if (source.length > 0 && removed.length > 0)
    return { bump: "major", reason: `removes or changes ${removed.length} export line(s)` };
  if (source.length > 0 && added.length > 0)
    return { bump: "minor", reason: `adds ${added.length} export line(s)` };
  if (source.length > 0)
    return { bump: "patch", reason: `changes ${source.length} source or manifest file(s)` };
  return { bump: "patch", reason: `changes ${shipped.length} shipped document or example file(s)` };
}

export function intentFileName(date: Date, summary: string): string {
  const slug = summary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48)
    .replace(/-$/, "");
  return `${INTENT_DIR}/${date.toISOString().slice(0, 10)}-${slug || "change"}.json`;
}

export function draftIntent(
  pkg: ReleasePackage,
  suggestion: { bump: Bump },
  summary: string,
): ReleaseIntent {
  return {
    schema: INTENT_SCHEMA,
    package: pkg,
    bump: suggestion.bump,
    summary: summary.replace(/\s+/g, " ").trim(),
    breaking: suggestion.bump === "major" ? BREAKING_PLACEHOLDER : null,
    covers: [],
  };
}

export const serializeIntent = (intent: ReleaseIntent) => `${JSON.stringify(intent, null, 2)}\n`;
