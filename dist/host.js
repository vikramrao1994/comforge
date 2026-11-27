import { existsSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";
import { fail } from "./errors.js";
/** Real path of `p`, through its nearest existing ancestor when it does not exist yet. */
function canonical(p) {
    const abs = path.resolve(p);
    if (existsSync(abs))
        return realpathSync(abs);
    const parent = path.dirname(abs);
    return parent === abs ? abs : path.join(canonical(parent), path.basename(abs));
}
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const safeArg = (a) => typeof a === "string" && a.length > 0 && a.length <= 4096 && !a.includes("\0");
export function resolveHost(policy, primaryRoot) {
    const p = policy ?? {};
    let parent = null;
    if (p.checkoutParent !== undefined) {
        const raw = p.checkoutParent;
        if (typeof raw !== "string" || !path.isAbsolute(raw) || raw.includes("\0"))
            fail("config-invalid", "host checkoutParent must be an absolute path");
        // Canonical, as Git reports checkouts (a symlinked temporary directory, for example).
        parent = canonical(raw);
        const root = canonical(primaryRoot);
        // A checkout inside the primary (or the primary inside the parent's own clone) would let
        // one repository's files reach the other's.
        if (parent === root ||
            parent.startsWith(`${root}${path.sep}`) ||
            parent === path.parse(parent).root)
            fail("config-invalid", "host checkoutParent must be outside the primary checkout and not a filesystem root", {
                checkoutParent: parent,
            });
    }
    for (const [name, fn] of [
        ["prepareCheckout", p.prepareCheckout],
        ["remove", p.remove],
    ])
        if (fn !== undefined && typeof fn !== "function")
            fail("config-invalid", `host ${name} must be a function`);
    let validation = null;
    if (p.validation !== undefined) {
        if (!Array.isArray(p.validation) || p.validation.length === 0 || p.validation.length > 32)
            fail("config-invalid", "host validation must list 1–32 commands");
        validation = p.validation.map((c) => {
            if (!c || typeof c.name !== "string" || !NAME.test(c.name))
                return fail("config-invalid", "a host validation command needs a simple name");
            if (!Array.isArray(c.run) || c.run.length === 0 || c.run.length > 64 || !c.run.every(safeArg))
                return fail("config-invalid", `host validation ${c.name} must be an argv array`);
            // argv, never a shell string: no word splitting, no interpolation of candidate text.
            return { name: c.name, run: [...c.run] };
        });
        if (new Set(validation.map((c) => c.name)).size !== validation.length)
            fail("config-invalid", "host validation command names must be unique");
    }
    return {
        checkoutParent: parent,
        prepares: p.prepareCheckout !== undefined,
        prepareCheckout: p.prepareCheckout ?? (() => { }),
        remove: p.remove ?? ((dir) => rmSync(dir, { recursive: true, force: true })),
        validation,
    };
}
