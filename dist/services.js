import { complete, deliver, publish, recover } from "./commands/delivery.js";
import { cleanup, revise, start, status, verify, } from "./commands/lifecycle.js";
import { migrate } from "./commands/migrate.js";
import { openContext } from "./context.js";
import { CliError, EXIT } from "./errors.js";
/** A thrown command error as a value; anything that is not a CliError is `internal`. */
export function toServiceError(error) {
    if (error instanceof CliError)
        return { code: error.code, message: error.message, detail: error.detail, exit: error.exit };
    return {
        code: "internal",
        message: error instanceof Error ? error.message : String(error),
        detail: {},
        exit: EXIT.failed,
    };
}
export function createLifecycleServices(options) {
    const { runtime, ...context } = options;
    // A fresh context per call: no state, credential or GitHub access is shared between calls.
    const call = (command) => async (o) => {
        try {
            const ctx = openContext(runtime, context);
            // Stripped at run time too: a JavaScript caller is not held by the types.
            const safe = o !== null && typeof o === "object" && "authorized" in o
                ? (({ authorized: _ignored, ...rest }) => rest)(o)
                : o;
            const { result, exit = EXIT.ok } = await command(ctx, safe);
            return { ok: true, value: result, exit: exit };
        }
        catch (error) {
            return { ok: false, error: toServiceError(error) };
        }
    };
    return {
        start: call(start),
        revise: call(revise),
        status: call(status),
        verify: call(verify),
        publish: call(publish),
        complete: call(complete),
        deliver: call(deliver),
        recover: call(recover),
        cleanup: call(cleanup),
        migrate: call(migrate),
    };
}
