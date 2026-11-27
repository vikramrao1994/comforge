import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type Principal, type ToolName } from "./contracts.ts";
import { type HostServices, type IsolationProvider, type RepositoryBinding } from "./host.ts";
export interface ComforgeMcpOptions {
    repositories: readonly RepositoryBinding[];
    host: HostServices;
    principal: Principal;
    transport: "stdio" | "http";
    /** Required for executing tools over HTTP. Ignored on stdio, where the local user runs them. */
    isolation?: IsolationProvider;
    /**
     * Leave the per-tool output schemas out of discovery. Results keep the same versioned
     * envelope (`schema: "comforge-mcp/v1"`, documented and exported as RESULT_SCHEMA); a
     * client that validates structured output should leave this off.
     */
    compactDiscovery?: boolean;
    /**
     * What a successful result's text content carries. "full" (default): the result JSON, for
     * clients that read only text. "summary": the one-line summary and a pointer to the
     * structured content, so a client that gives the model structuredContent does not pay for
     * the same result twice. Errors always carry their full JSON (they have no structured content).
     */
    textContent?: "full" | "summary";
}
export declare function permitted(principal: Principal, tool: ToolName): boolean;
/** The tools a principal discovers on a transport. */
export declare function discoverableTools(principal: Principal, transport: "stdio" | "http", isolation?: IsolationProvider): ToolName[];
/** A provider is code the host wires in; anything else is a configuration error. */
export declare function assertIsolation(isolation: IsolationProvider): void;
export declare function createComforgeMcpServer(options: ComforgeMcpOptions): McpServer;
