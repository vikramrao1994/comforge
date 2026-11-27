import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openContext } from "../src/context.ts";
import type { HostPolicy } from "../src/host.ts";
import { createLifecycleServices } from "../src/services.ts";
import { baseConfig, createWorld, TOKEN, type World } from "./harness.ts";

// M18: the host policy with a REAL second operating-system user, not simulated hooks. The test
// process is the supervisor; candidate validation runs as `COMFORGE_WORKER_USER` through
// `sudo -n -u`, and the host hands checkouts and snapshots to that user with POSIX ACLs.
// It runs only where that user exists and the supervisor may `sudo -n -u` it (the Linux runtime
// job and scripts/diagnostics/comforge-mcp-001/runtime-matrix.sh); elsewhere it is skipped and
// the evidence records it as not exercised.

const WORKER = process.env.COMFORGE_WORKER_USER ?? "";
const run = (argv: string[]) => Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe" });
// `id -un`, not os.userInfo(): Bun reports "unknown" for an account without a passwd shell entry.
const SUPERVISOR = run(["id", "-un"]).stdout.toString().trim();
const available =
  WORKER !== "" &&
  WORKER !== SUPERVISOR &&
  run(["sudo", "-n", "-u", WORKER, "true"]).exitCode === 0 &&
  run(["sh", "-c", "command -v setfacl"]).exitCode === 0;
const TICKET = "DEMO-001";
const SECURITY = {
  credentials: { source: "env", variable: "ACME_TOKEN" },
  authorization: { mode: "operator" },
  capabilities: ["pulls:create", "pulls:update", "issues:comment", "branches:delete"],
};

const asWorker = (script: string, ...args: string[]) => [
  "sudo",
  "-n",
  "-u",
  WORKER,
  "--",
  "sh",
  "-c",
  script,
  "worker",
  ...args,
];
const must = (argv: string[]) => {
  const r = run(argv);
  if (r.exitCode !== 0) throw new Error(`${argv.join(" ")}: ${r.stderr.toString()}`);
};

/** The host side of worker isolation: what an embedding supervisor would write. */
function workerHost(parent?: string, extra: Partial<HostPolicy> = {}): HostPolicy {
  return {
    ...(parent ? { checkoutParent: parent } : {}),
    prepareCheckout: (dir) =>
      must(["setfacl", "-R", "-m", `u:${WORKER}:rwX,d:u:${WORKER}:rwX,d:u:${SUPERVISOR}:rwX`, dir]),
    // The worker owns what the candidate wrote: it restores write access and empties the tree;
    // the supervisor removes the directory entries it owns.
    remove: (dir) => {
      run(asWorker('chmod -R u+w -- "$1" 2>/dev/null; rm -rf -- "$1" 2>/dev/null; true', dir));
      rmSync(dir, { recursive: true, force: true });
    },
    ...extra,
  };
}

// The candidate's validation, as the worker: it proves its identity, writes a tree the
// supervisor cannot delete, plants symlinks out of the checkout, and cannot read the
// supervisor's private file.
const workerValidation = (secret: string) => [
  {
    name: "worker-check",
    run: asWorker(
      [
        'test "$(id -un)" = "$2"',
        "mkdir -p out/deep && touch out/deep/f",
        'ln -s "$(dirname "$1")" out/escape && ln -s / out/root',
        "chmod -R a-w out",
        '! cat "$1" 2>/dev/null',
      ].join(" && "),
      secret,
      WORKER,
    ),
  },
];

/**
 * Test teardown across both identities: the worker empties what it can list and owns, the
 * supervisor descends into what only it can list, and removes its own entries last.
 */
function sweep(d: string): void {
  try {
    rmSync(d, { recursive: true, force: true });
    return;
  } catch {}
  run(asWorker('chmod -R u+w -- "$1" 2>/dev/null; rm -rf -- "$1" 2>/dev/null; true', d));
  try {
    if (lstatSync(d).isDirectory()) for (const child of readdirSync(d)) sweep(path.join(d, child));
  } catch {}
  rmSync(d, { recursive: true, force: true });
}

let world: World;
const dirs: string[] = [];
let secretDir = "";
let secret = "";
let scratchRoot = "";
const savedTmp = process.env.TMPDIR;

