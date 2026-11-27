import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { main } from "../src/cli.ts";
import { baseConfig, createWorld, type World } from "./harness.ts";

let world: World;
afterEach(() => world?.dispose());

describe("D: agent interface", () => {
  test("capabilities and schema are deterministic JSON; usage errors exit 2", async () => {
    world = createWorld();
    const a = await world.cli(["capabilities"]);
    const b = await world.cli(["capabilities"]);
    expect(a.code).toBe(0);
    expect(a.out).toBe(b.out);
    expect(a.json).toMatchObject({
      schema: "comforge-capabilities/v1",
      exitCodes: { ok: 0, refused: 1, usage: 2, failed: 3, incomplete: 4 },
    });
    expect(a.json.never).toContain("merge");
    const schema = await world.cli(["schema", "config"]);
    expect(schema.json.properties.security).toBeDefined();
    expect((await world.cli(["frobnicate"])).code).toBe(2);
    expect((await world.cli(["status", "--execute"])).json.error).toBe("usage");
    expect((await world.cli(["start"])).code).toBe(2);
  });

  test("--help and --version are plain text; no command prints help and exits 2", async () => {
    world = createWorld();
    let out = "";
    const io = {
      out: (t: string) => {
        out += t;
      },
      err: (t: string) => {
        out += t;
      },
    };
    expect(await main(["--help"], world.rt(), io)).toBe(0);
    expect(out).toContain("comforge init");
    out = "";
    expect(await main(["publish", "--help"], world.rt(), io)).toBe(0);
    expect(out).toContain("--execute");
    expect(await main([], world.rt(), { out: () => {}, err: () => {} })).toBe(2);
  });

  test("context returns the one matching category with its files and size; check finds generic problems", async () => {
    world = createWorld({
      config: baseConfig({ context: { manifest: "routing.json" } }),
    });
    writeFileSync(
      path.join(world.primary, "routing.json"),
      JSON.stringify({
        version: 1,
        categories: {
          billing: {
            label: "Billing",
            triggers: ["invoice", "payment"],
            files: ["check.sh"],
            validation: ["sh check.sh"],
            codegraph: ["src/billing"],
          },
          search: { triggers: ["search ranking", "query"], files: ["missing.md"] },
        },
      }),
    );
    const routed = await world.cli(["context", "--task", "Fix the invoice payment rounding"]);
    expect(routed.json.match).toMatchObject({
      id: "billing",
      matchedTriggers: ["invoice", "payment"],
      files: ["check.sh"],
      extensions: { codegraph: ["src/billing"] },
    });
    expect(routed.json.size.approxTokens).toBeLessThan(200);
    expect((await world.cli(["context", "--task", "nothing relevant"])).json.match).toBeNull();
    const check = await world.cli(["context", "check"]);
    expect(check.code).toBe(1);
    expect(check.json.issues).toEqual([
      {
        category: "search",
        rule: "missing-file",
        message: "missing.md does not exist in the repository",
      },
    ]);
  });

  test("doctor is read-only, never prints a credential, and fails on an invalid configuration", async () => {
    world = createWorld();
    const ok = await world.cli(["doctor"]);
    expect(ok.json.ok).toBe(true);
    expect(ok.out).not.toContain("FAKEtoken");
    writeFileSync(
      path.join(world.primary, "comforge.config.json"),
      JSON.stringify({ ...baseConfig(), surprise: true }),
    );
    const bad = await world.cli(["doctor"]);
    expect([
      bad.code,
      bad.json.checks.find((c: { id: string }) => c.id === "config").status,
    ]).toEqual([1, "fail"]);
  });
});

describe("trust: configuration grants nothing", () => {
  test("unknown keys and unknown versions fail closed; a credential is only ever named", async () => {
    world = createWorld();
    writeFileSync(
      path.join(world.primary, "comforge.config.json"),
      JSON.stringify({ ...baseConfig(), schema: "comforge-config/v2" }),
    );
    const r = await world.cli(["start", "DEMO-001"]);
    expect([r.code, r.json.error]).toEqual([2, "config-invalid"]);
    writeFileSync(
      path.join(world.primary, "comforge.config.json"),
      JSON.stringify(baseConfig({ security: { credentials: { source: "literal", token: "x" } } })),
    );
    expect((await world.cli(["start", "DEMO-001"])).json.error).toBe("config-invalid");
  });

  test("start trusts the fetched base, not an uncommitted working copy", async () => {
    world = createWorld();
    const weakened = baseConfig({ validation: { commands: [{ name: "check", run: ["true"] }] } });
    writeFileSync(path.join(world.primary, "comforge.config.json"), JSON.stringify(weakened));
    const issue = world.specIssue("DEMO-001");
    const { checkout } = (await world.cli(["start", "DEMO-001", "--issue", String(issue)])).json;
    world.commitFile(checkout, "check.sh", "#!/bin/sh\nexit 5\n", "test: fail\n\nTicket: DEMO-001");
    expect((await world.cli(["verify", "DEMO-001"])).json.status).toBe("FAIL");
  });

  test("a missing credential refuses GitHub commands before any request", async () => {
    world = createWorld();
    const issue = world.specIssue("DEMO-001");
    let out = "";
    const code = await main(
      ["start", "DEMO-001", "--issue", String(issue), "--json"],
      world.rt(world.primary, { ACME_TOKEN: undefined }),
      {
        out: (t) => {
          out += t;
        },
        err: (t) => {
          out += t;
        },
      },
    );
    expect([code, JSON.parse(out).error]).toEqual([1, "credential-missing"]);
    expect(world.gh.requests).toHaveLength(0);
  });
});

