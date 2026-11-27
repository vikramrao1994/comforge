import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

// The older-verifier fixture is the published @comforge/core 0.1.2 `dist/`, unchanged: each
// file's SHA-256 is the one its consumer pin recorded after the registry readback.

const DIR = path.join(import.meta.dir, "fixtures", "core-0.1.2");
const fixture = JSON.parse(readFileSync(path.join(DIR, "fixture.json"), "utf8")) as {
  package: string;
  version: string;
  files: Record<string, string>;
};

test("the 0.1.2 verifier fixture is the released files, byte for byte", () => {
  expect(fixture).toMatchObject({ package: "@comforge/core", version: "0.1.2" });
  const present = readdirSync(path.join(DIR, "dist"))
    .map((f) => `dist/${f}`)
    .sort();
  expect(present).toEqual(Object.keys(fixture.files).sort());
  const changed = present.filter(
    (f) =>
      createHash("sha256")
        .update(readFileSync(path.join(DIR, f)))
        .digest("hex") !== fixture.files[f],
  );
  expect(changed).toEqual([]);
});
