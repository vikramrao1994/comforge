import { afterEach, expect, test } from "bun:test";
import { main } from "../../packages/cli/src/cli.ts";
import { EXIT } from "../../packages/cli/src/errors.ts";
import { defaultRuntime } from "../../packages/cli/src/runtime.ts";

// Windows is unsupported on purpose (hard links, POSIX permissions, git hooks): every command
// is refused with a stable error code before anything runs, instead of failing halfway.
const real = Object.getOwnPropertyDescriptor(process, "platform");
afterEach(() => {
  if (real) Object.defineProperty(process, "platform", real);
});

test("every command is refused on Windows with unsupported-platform, before it runs", async () => {
  Object.defineProperty(process, "platform", { value: "win32" });
  for (const argv of [
    ["status", "--json"],
    ["doctor", "--json"],
    ["start", "DEMO-001", "--json"],
  ]) {
    const out: string[] = [];
    const err: string[] = [];
    const exit = await main(argv, defaultRuntime(), { out: (t) => out.push(t), err: (t) => err.push(t) });
    expect(exit).toBe(EXIT.usage);
    expect(`${out.join("")}${err.join("")}`).toContain("unsupported-platform");
  }
});
