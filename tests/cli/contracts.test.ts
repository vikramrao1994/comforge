import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { COMMANDS, capabilities } from "../../packages/cli/src/commands/agent.ts";
import { configJsonSchema } from "../../packages/cli/src/config.ts";
import { ERROR_CODES } from "../../packages/cli/src/errors.ts";

// Review L2: the public documents and the contract evidence say what the code does. These checks
// fail when a command, error code or authorization mode is added or renamed in one place only.

const REPO = path.resolve(import.meta.dir, "../..");
const read = (f: string) => readFileSync(path.join(REPO, f), "utf8");
const readme = read("packages/cli/README.md");
// The package README is a short npm page; the full tables live in the reference it links to.
const errorsPage = read("docs/reference/errors.md");
const cliPage = read("docs/reference/cli.md");
const llms = read("packages/cli/llms.txt");
const evidence = JSON.parse(read("tests/cli/fixtures/cli-contracts-0.2.0.json"));

test("every error code is in the error reference with its exit status, and in the contract evidence", () => {
  for (const [code, exit] of Object.entries(ERROR_CODES)) {
    const row = errorsPage.split("\n").find((l) => l.startsWith(`| \`${code}\` | ${exit} |`));
    expect(row, code).toBeDefined();
  }
  expect([...evidence.errorCodes].sort()).toEqual(Object.keys(ERROR_CODES).sort());
});

test("every command is in the README's table", () => {
  for (const command of COMMANDS) expect(readme).toContain(`\`${command.name}`);
});

test("the three authorization settings are described the same way in code, schema, README, CLI reference and llms.txt", () => {
  const caps = JSON.stringify(capabilities().result);
  const schema = JSON.stringify(configJsonSchema());
  for (const text of [caps, readme, cliPage, llms]) {
    expect(text).toContain("owner-grant");
    expect(text).toContain("operator");
    expect(text).toMatch(/refuse/);
  }
  expect(schema).toContain("owner-grant");
  expect(schema).toContain("operator");
  for (const term of ["maxAttempts", "expiry", "replay", "each operation", "not a sandbox"]) expect(cliPage).toContain(term);
  expect(evidence.authorization.owner["owner-grant"]).toContain("spent atomically");
});