describe("revise and phases", () => {
  test("revise resumes an open PR at its head and refuses a review of an older head", async () => {
    world = createWorld();
    const issue = world.specIssue("DEMO-001");
    const { checkout } = (await world.cli(["start", "DEMO-001", "--issue", String(issue)])).json;
    world.commitFile(checkout, "a.txt", "a\n", "feat: a\n\nTicket: DEMO-001");
    await world.cli(["verify", "DEMO-001"]);
    const pr = (await world.cli(["publish", "DEMO-001", "--title", "A", "--execute"])).json
      .pullRequest.number;
    expect(
      (await world.cli(["revise", String(pr), "--reviewed-head", "f".repeat(40)])).json.error,
    ).toBe("stale");
    const ok = await world.cli(["revise", String(pr)]);
    expect(ok.json).toMatchObject({ initiative: "DEMO-001", checkout, pullRequest: pr });
  });

  test("a phase gets its own branch and checkout, and must keep its ticket's specification", async () => {
    world = createWorld();
    const issue = world.specIssue("DEMO-001");
    await world.cli(["start", "DEMO-001", "--issue", String(issue)]);
    const other = world.specIssue("DEMO-001", "A different text.");
    expect((await world.cli(["start", "DEMO-001.b", "--issue", String(other)])).json.error).toBe(
      "conflict",
    );
    const phase = await world.cli(["start", "DEMO-001.b", "--issue", String(issue)]);
    expect(phase.json).toMatchObject({ initiative: "DEMO-001.b", branch: "agent/demo-001.b" });
    const list = await world.cli(["status"]);
    expect(list.json.initiatives.map((i: { initiative: string }) => i.initiative)).toEqual([
      "DEMO-001",
      "DEMO-001.b",
    ]);
  });
});

describe("E: init", () => {
  test("greenfield: preview by default, write once, idempotent rerun, consent before replacing", async () => {
    world = createWorld({ config: null });
    world.sh(
      world.primary,
      "git",
      "remote",
      "set-url",
      "origin",
      "https://github.com/acme/widgets.git",
    );
    writeFileSync(
      path.join(world.primary, "package.json"),
      JSON.stringify({ scripts: { test: "node --test", lint: "eslint ." } }),
    );
    writeFileSync(path.join(world.primary, "package-lock.json"), "{}");
    const preview = await world.cli(["init"]);
    expect(preview.json).toMatchObject({
      state: "absent",
      written: false,
      content: {
        repository: { owner: "acme", name: "widgets" },
        checkout: { provision: [["npm", "ci"]] },
        validation: {
          commands: [
            { name: "lint", run: ["npm", "run", "lint"] },
            { name: "test", run: ["npm", "run", "test"] },
          ],
        },
      },
    });
    expect(existsSync(path.join(world.primary, "comforge.config.json"))).toBe(false);
    expect((await world.cli(["init", "--write"])).json.written).toBe(true);
    const again = await world.cli(["init", "--write"]);
    expect(again.json).toMatchObject({ state: "unchanged", written: false });
    const file = path.join(world.primary, "comforge.config.json");
    const edited = JSON.parse(readFileSync(file, "utf8"));
    edited.validation.timeoutSeconds = 60;
    writeFileSync(file, JSON.stringify(edited));
    expect((await world.cli(["init", "--write"])).json.error).toBe("would-overwrite");
    expect(JSON.parse(readFileSync(file, "utf8")).validation.timeoutSeconds).toBe(60);
    expect((await world.cli(["init", "--write", "--force"])).json.written).toBe(true);
  });

  test("non-TypeScript and unknown projects: detected commands, or validation that fails closed", async () => {
    world = createWorld({ config: null });
    world.sh(
      world.primary,
      "git",
      "remote",
      "set-url",
      "origin",
      "git@github.com:acme/widgets.git",
    );
    writeFileSync(path.join(world.primary, "go.mod"), "module example.com/w\n");
    expect((await world.cli(["init"])).json.content.validation.commands).toEqual([
      { name: "test", run: ["go", "test", "./..."] },
    ]);
    world.sh(world.primary, "rm", "go.mod");
    const unknown = await world.cli(["init"]);
    expect(unknown.json.content.validation.commands[0].name).toBe("configure-validation");
    expect(unknown.json.notes.join(" ")).toContain("fails closed");
  });
});
