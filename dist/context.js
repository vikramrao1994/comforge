import { existsSync } from "node:fs";
import { readWorkingConfig } from "./config.js";
import { fail } from "./errors.js";
import { openGitHub } from "./github.js";
import { locateRepository, trustedConfigAt } from "./repository.js";
import { openState } from "./state.js";
export function openContext(rt) {
    const repo = locateRepository(rt);
    let working = null;
    const access = new Map();
    return {
        rt,
        repo,
        state: openState(repo.commonDir),
        working: () => {
            working ??= readWorkingConfig(repo.root);
            return working;
        },
        github: (trusted) => {
            const key = JSON.stringify(trusted.repository) + JSON.stringify(trusted.security);
            let a = access.get(key);
            if (!a) {
                a = openGitHub(rt, trusted, repo.commonDir);
                access.set(key, a);
            }
            return a;
        },
    };
}
/** An initiative's record and the trusted configuration it started from. */
export async function loadInitiative(ctx, id) {
    const record = await ctx.state.get(id);
    if (!record)
        return fail("not-found", `${id} has no local state; run comforge start ${id}`, {
            initiative: id,
        });
    if (record.cleanedAt)
        fail("stale", `${id} was cleaned up at ${record.cleanedAt}`, { initiative: id });
    const { config, digest } = trustedConfigAt(ctx.rt, ctx.repo.root, record.base.sha);
    if (digest !== record.trustedConfig)
        fail("conflict", "the trusted configuration at the recorded base no longer matches the record", {
            initiative: id,
        });
    return { record, trusted: config };
}
export function requireCheckout(record) {
    if (!existsSync(record.checkout))
        fail("not-found", `the checkout ${record.checkout} is missing`, { checkout: record.checkout });
    return record.checkout;
}
