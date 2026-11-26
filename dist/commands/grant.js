import { readFileSync } from "node:fs";
import { grantProtocol, grantTemplate, signGrant } from "../authorization.js";
import { loadInitiative, requireCheckout } from "../context.js";
import { fail } from "../errors.js";
import { git } from "../runtime.js";
/**
 * Owner grants for `security.authorization.mode: owner-grant`.
 * `template` prints an unsigned grant for the initiative's current head, to review.
 * `sign` signs one with an Ed25519 private key: run it on the owner's machine; an agent that can
 * read the key can authorize itself, which no command here can prevent.
 */
export const grantCommand = {
    async template(ctx, options) {
        const { record, trusted } = await loadInitiative(ctx, options.id);
        const head = git(ctx.rt, requireCheckout(record), ["rev-parse", "HEAD"]);
        return {
            result: grantTemplate(trusted, record, head, ctx.rt.now(), options.hours),
        };
    },
    async sign(ctx, options) {
        const { record, trusted } = await loadInitiative(ctx, options.id);
        let grant;
        let key;
        try {
            grant = JSON.parse(readFileSync(options.grantFile, "utf8"));
            key = readFileSync(options.keyFile, "utf8");
        }
        catch {
            return fail("usage", "--grant must be a JSON file and --key a PEM private key file");
        }
        return {
            result: signGrant(grantProtocol(trusted, record), grant, key),
        };
    },
};
