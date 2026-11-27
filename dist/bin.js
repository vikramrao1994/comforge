#!/usr/bin/env node
/**
 * `comforge-mcp`: a local stdio server over one or more repositories.
 *
 *   comforge-mcp [--repository DIR]... [--profile read-only|reviewer|executor|publisher]... [--compact-discovery] [--summary-text]
 *
 * Defaults: the current directory's repository and the read-only profile. The operator
 * chooses both at launch; a caller can never widen them. Credentials come from each
 * repository's trusted `security.credentials` source (an environment variable or `gh`),
 * read by this process and never returned.
 */
import path from "node:path";
import { defaultRuntime, parseConfig } from "@comforge/cli";
import { PROFILES } from "./contracts.js";
import { serveStdio } from "./stdio.js";
function usage(message) {
    process.stderr.write(`comforge-mcp: ${message}\nusage: comforge-mcp [--repository DIR]... [--profile ${PROFILES.join("|")}]... [--compact-discovery] [--summary-text]\n`);
    process.exit(2);
}
const argv = process.argv.slice(2);
if (argv.includes("--help"))
    usage("help");
const compactDiscovery = argv.includes("--compact-discovery");
const summaryText = argv.includes("--summary-text");
const args = argv.filter((a) => a !== "--compact-discovery" && a !== "--summary-text");
const dirs = [];
const profiles = [];
for (let i = 0; i < args.length; i += 2) {
    const [flag, value] = [args[i], args[i + 1]];
    if (!value)
        usage(`${flag} needs a value`);
    if (flag === "--repository")
        dirs.push(path.resolve(value));
    else if (flag === "--profile") {
        if (!PROFILES.includes(value))
            usage(`unknown profile ${value}`);
        profiles.push(value);
    }
    else
        usage(`unknown option ${flag}`);
}
const base = defaultRuntime();
const git = (cwd, ...a) => {
    const r = base.run("git", a, { cwd });
    if (r.status !== 0)
        usage(`${cwd} is not a Git repository`);
    return r.stdout.trim();
};
const bindings = (dirs.length > 0 ? dirs : [process.cwd()]).map((dir) => {
    const root = git(dir, "rev-parse", "--show-toplevel");
    const commonDir = path.resolve(root, git(root, "rev-parse", "--git-common-dir"));
    const shown = base.run("git", ["show", "refs/remotes/origin/HEAD:comforge.config.json"], {
        cwd: root,
    });
    const fallback = shown.status === 0
        ? shown
        : base.run("git", ["show", "refs/remotes/origin/main:comforge.config.json"], { cwd: root });
    if (fallback.status !== 0)
        usage(`${root} has no comforge.config.json on its base branch`);
    const config = parseConfig(fallback.stdout, "comforge.config.json");
    const id = config.repository.name
        .toLowerCase()
        .replace(/[^a-z0-9._-]/g, "-")
        .slice(0, 64);
    return { id, root, commonDir, owner: config.repository.owner, name: config.repository.name };
});
await serveStdio({
    repositories: bindings,
    principal: {
        id: "local",
        profiles: profiles.length > 0 ? profiles : ["read-only"],
        repositories: "*",
    },
    host: { runtime: (b) => ({ ...base, cwd: b.root }) },
    ...(compactDiscovery ? { compactDiscovery: true } : {}),
    ...(summaryText ? { textContent: "summary" } : {}),
});
