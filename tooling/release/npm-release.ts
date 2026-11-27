/**
 * Plans or reads back the npm version of a published Comforge Git release (`--package`, default
 * `@comforge/core`), from the
 * owner's machine. It never publishes and never reads an npm credential.
 *
 *   bun run release:npm-plan --commit <release commit> [--out DIR]
 *   bun run release:npm-readback --plan DIR/npm-plan.json [--expect-provenance]
 *   bun run release:npm-readback --commit <release commit> [--expect-provenance] [--write-pin DIR]
 *
 * `plan` clones the public release repository anonymously, checks that the release tag
 * points at exactly that commit, and runs the same verifier the Comforge workflow runs
 * (`release-assets/npm-release.mjs`): RELEASE.json digests, manifest, no lifecycle scripts,
 * `npm pack --dry-run` contents, registry state. When the package does not exist yet it
 * prints the owner's one-time bootstrap; npm can attach a Trusted Publisher only to an
 * existing package. `readback --commit` needs no plan: it derives every expected file digest
 * from the cloned Git release itself, so it also verifies a version this machine never packed
 * (a Trusted-Publishing release). `--write-pin` records that verified result as the
 * portfolio's consumer pin (COMFORGE-NPM-AUTOMATION-001). See
 * docs/engineering/factory-core-distribution.md, "npm distribution".
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MIRROR_REPOSITORY } from "./mirror";
import { profileOf } from "./packages";
import {
  NpmReleaseRefusal,
  plan,
  readback,
  releaseExpectation,
} from "./assets/npm-release.mjs";

export const PIN_SCHEMA = "comforge-npm-pin/v1";

const argv = process.argv.slice(2);
const arg = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
/** `--package NAME` (default `@comforge/core`): which registry package's release this is. */
const profile = profileOf(arg("--package") ?? "@comforge/core");
const git = (cwd: string, args: string[]) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.trim()}`);
  return r.stdout.trim();
};

/** Clones the public release anonymously at `commit` and checks its tag points there. */
async function withRelease<T>(commit: string, fn: (dir: string, tag: string) => Promise<T>) {
  if (!/^[0-9a-f]{40}$/.test(commit))
    throw new Error("--commit must be the full 40-hex release commit");
  const url = `https://github.com/${MIRROR_REPOSITORY}.git`;
  const work = mkdtempSync(path.join(tmpdir(), "comforge-npm-release-"));
  try {
    const dir = path.join(work, "release");
    git(work, ["clone", "-q", "--branch", profile.releaseBranch, url, dir]);
    git(dir, ["checkout", "-q", "--detach", commit]);
    const tag = JSON.parse(git(dir, ["show", `${commit}:RELEASE.json`])).tag as string;
    const tagged = git(dir, ["rev-parse", `refs/tags/${tag}^{commit}`]);
    if (tagged !== commit)
      throw new NpmReleaseRefusal("tag-mismatch", `${tag} points at ${tagged}, not ${commit}`);
    return await fn(dir, tag);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

async function planCommand() {
  const commit = arg("--commit") ?? "";
  const out = path.resolve(
    arg("--out") ?? path.join("generated", "npm-release", commit.slice(0, 12)),
  );
  await withRelease(commit, async (dir, tag) => {
    const result = await plan({
      releaseDir: dir,
      commit,
      tag,
      repository: MIRROR_REPOSITORY,
      outDir: out,
      packageName: profile.name,
    });
    console.log(JSON.stringify(result, null, 2));
    const tarball = path.join(out, result.tarball.file);
    console.error(
      `\nplanned ${result.package}@${result.version}: ${tarball}\n  ${result.tarball.integrity}`,
    );
    if (result.registry.bootstrapRequired)
      console.error(
        [
          "",
          `${result.package} is not on the registry yet: the first version is an owner-run bootstrap (no token, no provenance).`,
          "  npm login                      # web login, 2FA",
          `  npm publish ${tarball} --access public   # prompts for 2FA`,
          "  npm logout                     # ends the session token",
          `  bun run release:npm-readback --plan ${path.join(out, "npm-plan.json")}`,
        ].join("\n"),
      );
  });
}

async function readbackCommand() {
  const expectProvenance = argv.includes("--expect-provenance");
  const planFile = arg("--plan");
  const commit = arg("--commit");
  if (!planFile === !commit) throw new Error("readback needs exactly one of --plan or --commit");
  if (planFile) {
    const result = await readback({ planFile: path.resolve(planFile), expectProvenance });
    console.log(JSON.stringify(result, null, 2));
    if (!result.pass) process.exitCode = 1;
    return;
  }
  await withRelease(commit ?? "", async (dir, tag) => {
    const { expectation } = releaseExpectation({
      releaseDir: dir,
      commit,
      tag,
      repository: MIRROR_REPOSITORY,
      packageName: profile.name,
    });
    const result = await readback({ plan: expectation, expectProvenance });
    console.log(JSON.stringify(result, null, 2));
    if (!result.pass) {
      process.exitCode = 1;
      return;
    }
    const pinDir = arg("--write-pin");
    if (!pinDir) return;
    const integrity = result.checks.find((c) => c.check === "registry-integrity")?.detail ?? "";
    mkdirSync(pinDir, { recursive: true });
    // RELEASE.json byte for byte: its digest is the pin's link to the Git release.
    copyFileSync(path.join(dir, "RELEASE.json"), path.join(pinDir, "RELEASE.json"));
    const pin = {
      schema: PIN_SCHEMA,
      package: expectation.package,
      version: expectation.version,
      registry: "https://registry.npmjs.org",
      integrity: integrity.split(" ")[0],
      provenance: expectProvenance ? "verified" : "not required",
      gitRelease: expectation.gitRelease,
      manifest: expectation.manifest,
      files: expectation.files,
    };
    writeFileSync(path.join(pinDir, "npm-pin.json"), `${JSON.stringify(pin, null, 2)}\n`);
    console.error(`pin written: ${path.join(pinDir, "npm-pin.json")}`);
  });
}

if (import.meta.main) {
  const command = argv[0];
  (command === "plan"
    ? planCommand()
    : command === "readback"
      ? readbackCommand()
      : Promise.reject(new Error("usage: npm-release.ts plan|readback"))
  ).catch((error: Error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
