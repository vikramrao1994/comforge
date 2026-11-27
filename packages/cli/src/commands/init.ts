import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CONFIG_FILE, CONFIG_SCHEMA, type ConfigInput, parseConfig } from "../config.ts";
import { EXIT, fail } from "../errors.ts";
import { canonical, stableJson } from "../json.ts";
import { locateRepository } from "../repository.ts";
import { gitRun, type Runtime } from "../runtime.ts";
import type { CommandResult } from "./lifecycle.ts";

/**
 * `comforge init`: detects a repository's conventions and proposes the smallest
 * configuration that works. It previews by default; `--write` writes one file,
 * `comforge.config.json`, and only when it does not exist (or, with `--force`, the owner's
 * explicit consent to replace it). It never writes a credential, a permission, a hook or a
 * GitHub setting, and it changes nothing on a rerun with the same inputs.
 *
 * Anything it cannot detect is written so that it fails closed: an unknown test command
 * becomes a validation command that fails with an instruction, so nothing is published
 * unvalidated until someone configures it.
 */

interface Detection {
  repository: { owner: string; name: string } | null;
  baseBranch: string;
  remote: string;
  validation: { name: string; run: string[] }[];
  provision: string[][];
  reportDir: string;
  notes: string[];
}

const exists = (root: string, file: string) => existsSync(path.join(root, file));

function detect(rt: Runtime, root: string): Detection {
  const notes: string[] = [];
  const remotes = gitRun(rt, root, ["remote"]).stdout.split("\n").filter(Boolean);
  const remote = remotes.includes("origin") ? "origin" : (remotes[0] ?? "origin");
  const url = gitRun(rt, root, ["config", "--get", `remote.${remote}.url`]).stdout.trim();
  const m = /github\.com[:/]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(url);
  const repository = m ? { owner: m[1] as string, name: m[2] as string } : null;
  if (!repository)
    notes.push(
      `no GitHub remote detected (${remote}: ${url || "none"}); set repository.owner and repository.name`,
    );
  const head = gitRun(rt, root, [
    "symbolic-ref",
    "--quiet",
    "--short",
    `refs/remotes/${remote}/HEAD`,
  ]).stdout.trim();
  const current = gitRun(rt, root, ["symbolic-ref", "--quiet", "--short", "HEAD"]).stdout.trim();
  const baseBranch = head ? head.slice(remote.length + 1) : current || "main";

  const validation: Detection["validation"] = [];
  const provision: string[][] = [];
  const pkg = exists(root, "package.json")
    ? (JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as {
        scripts?: Record<string, string>;
      })
    : null;
  if (pkg) {
    const pm =
      exists(root, "bun.lock") || exists(root, "bun.lockb")
        ? "bun"
        : exists(root, "pnpm-lock.yaml")
          ? "pnpm"
          : exists(root, "yarn.lock")
            ? "yarn"
            : "npm";
    provision.push(
      pm === "npm"
        ? exists(root, "package-lock.json")
          ? ["npm", "ci"]
          : ["npm", "install"]
        : pm === "yarn"
          ? ["yarn", "install", "--frozen-lockfile"]
          : [pm, "install", "--frozen-lockfile"],
    );
    for (const script of ["lint", "typecheck", "test"])
      if (pkg.scripts?.[script]) validation.push({ name: script, run: [pm, "run", script] });
  } else if (exists(root, "Cargo.toml")) validation.push({ name: "test", run: ["cargo", "test"] });
  else if (exists(root, "go.mod")) validation.push({ name: "test", run: ["go", "test", "./..."] });
  else if (exists(root, "pyproject.toml") || exists(root, "pytest.ini"))
    validation.push({ name: "test", run: ["python3", "-m", "pytest"] });
  else if (
    exists(root, "Makefile") &&
    /^test:/m.test(readFileSync(path.join(root, "Makefile"), "utf8"))
  )
    validation.push({ name: "test", run: ["make", "test"] });
  if (validation.length === 0) {
    notes.push(
      "no test command detected; validation fails closed until validation.commands is configured",
    );
    validation.push({
      name: "configure-validation",
      run: ["sh", "-c", `echo "configure validation.commands in ${CONFIG_FILE}" >&2; exit 1`],
    });
  }
  const reportDir = exists(root, "docs") ? "docs/comforge" : "comforge-reports";
  return { repository, baseBranch, remote, validation, provision, reportDir, notes };
}

export function proposedConfig(d: Detection): ConfigInput {
  return {
    schema: CONFIG_SCHEMA,
    repository: {
      owner: d.repository?.owner ?? "OWNER",
      name: d.repository?.name ?? "REPOSITORY",
      baseBranch: d.baseBranch,
      remote: d.remote,
    },
    checkout: { provision: d.provision },
    validation: { commands: d.validation },
    evidence: { reportDir: d.reportDir },
  };
}

export function init(rt: Runtime, options: { write: boolean; force: boolean }): CommandResult {
  const repo = locateRepository(rt);
  const detection = detect(rt, repo.root);
  const config = proposedConfig(detection);
  const text = stableJson(config);
  parseConfig(text, "the proposed configuration"); // never propose what the schema refuses
  const file = path.join(repo.root, CONFIG_FILE);
  const current = existsSync(file) ? readFileSync(file, "utf8") : null;
  const same = (() => {
    if (current === null) return false;
    try {
      return (
        canonical(parseConfig(current, CONFIG_FILE)) === canonical(parseConfig(text, CONFIG_FILE))
      );
    } catch {
      return false;
    }
  })();
  const state = current === null ? "absent" : same ? "unchanged" : "different";
  const base = {
    schema: "comforge-init/v1",
    file: CONFIG_FILE,
    state,
    notes: detection.notes,
    content: config,
  };
  if (!options.write)
    return {
      result: {
        ...base,
        written: false,
        next: state === "unchanged" ? [] : ["review the content, then rerun with --write"],
      },
    };
  if (state === "unchanged") return { result: { ...base, written: false } };
  if (state === "different" && !options.force)
    fail(
      "would-overwrite",
      `${CONFIG_FILE} exists and differs; review the preview and pass --force to replace it`,
      { file: CONFIG_FILE },
    );
  if (!detection.repository)
    return {
      result: {
        ...base,
        written: false,
        next: ["set repository.owner and repository.name, then rerun"],
      },
      exit: EXIT.refused,
    };
  writeFileSync(file, text, { flag: state === "absent" ? "wx" : "w" });
  return {
    result: {
      ...base,
      written: true,
      next: [
        `commit ${CONFIG_FILE} and merge it to ${detection.baseBranch}: start and publish trust only the committed base`,
        "comforge doctor",
        "GitHub writes stay refused until the owner sets security.authorization (owner-grant or operator) on the base branch",
        "set the credential the configuration names (GITHUB_TOKEN by default) only where GitHub commands run",
      ],
    },
  };
}
