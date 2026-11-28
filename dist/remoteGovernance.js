import { discussionAuthorization, governanceCommands, } from "./commands/governance.js";
import { fail } from "./errors.js";
import { createGitHubAccess } from "./github.js";
import { toServiceError } from "./services.js";
export function createRemoteGovernance(options) {
    const now = options.now ?? Date.now;
    const repository = `${options.config.repository.owner}/${options.config.repository.name}`;
    let access = null;
    const context = {
        trusted: () => options.config,
        github: (trusted) => {
            if (trusted !== options.config)
                fail("config-invalid", "one trusted configuration per host");
            access ??= createGitHubAccess({
                config: trusted,
                token: options.token,
                ledger: options.ledger,
                now,
                ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
                ...(options.markerNamespace ? { markerNamespace: options.markerNamespace } : {}),
            });
            return access;
        },
        authorize: (trusted, request) => hostAuthorization(trusted, request),
        now,
        checkpoint: () => {
            if (options.signal?.aborted)
                fail("cancelled", "the caller cancelled the command", {
                    reason: String(options.signal.reason ?? "aborted"),
                });
        },
    };
    async function hostAuthorization(trusted, request) {
        // Same refusals as a checkout for an absent authorization; owner-grant needs a checkout.
        if (request.context.command === "publish-comment")
            discussionAuthorization(trusted);
        const a = trusted.security.authorization;
        if (!a)
            return fail("authorization-required", "GitHub writes are not authorized in this repository: the trusted configuration sets no security.authorization");
        if (a.mode !== "operator")
            return fail("authorization-required", "this repository authorizes writes with owner grants, which only a checkout-backed host can spend");
        if (request.grantFile !== undefined)
            return fail("usage", "a checkout-free host takes no grant file");
        let decision;
        try {
            decision = await options.authorize({
                command: request.context.command,
                repository,
                principal: options.principal,
                context: { ...request.context },
            });
        }
        catch {
            return fail("unauthorized", "the host's authorization failed");
        }
        if (!decision || decision.allow !== true || typeof decision.authority !== "string")
            return fail("unauthorized", decision && decision.allow === false && typeof decision.reason === "string"
                ? `the host refused this write: ${decision.reason.slice(0, 200)}`
                : "the host refused this write");
        return { mode: "host", authority: decision.authority, principal: options.principal };
    }
    const call = (name) => async (o) => {
        try {
            // Stripped at run time too: a JavaScript caller is not held by the types.
            const { grantFile: _g, authorized: _a, ...safe } = o;
            const command = governanceCommands[name];
            const { result, exit = 0 } = await command(context, safe);
            return { ok: true, value: result, exit };
        }
        catch (error) {
            return { ok: false, error: toServiceError(error) };
        }
    };
    return {
        publishSpecification: call("publishSpecification"),
        publishReview: call("publishReview"),
        publishComment: call("publishComment"),
    };
}
