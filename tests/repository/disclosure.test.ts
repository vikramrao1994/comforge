import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { REPOSITORY_RULES, scan } from "../../tooling/disclosure";

// The repository is public: every tracked file passes the disclosure scan, and every exception
// in tooling/disclosure-allow.json still matches something (a stale exception is an error).
test("the whole tracked tree is clean, with no stale exception", () => {
  const { findings, unusedAllowances } = scan();
  expect(findings).toEqual([]);
  expect(unusedAllowances).toEqual([]);
});

test("the rules catch what must never be committed", () => {
  const hit = (text: string) => REPOSITORY_RULES.filter((r) => r.pattern.test(text)).map((r) => r.id);
  expect(hit("see the portfolio repository")).toContain("private-repository");
  expect(hit("/Users/someone/Desktop/project")).toContain("machine-path");
  expect(hit("ghp_abcdefghijklmnopqrstuvwxyz0123456789")).toContain("github-token");
  expect(hit("-----BEGIN PRIVATE KEY-----")).toContain("private-key-block");
});

test("a private ticket id is a finding; synthetic ids are not", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "disclosure-"));
  try {
    const file = path.join(dir, "x.ts");
    writeFileSync(file, "// INTERNAL-PROJECT-042 and DEMO-001\n");
    const { findings } = scan([path.relative(path.resolve(import.meta.dir, "../.."), file)]);
    expect(findings.map((f) => f.rule)).toEqual(["internal-ticket"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
