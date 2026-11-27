import { describe, expect, test } from "bun:test";
import { decideConsumerUpdate } from "../../tooling/release/consumerUpdate";
import {
  BREAKING_PLACEHOLDER,
  draftIntent,
  IntentError,
  intentFileName,
  isIntentFile,
  parseIntent,
  serializeIntent,
  suggestBump,
} from "../../tooling/release/releaseIntent";
import { promptReleaseIntents } from "../../tooling/release/releaseIntentPrompt";

// a release intent is reviewed, strict and immutable;
// `bun commit` suggests one deterministically and records nothing without an answer.

const valid = serializeIntent(draftIntent("@comforge/core", { bump: "patch" }, "Fix a thing."));

describe("release intent schema", () => {
  test("a drafted intent round-trips", () => {
    expect(parseIntent("release-intents/x.json", valid).bump).toBe("patch");
  });

  test.each([
    ["unknown package", { package: "@comforge/other" }],
    ["unknown bump", { bump: "huge" }],
    ["extra field", { version: "0.2.0" }],
    ["multi-line summary", { summary: "a\nb" }],
    ["major without breaking", { bump: "major" }],
    ["breaking without major", { breaking: "x" }],
    ["placeholder breaking", { bump: "major", breaking: BREAKING_PLACEHOLDER }],
    ["short covers sha", { covers: ["abc"] }],
  ])("refuses %s", (_label, change) => {
    const text = JSON.stringify({ ...JSON.parse(valid), ...change });
    expect(() => parseIntent("release-intents/x.json", text)).toThrow(IntentError);
  });

  test("names and locations", () => {
    expect(intentFileName(new Date("2026-11-24T10:00:00Z"), "Add the Widget API!")).toBe("release-intents/2026-11-24-add-the-widget-api.json");
    expect(isIntentFile("release-intents/a.json")).toBe(true);
    expect(isIntentFile("release-intents/README.md")).toBe(false);
    expect(isIntentFile("release-intents/nested/a.json")).toBe(false);
  });
});

describe("deterministic suggestions", () => {
  const src = ["packages/core/src/index.ts"];
  test.each([
    [src, "-export { a } from './a.ts';\n+export { b } from './a.ts';", "major"],
    [src, "+export { c } from './c.ts';", "minor"],
    [src, "-const x = 1;\n+const x = 2;", "patch"],
    [["packages/core/README.md"], "+text", "patch"],
    [["examples/core-consumer/src/main.ts"], "+text", "patch"],
  ] as const)("%j %s → %s", (files, diff, bump) => {
    expect(suggestBump("@comforge/core", [...files], diff)?.bump).toBe(bump);
  });

  test("tests and unrelated files suggest nothing", () => {
    expect(suggestBump("@comforge/core", ["packages/core/test/a.test.ts", "src/app/page.tsx"], "+x")).toBeNull();
  });
});

describe("the bun commit release-intent step", () => {
  const io = (answers: string[], edited: string | null = null) => {
    const log: string[] = [];
    const asked: string[] = [];
    return {
      log,
      asked,
      io: {
        ask: async (q: string) => {
          asked.push(q);
          return answers.shift() ?? "n";
        },
        edit: () => edited,
        log: (l: string) => log.push(l),
      },
    };
  };
  const base = {
    files: ["packages/core/src/grant.ts"],
    diff: "-a\n+b",
    subject: "fix grant expiry",
    auto: false,
    now: new Date("2026-11-24T00:00:00Z"),
  };

  test("accept records the suggestion", async () => {
    const t = io(["y"]);
    const out = await promptReleaseIntents(base, t.io);
    expect(out.map((o) => o.file)).toEqual(["release-intents/2026-11-24-fix-grant-expiry.json"]);
    expect(JSON.parse(out[0]!.text)).toMatchObject({ bump: "patch", summary: "fix grant expiry" });
  });

  test("edit records the edited, validated intent", async () => {
    const edited = JSON.stringify({ ...JSON.parse(valid), bump: "minor", summary: "Add grant renewal." });
    const out = await promptReleaseIntents(base, io(["e"], edited).io);
    expect(JSON.parse(out[0]!.text)).toMatchObject({ bump: "minor", summary: "Add grant renewal." });
  });

  test("an invalid edit or a cancelled editor records nothing and cancels", async () => {
    await expect(promptReleaseIntents(base, io(["e"], "{}").io)).rejects.toThrow(IntentError);
    await expect(promptReleaseIntents(base, io(["e"], null).io)).rejects.toThrow("cancelled");
  });

  test("a major suggestion always goes through the editor", async () => {
    const t = io(["y"], null);
    await expect(promptReleaseIntents({ ...base, files: ["packages/core/src/index.ts"], diff: "-export { a } from './a.ts';" }, t.io)).rejects.toThrow(
      "cancelled",
    );
  });

  test("decline and --yes record nothing; an already staged intent skips the question", async () => {
    expect(await promptReleaseIntents(base, io(["n"]).io)).toEqual([]);
    const auto = io([]);
    expect(await promptReleaseIntents({ ...base, auto: true }, auto.io)).toEqual([]);
    expect(auto.asked).toEqual([]);
    expect(auto.log.join("")).toContain("--yes never records one");
    const staged = io([]);
    expect(await promptReleaseIntents({ ...base, files: [...base.files, "release-intents/a.json"] }, staged.io)).toEqual([]);
    expect(staged.asked).toEqual([]);
  });

  test("a change outside every releasable package asks nothing", async () => {
    const t = io([]);
    expect(await promptReleaseIntents({ ...base, files: ["src/app/page.tsx"] }, t.io)).toEqual([]);
    expect(t.asked).toEqual([]);
  });
});

describe("consumer update decisions", () => {
  const published = ["0.0.0-stage", "0.1.0", "0.1.2", "0.1.3"];
  test("upgrades to a published version and keeps the current one otherwise", () => {
    expect(decideConsumerUpdate({ current: "0.1.2", target: "0.1.3", published, rollback: false })).toEqual({
      action: "update",
      from: "0.1.2",
      to: "0.1.3",
      direction: "upgrade",
    });
    expect(decideConsumerUpdate({ current: "0.1.2", target: "0.1.2", published, rollback: false }).action).toBe("current");
  });

  test.each([
    ["a staged or Git-only version", "0.1.1", false, "not-published"],
    ["a placeholder", "0.0.0-stage", false, "malformed-version"],
    ["an older version without --rollback", "0.1.0", false, "version-regression"],
  ])("refuses %s", (_label, target, rollback, code) => {
    expect(() => decideConsumerUpdate({ current: "0.1.2", target, published, rollback })).toThrow(`(${code})`);
  });

  test("a deliberate rollback pins an older published version", () => {
    expect(decideConsumerUpdate({ current: "0.1.2", target: "0.1.0", published, rollback: true })).toMatchObject({
      direction: "rollback",
    });
  });
});
