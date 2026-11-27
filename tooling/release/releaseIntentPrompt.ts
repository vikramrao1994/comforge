/**
 * The release-intent step of `bun commit` (COMFORGE-RELEASE-AUTOMATION-001). When the
 * staged change touches what a releasable Comforge package ships and stages no intent of its
 * own, the developer is offered a deterministic suggestion — from the diff, never from a
 * model — and accepts, edits or declines it. Nothing is recorded without that answer:
 * `--yes` never records an intent, and a drafted major intent must be edited to say what
 * breaks. The planner refuses a library change no intent covers, so declining defers the
 * decision; it does not lose it.
 */

import { PACKAGE_NAMES } from "./packages";
import {
  draftIntent,
  intentFileName,
  isIntentFile,
  parseIntent,
  type ReleasePackage,
  serializeIntent,
  suggestBump,
} from "./releaseIntent";

export type IntentPromptIO = {
  ask: (question: string) => Promise<string>;
  /** Opens `text` in the developer's editor; returns the saved text, or null if cancelled. */
  edit: (text: string) => string | null;
  log: (line: string) => void;
};

export async function promptReleaseIntents(
  input: { files: string[]; diff: string; subject: string; auto: boolean; now: Date },
  io: IntentPromptIO,
): Promise<{ file: string; text: string }[]> {
  if (input.files.some(isIntentFile)) {
    io.log("  Release intent: staged with this commit\n");
    return [];
  }
  const recorded: { file: string; text: string }[] = [];
  for (const pkg of PACKAGE_NAMES as ReleasePackage[]) {
    const suggestion = suggestBump(pkg, input.files, input.diff);
    if (!suggestion) continue;
    if (input.auto) {
      io.log(
        `  Release intent: none recorded for ${pkg} (--yes never records one); the release planner refuses an uncovered library change until an intent covers this commit\n`,
      );
      continue;
    }
    const answer = (
      await io.ask(
        `This change touches what ${pkg} ships. Record a release intent? suggested: ${suggestion.bump} — ${suggestion.reason} [y/e/n] `,
      )
    ).toLowerCase();
    if (answer !== "y" && answer !== "e") {
      io.log(
        `  Release intent: declined for ${pkg}; a later intent can classify this commit with "covers"\n`,
      );
      continue;
    }
    const draft = serializeIntent(draftIntent(pkg, suggestion, input.subject));
    // A major draft cannot be accepted as is: what breaks has to be written by a person.
    const text = answer === "e" || suggestion.bump === "major" ? io.edit(draft) : draft;
    if (text === null) throw new Error("release intent editing was cancelled");
    const file = intentFileName(input.now, input.subject);
    const intent = parseIntent(file, text);
    recorded.push({ file, text: serializeIntent(intent) });
    io.log(`  Release intent: ${intent.bump} for ${pkg} → ${file}\n`);
  }
  return recorded;
}
