/**
 * Tool handlers: each one calls the published @comforge/cli lifecycle services or the
 * published @comforge/github evidence reads, and shapes the answer summary-first.
 *
 * No handler reimplements governance, persistence or lifecycle logic, shells out to the
 * `comforge` executable or parses its output. Authorization of writes stays inside
 * @comforge/cli (trusted configuration, owner grants or operator mode); a handler cannot
 * pass `authorized`, a path, a URL or a credential through.
 */
import { type Runtime } from "@comforge/cli";
import type { z } from "zod";
import { type INPUTS, type Principal, type ToolName } from "./contracts.ts";
import { type HostServices, type RemoteHost, type RemoteRepositoryBinding, type RepositoryBinding } from "./host.ts";
import { type McpError, type ToolSuccess } from "./results.ts";
export declare const SERVER_NAME = "comforge-mcp";
/**
 * Reported as `serverInfo.version`. A literal on purpose: a bundler cannot resolve a runtime
 * read of package.json. test/version.test.ts fails when it differs from package.json.
 */
export declare const SERVER_VERSION = "0.3.0";
export interface CallContext {
    principal: Principal;
    binding: RepositoryBinding | null;
    /** A checkout-free repository (0.2.0); `binding` and `rt` are null for it. */
    remote?: RemoteRepositoryBinding | null;
    remoteHost?: RemoteHost | null;
    /** The runtime for this call: the host's, or the isolation provider's for execution. */
    rt: Runtime | null;
    host: HostServices;
    signal: AbortSignal;
    transport: "stdio" | "http";
    /** Every credential value seen during the call, for redaction. */
    secrets: string[];
    /** Static facts capabilities reports. */
    server: {
        bindings: readonly RepositoryBinding[];
        /** 0.2.0; absent means none. */
        remoteBindings?: readonly RemoteRepositoryBinding[];
        executionAvailable: boolean;
        isolation: string | null;
        tools: readonly ToolName[];
    };
}
export type HandlerOutcome = ToolSuccess | McpError;
type Input<N extends ToolName> = z.infer<(typeof INPUTS)[N]>;
/**
 * The tools a checkout-free repository serves: GitHub evidence reads under a host-supplied
 * trusted configuration. Nothing that runs commands, reads lifecycle state or writes.
 */
export declare const REMOTE_READ_TOOLS: readonly ToolName[];
export declare const HANDLERS: {
    [N in ToolName]: (c: CallContext, input: Input<N>) => Promise<HandlerOutcome>;
};
export {};
