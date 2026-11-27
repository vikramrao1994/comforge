/**
 * What the host gives the server, and the repository allowlist.
 *
 * Trust boundary: the host owns credentials, the runtime that runs repository commands, the
 * state store and the principal. A caller supplies none of them: it names an allowlisted
 * repository id, and the server resolves everything else from the host and from the
 * repository's trusted configuration (its base branch, never the working tree).
 */
import { createHash } from "node:crypto";
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
const SHA40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
/** Refuses malformed remote bindings, and an id used by a local and a remote binding alike. */
export function assertRemoteBindings(remote, local) {
    const seen = new Set(local.map((b) => b.id));
    for (const b of remote) {
        if (!ID.test(b.id))
            throw new Error(`repository id ${JSON.stringify(b.id)} is malformed`);
        if (seen.has(b.id))
            throw new Error(`repository id ${b.id} is listed twice`);
        seen.add(b.id);
        if (!/^[A-Za-z0-9_.-]{1,100}$/.test(b.owner) || !/^[A-Za-z0-9_.-]{1,100}$/.test(b.name))
            throw new Error(`repository ${b.id}: owner and name must be GitHub names`);
        if (b.configSha256 !== undefined && !HEX64.test(b.configSha256))
            throw new Error(`repository ${b.id}: configSha256 must be 64 lowercase hex characters`);
    }
}
export function resolveRemoteBinding(remote, principal, id) {
    const binding = remote.find((b) => b.id === id);
    const allowed = principal.repositories === "*" || principal.repositories.includes(id);
    return binding && allowed ? binding : null;
}
/** The snapshot's own checks: revision shape, age, pin, parse and repository identity. */
export function checkSnapshot(binding, snapshot, now, maxAgeMs) {
    const detail = { repository: binding.id };
    if (!snapshot || typeof snapshot.text !== "string" || typeof snapshot.revision !== "string")
        throw new ToolRefusal("config-missing", "the host supplied no trusted configuration", 2, detail);
    if (!SHA40.test(snapshot.revision))
        throw new ToolRefusal("config-invalid", "the trusted revision is not a full commit SHA", 2, detail);
    if (!Number.isFinite(snapshot.observedAt) ||
        snapshot.observedAt > now + 60_000 ||
        now - snapshot.observedAt > maxAgeMs)
        throw new ToolRefusal("config-stale", "the trusted configuration snapshot is too old", 3, {
            ...detail,
            maxAgeMs,
        });
    if (binding.configSha256 !== undefined && sha256(snapshot.text) !== binding.configSha256)
        throw new ToolRefusal("config-mismatch", "the trusted configuration is not the pinned one", 2, detail);
    let config;
    try {
        config = parseConfig(snapshot.text, "comforge.config.json");
    }
    catch (error) {
        throw new ToolRefusal("config-invalid", "the trusted comforge.config.json is invalid", 2, {
            ...detail,
            reason: error instanceof Error ? error.message.slice(0, 500) : "invalid",
        });
    }
    if (config.repository.owner !== binding.owner || config.repository.name !== binding.name)
        throw new ToolRefusal("repository-mismatch", "the trusted configuration names another repository", 1, detail);
    return config;
}
const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");
