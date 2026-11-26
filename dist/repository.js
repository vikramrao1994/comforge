import { createHash } from "node:crypto";
import path from "node:path";
import { CONFIG_FILE, parseConfig, readWorkingConfig, trustedChanges, trustedPart, } from "./config.js";
import { CliError, fail } from "./errors.js";
import { canonical } from "./json.js";
import { git, gitRun } from "./runtime.js";
export function locateRepository(rt, cwd = rt.cwd) {
    const r = gitRun(rt, cwd, ["rev-parse", "--show-toplevel", "--git-common-dir"]);
    if (r.status !== 0)
        fail("usage", `${cwd} is not inside a Git repository`, { cwd });
    const [root, common] = r.stdout.trim().split("\n");
    return { root, commonDir: path.resolve(cwd, common) };
}
export const sha256 = (text) => createHash("sha256").update(text).digest("hex");
/** The trusted configuration: the committed file at `revision`, never the working tree. */
export function trustedConfigAt(rt, root, revision) {
    const r = gitRun(rt, root, ["show", `${revision}:${CONFIG_FILE}`]);
    if (r.status !== 0)
        throw new CliError("config-missing", `${CONFIG_FILE} is not committed at ${revision}; the owner merges it first (comforge init writes it)`, { revision });
    const config = parseConfig(r.stdout, `${CONFIG_FILE} at ${revision.slice(0, 12)}`);
    return { config, digest: sha256(canonical(trustedPart(config))) };
}
/**
 * Refuses publication of a candidate whose working configuration changes a trusted section:
 * repository text cannot grant itself a target, capability, credential, validation or
 * namespace. Returns the candidate's own configuration for its untrusted settings.
 */
export function requireTrustedUnchanged(trusted, checkout) {
    let candidate;
    try {
        candidate = readWorkingConfig(checkout);
    }
    catch (error) {
        if (error instanceof CliError && error.code === "config-missing")
            fail("untrusted-config-change", `the candidate removed ${CONFIG_FILE}`);
        if (error instanceof CliError && error.code === "config-invalid")
            fail("untrusted-config-change", `the candidate's ${CONFIG_FILE} is invalid`, error.detail);
        throw error;
    }
    const changed = trustedChanges(trusted, candidate);
    if (changed.length > 0)
        fail("untrusted-config-change", "the candidate changes trusted configuration; the owner merges such a change outside this initiative", { sections: changed });
    return candidate;
}
const PHASE = /^[a-z0-9][a-z0-9-]{0,31}$/;
export function parseInitiative(id, config) {
    const dot = id.indexOf(".");
    const ticket = dot < 0 ? id : id.slice(0, dot);
    const phase = dot < 0 ? null : id.slice(dot + 1);
    if (!new RegExp(config.tickets.pattern).test(ticket) || ticket.length > 80)
        fail("usage", `${ticket} is not a ticket id (${config.tickets.pattern})`, { ticket });
    if (phase !== null && !PHASE.test(phase))
        fail("usage", `${phase} is not a phase name ([a-z0-9-], at most 32)`, { phase });
    const branch = `${config.tickets.branchPrefix}${ticket.toLowerCase()}${phase ? `.${phase}` : ""}`;
    return { id, ticket, phase, branch };
}
/** The initiative a branch belongs to, or null for any other branch. */
export function initiativeFromBranch(branch, config) {
    if (!branch.startsWith(config.tickets.branchPrefix))
        return null;
    const rest = branch.slice(config.tickets.branchPrefix.length);
    const dot = rest.indexOf(".");
    const ticket = (dot < 0 ? rest : rest.slice(0, dot)).toUpperCase();
    const phase = dot < 0 ? null : rest.slice(dot + 1);
    try {
        const parsed = parseInitiative(phase ? `${ticket}.${phase}` : ticket, config);
        return parsed.branch === branch ? parsed : null;
    }
    catch {
        return null;
    }
}
export function checkoutParent(config, root) {
    return path.resolve(root, config.checkout.parent ?? `../${path.basename(root)}-agents`);
}
export const checkoutDir = (config, root, initiative) => path.join(checkoutParent(config, root), initiative.id.toLowerCase());
/** Fetches `<remote>/<baseBranch>` into the primary and returns its commit. */
export function fetchBase(rt, root, config) {
    const { remote, baseBranch } = config.repository;
    git(rt, root, [
        "fetch",
        "--quiet",
        remote,
        `+refs/heads/${baseBranch}:refs/remotes/${remote}/${baseBranch}`,
    ]);
    return git(rt, root, ["rev-parse", "--verify", `refs/remotes/${remote}/${baseBranch}^{commit}`]);
}
export const repositorySlug = (config) => `${config.repository.owner}/${config.repository.name}`;