beforeAll(() => {
  if (!available) return;
  // Verification scratch goes here, so a leftover is visible to the test.
  scratchRoot = realpathSync(mkdtempSync(path.join(tmpdir(), "comforge-worker-scratch-")));
  process.env.TMPDIR = scratchRoot;
  // The worker may traverse the scratch root (not list it): checkouts and snapshots live below.
  must(["setfacl", "-m", `u:${WORKER}:x`, scratchRoot]);
  secretDir = realpathSync(mkdtempSync(path.join(scratchRoot, "supervisor-private-")));
  secret = path.join(secretDir, "token");
  writeFileSync(secret, "supervisor secret\n", { mode: 0o600 });
});
afterAll(() => {
  if (savedTmp === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = savedTmp;
  if (scratchRoot) sweep(scratchRoot);
});
afterEach(() => {
  world?.dispose();
  for (const d of dirs.splice(0)) sweep(d);
});

const services = (w: World, host?: HostPolicy) =>
  createLifecycleServices({
    runtime: w.rt(),
    repository: { root: w.primary, commonDir: path.join(w.primary, ".git") },
    credentials: () => TOKEN,
    ...(host ? { host } : {}),
  });
const value = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(`service refused: ${JSON.stringify(r.error)}`);
  return r.value;
};
/** A host-owned clone area the worker may traverse but not list or write. */
function clonesArea(): string {
  const d = realpathSync(mkdtempSync(path.join(scratchRoot, "clones-")));
  dirs.push(d);
  must(["setfacl", "-m", `u:${WORKER}:x`, d]);
  return d;
}
const verifyScratch = () =>
  readdirSync(scratchRoot).filter((n) => n.startsWith("comforge-verify-"));

async function merged(w: World, host: HostPolicy, checkout: string) {
  const pr = value(await services(w, host).publish({ id: TICKET, title: "A", execute: true }))
    .pullRequest as { number: number };
  const head = w.sh(checkout, "git", "rev-parse", "HEAD");
  Object.assign(w.gh.pulls.get(pr.number) as object, {
    state: "closed",
    merged: true,
    merged_at: "2026-01-02T00:00:00Z",
  });
  w.sh(w.remote, "git", "update-ref", "refs/heads/main", head);
}

