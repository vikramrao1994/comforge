import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { main } from "../src/cli.ts";
import { baseConfig, createWorld, type World } from "./harness.ts";

// R6: trusted publication policy. Checks before any push, a checked body from a trusted
// command, Closes and a publication marker, draft first and ready through a bounded adapter.

let world: World;
afterEach(() => world?.dispose());
const TICKET = "DEMO-001";

async function verified(w: World) {
  const issue = w.specIssue(TICKET);
  const { checkout } = (await w.cli(["start", TICKET, "--issue", String(issue)])).json;
  w.commitFile(checkout, "a.txt", "a\n", `feat: a\n\nTicket: ${TICKET}`);
  expect((await w.cli(["verify", TICKET])).code).toBe(0);
  return checkout as string;
}

const remoteHasBranch = (w: World) =>
  w.sh(w.remote, "git", "for-each-ref", "--format=%(refname)", "refs/heads/agent/demo-001") !== "";

/** A `gh` on PATH that records its arguments and leaves a marker the fake GitHub reads. */
function fakeGh(w: World) {
  const bin = path.join(w.root, "bin");
  mkdirSync(bin, { recursive: true });
  const log = path.join(w.root, "gh.log");
  writeFileSync(path.join(bin, "gh"), `#!/bin/sh\necho "$@" >> "${log}"\n`);
  chmodSync(path.join(bin, "gh"), 0o755);
  // `gh pr ready N` takes the pull request out of draft on "GitHub".
  w.gh.readOverrides.push((p) => {
    const m = p.match(/\/pulls\/(\d+)$/);
    if (m && existsSync(log) && readFileSync(log, "utf8").includes(`pr ready ${m[1]}`)) {
      const pull = w.gh.pulls.get(Number(m[1]));
      if (pull) pull.draft = false;
    }
    return undefined;
  });
  return {
    log,
    async cli(args: string[]) {
      let out = "";
      let err = "";
      const code = await main(
        [...args, "--json"],
        w.rt(w.primary, { PATH: `${bin}:${process.env.PATH}` }),
        {
          out: (t) => {
            out += t;
          },
          err: (t) => {
            err += t;
          },
        },
      );
      return { code, json: JSON.parse(out || err) };
    },
  };
}

describe("R6: publication checks and body", () => {
  test("a failing check refuses before anything is pushed or created, in a dry run too", async () => {
    world = createWorld({
      config: baseConfig({
        publication: {
          checks: [{ name: "evidence", run: ["sh", "-c", 'test -z "$ACME_TOKEN" && exit 4'] }],
        },
      }),
    });
    await verified(world);
    for (const args of [[], ["--execute"]]) {
      const r = await world.cli(["publish", TICKET, "--title", "A", ...args]);
      expect([r.code, r.json.error, r.json.detail?.check]).toEqual([
        1,
        "policy-denied",
        "evidence",
      ]);
    }
    expect(remoteHasBranch(world)).toBe(false);
    expect(world.gh.writes()).toHaveLength(0);
  });

  test("the body comes from the trusted command, then Closes and the publication marker", async () => {
    world = createWorld({
      config: baseConfig({
        publication: {
          checks: [{ name: "ok", run: ["true"] }],
          bodyCommand: [
            "sh",
            "-c",
            'printf "## %s\\n\\nhead %s\\n" "$COMFORGE_INITIATIVE" "$COMFORGE_HEAD"',
          ],
          marker: true,
        },
      }),
    });
    const checkout = await verified(world);
    const head = world.sh(checkout, "git", "rev-parse", "HEAD");
    const r = await world.cli(["publish", TICKET, "--title", "A", "--closes", "41", "--execute"]);
    expect(r.code).toBe(0);
    expect(r.json.plan.checks).toEqual([{ name: "ok", status: "PASS" }]);
    const body = world.gh.pulls.get(r.json.pullRequest.number)?.body ?? "";
    expect(
      body.startsWith(
        `## ${TICKET}\n\nhead ${head}\n\nCloses #41\n\n<!-- acme-lifecycle:publication ticket=${TICKET} head=${head} -->`,
      ),
    ).toBe(true);
  });

  test("a body that hides content, forges a marker or carries a secret is refused before any push", async () => {
    for (const out of [
      "<!-- hidden -->",
      "acme-lifecycle:completion v1",
      `token ghp_${"A".repeat(36)}`,
    ]) {
      world = createWorld({
        config: baseConfig({ publication: { bodyCommand: ["printf", "%s", out] } }),
      });
      await verified(world);
      const r = await world.cli(["publish", TICKET, "--title", "A", "--execute"]);
      expect([r.code, r.json.error]).toEqual([1, "policy-denied"]);
      expect(remoteHasBranch(world)).toBe(false);
      world.dispose();
    }
    world = createWorld();
  });
});

describe("R6: draft first, then ready", () => {
  test("draftFirst needs the pulls:ready capability", async () => {
    world = createWorld({ config: baseConfig({ publication: { draftFirst: true } }) });
    await verified(world);
    expect((await world.cli(["publish", TICKET, "--title", "A"])).json.error).toBe(
      "config-invalid",
    );
  });

  test("created as a draft, marked ready by the adapter for exactly this pull request", async () => {
    world = createWorld({
      config: baseConfig({
        publication: { draftFirst: true },
        security: {
          credentials: { source: "env", variable: "ACME_TOKEN" },
          authorization: { mode: "operator" },
          capabilities: ["pulls:create", "pulls:update", "issues:comment", "pulls:ready"],
        },
      }),
    });
    await verified(world);
    const gh = fakeGh(world);
    const r = await gh.cli(["publish", TICKET, "--title", "A", "--execute"]);
    expect(r.code).toBe(0);
    const pr = r.json.pullRequest.number as number;
    expect(r.json.plan.pullRequest).toMatchObject({ action: "create", draft: true });
    expect(r.json.readyForReview).toEqual({ ready: true, detail: "marked ready with gh" });
    expect(r.json.pullRequest.draft).toBe(false);
    expect(readFileSync(gh.log, "utf8").trim()).toBe(`pr ready ${pr} --repo acme/widgets`);

    // --draft keeps it a draft: the adapter is not run.
    world.dispose();
    world = createWorld({
      config: baseConfig({
        publication: { draftFirst: true },
        security: {
          credentials: { source: "env", variable: "ACME_TOKEN" },
          authorization: { mode: "operator" },
          capabilities: ["pulls:create", "pulls:update", "issues:comment", "pulls:ready"],
        },
      }),
    });
    await verified(world);
    const gh2 = fakeGh(world);
    const draft = await gh2.cli(["publish", TICKET, "--title", "A", "--draft", "--execute"]);
    expect([draft.code, draft.json.pullRequest.draft, draft.json.readyForReview]).toEqual([
      0,
      true,
      null,
    ]);
    expect(existsSync(gh2.log)).toBe(false);
  });
});
