/**
 * What the host gives the server, and the repository allowlist.
 *
 * Trust boundary: the host owns credentials, the runtime that runs repository commands, the
 * state store and the principal. A caller supplies none of them: it names an allowlisted
 * repository id, and the server resolves everything else from the host and from the
 * repository's trusted configuration (its base branch, never the working tree).
 */
import { parseConfig, } from "@comforge/cli";
import { ToolRefusal } from "./results.js";
const ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
/** Refuses an allowlist with duplicate or malformed ids, or relative paths. */
export function assertBindings(bindings) {
    const seen = new Set();
    for (const b of bindings) {
        if (!ID.test(b.id))
            throw new Error(`repository id ${JSON.stringify(b.id)} is malformed`);
        if (seen.has(b.id))
            throw new Error(`repository id ${b.id} is listed twice`);
        seen.add(b.id);
        if (!b.root.startsWith("/"))
            throw new Error(`repository ${b.id}: root must be absolute`);
        if (b.commonDir && !b.commonDir.startsWith("/"))
            throw new Error(`repository ${b.id}: commonDir must be absolute`);
    }
}
export function resolveBinding(bindings, principal, id) {
    const binding = bindings.find((b) => b.id === id);
    const allowed = principal.repositories === "*" || principal.repositories.includes(id);
    // The same refusal whether the id is unknown or not the principal's: no allowlist probing.
    if (!binding || !allowed)
        throw new ToolRefusal("unknown-repository", `no repository ${id} for this principal`, 1, {
            repository: id,
        });
    return binding;
}
export const repositoryOf = (b) => ({
    root: b.root,
    commonDir: b.commonDir ?? `${b.root}/.git`,
});
/**
 * The configuration at the base branch's remote-tracking ref: what @comforge/cli trusts.
 * The working tree's copy is ignored. It must name the binding's repository.
 */
export function trustedConfig(rt, binding) {
    const read = (ref) => rt.run("git", ["show", `${ref}:comforge.config.json`], {
        cwd: binding.root,
        timeoutMs: 15_000,
    });
    // The base branch comes from the committed configuration itself, read at origin's HEAD
    // first; a repository without one is refused like the CLI refuses it.
    let r = read("refs/remotes/origin/HEAD");
    if (r.status !== 0)
        r = read("refs/remotes/origin/main");
    if (r.status !== 0)
        throw new ToolRefusal("config-missing", "the repository has no trusted comforge.config.json", 2, {
            repository: binding.id,
        });
    let config;
    try {
        config = parseConfig(r.stdout, "comforge.config.json");
    }
    catch (error) {
        throw new ToolRefusal("config-invalid", "the trusted comforge.config.json is invalid", 2, {
            repository: binding.id,
            reason: error instanceof Error ? error.message.slice(0, 500) : "invalid",
        });
    }
    const base = `refs/remotes/${config.repository.remote}/${config.repository.baseBranch}`;
    const atBase = read(base);
    if (atBase.status === 0 && atBase.stdout !== r.stdout)
        config = parseConfig(atBase.stdout, "comforge.config.json");
    if (config.repository.owner !== binding.owner || config.repository.name !== binding.name)
        throw new ToolRefusal("repository-mismatch", "the trusted configuration names another repository", 1, {
            repository: binding.id,
        });
    return config;
}