describe.skipIf(!available)(`real worker user (${WORKER || "unset"})`, () => {
  test("checkout validation as the worker; the supervisor is denied; host cleanup removes it", async () => {
    world = createWorld({ config: baseConfig({ security: SECURITY }) });
    const parent = clonesArea();
    const host = workerHost(parent, { validation: workerValidation(secret) });
    const issue = world.specIssue(TICKET);
    const { checkout } = value(await services(world, host).start({ id: TICKET, issue }));
    world.commitFile(checkout, ".gitignore", "out/\n", `feat: a\n\nTicket: ${TICKET}`);
    const v = value(await services(world, host).verify({ id: TICKET }));
    expect(v).toMatchObject({ status: "PASS", policy: "host" });

    // Real permission boundary: the supervisor cannot delete what the worker made read-only.
    const f = path.join(checkout, "out", "deep", "f");
    let denied: string | undefined;
    try {
      rmSync(f);
    } catch (error) {
      denied = (error as NodeJS.ErrnoException).code;
    }
    expect(["EACCES", "EPERM"]).toContain(denied as string);
    expect(run(["stat", "-c", "%U", f]).stdout.toString().trim()).toBe(WORKER);

    await merged(world, host, checkout);
    const done = await services(world, host).cleanup({
      target: TICKET,
      execute: true,
      allowMissingCompletion: true,
    });
    if (!done.ok) throw new Error(JSON.stringify(done.error));
    expect(existsSync(checkout)).toBe(false);
    // The planted symlinks were removed, never followed.
    expect(existsSync(secret)).toBe(true);
    expect(existsSync("/etc/passwd")).toBe(true);
  });

  test("snapshot validation as the worker: prepared, PASS, removed with nothing left", async () => {
    world = createWorld({
      config: baseConfig({ security: SECURITY, verification: { snapshot: true } }),
    });
    const host = workerHost(clonesArea(), { validation: workerValidation(secret) });
    const issue = world.specIssue(TICKET);
    const { checkout } = value(await services(world, host).start({ id: TICKET, issue }));
    world.commitFile(checkout, ".gitignore", "out/\n", `feat: a\n\nTicket: ${TICKET}`);
    const before = verifyScratch();
    const v = value(await services(world, host).verify({ id: TICKET }));
    expect(v.status).toBe("PASS");
    expect(verifyScratch()).toEqual(before);
    // The candidate wrote nothing into the supervisor's checkout.
    expect(existsSync(path.join(checkout, "out"))).toBe(false);
  });

  test("without the host's removal the supervisor cannot remove the worker's snapshot (why the hook exists)", async () => {
    world = createWorld({
      config: baseConfig({ security: SECURITY, verification: { snapshot: true } }),
    });
    const { remove: _remove, ...noRemove } = workerHost(clonesArea(), {
      validation: workerValidation(secret),
    });
    const issue = world.specIssue(TICKET);
    const { checkout } = value(await services(world, noRemove).start({ id: TICKET, issue }));
    world.commitFile(checkout, ".gitignore", "out/\n", `feat: a\n\nTicket: ${TICKET}`);
    const before = new Set(verifyScratch());
    let failure: unknown;
    try {
      const r = await services(world, noRemove).verify({ id: TICKET });
      if (!r.ok) failure = r.error;
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeDefined();
    expect(JSON.stringify(failure ?? String(failure))).toMatch(/EACCES|EPERM|permission/i);
    const leftover = verifyScratch().filter((n) => !before.has(n));
    expect(leftover).toHaveLength(1);
    // What the CLI could not remove is still the worker's; the host sweeps it.
    sweep(path.join(scratchRoot, leftover[0] as string));
    expect(verifyScratch().filter((n) => !before.has(n))).toEqual([]);
  });

  test("a timed-out worker validation is FAIL, its process is gone, its snapshot removed; a rerun passes", async () => {
    world = createWorld({
      config: baseConfig({
        security: SECURITY,
        verification: { snapshot: true },
        validation: { commands: [{ name: "check", run: ["sh", "check.sh"] }], timeoutSeconds: 2 },
      }),
    });
    const parent = clonesArea();
    const slow = workerHost(parent, {
      validation: [{ name: "slow", run: asWorker("touch started && exec sleep 60") }],
    });
    const issue = world.specIssue(TICKET);
    const { checkout } = value(await services(world, slow).start({ id: TICKET, issue }));
    world.commitFile(checkout, ".gitignore", "started\nout/\n", `feat: a\n\nTicket: ${TICKET}`);
    const before = verifyScratch();
    const timedOut = value(await services(world, slow).verify({ id: TICKET }));
    expect(timedOut.status).toBe("FAIL");
    expect(timedOut.commands[0]).toMatchObject({ name: "slow", timedOut: true });
    expect(verifyScratch()).toEqual(before);
    // sudo relays the timeout's SIGTERM: no worker process outlives the cancelled validation.
    await Bun.sleep(500);
    expect(run(["pgrep", "-u", WORKER, "-f", "sleep 60"]).exitCode).toBe(1);
    const again = value(
      await services(world, workerHost(parent, { validation: workerValidation(secret) })).verify({
        id: TICKET,
      }),
    );
    expect(again.status).toBe("PASS");
  });

  test("a cleaned initiative reopened under the worker policy is prepared again and validates", async () => {
    world = createWorld({ config: baseConfig({ security: SECURITY }) });
    const parent = clonesArea();
    const host = workerHost(parent, { validation: workerValidation(secret) });
    const issue = world.specIssue(TICKET);
    const first = value(await services(world, host).start({ id: TICKET, issue }));
    world.commitFile(first.checkout, ".gitignore", "out/\n", `feat: a\n\nTicket: ${TICKET}`);
    value(await services(world, host).verify({ id: TICKET }));
    await merged(world, host, first.checkout);
    value(
      await services(world, host).cleanup({
        target: TICKET,
        execute: true,
        allowMissingCompletion: true,
      }),
    );
    const reopened = value(await services(world, host).start({ id: TICKET, issue, reopen: true }));
    expect(reopened.attempt).toBe(2);
    world.commitFile(reopened.checkout, "b.txt", "b\n", `feat: b\n\nTicket: ${TICKET}`);
    // Attempt 2's checkout is a new clone: without preparation the worker could not write in it.
    expect(run(["getfacl", "-p", reopened.checkout]).stdout.toString()).toContain(
      `user:${WORKER}:rwx`,
    );
    expect(value(await services(world, host).verify({ id: TICKET })).status).toBe("PASS");
    const record = await openContext(world.rt()).state.get(TICKET);
    expect(record?.attempts?.[0]?.record.validations.map((x) => x.status)).toEqual(["PASS"]);
  });

  test("a symlinked host parent is recorded canonically and the worker cannot write beside checkouts", async () => {
    world = createWorld({ config: baseConfig({ security: SECURITY }) });
    const real = clonesArea();
    const link = path.join(scratchRoot, `clones-link-${Date.now()}`);
    symlinkSync(real, link);
    dirs.push(link);
    const host = workerHost(link, { validation: workerValidation(secret) });
    const issue = world.specIssue(TICKET);
    const { checkout } = value(await services(world, host).start({ id: TICKET, issue }));
    expect(checkout).toBe(path.join(real, "demo-001"));
    expect((await openContext(world.rt()).state.get(TICKET))?.hostCheckoutParent).toBe(real);
    // The clone area itself stays the supervisor's: the worker may traverse, not create.
    expect(run(asWorker('mkdir -- "$1/intruder"', real)).exitCode).not.toBe(0);
    mkdirSync(path.join(real, "x"));
    expect(run(asWorker('rmdir -- "$1/x"', real)).exitCode).not.toBe(0);
  });
});

test("worker-user isolation: exercised here, or recorded as not exercised", () => {
  // Visible in every run's output: a skip is never silent and never counted as proof.
  console.log(
    available
      ? `worker-user: exercised as ${WORKER} (supervisor ${SUPERVISOR})`
      : "worker-user: NOT exercised (set COMFORGE_WORKER_USER to a sudo -n -u user with setfacl)",
  );
  expect(true).toBe(true);
});
