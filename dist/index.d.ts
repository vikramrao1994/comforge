/**
 * @comforge/mcp: the @comforge/cli lifecycle as an MCP server, for local stdio and
 * Streamable HTTP. Embed it with `createComforgeMcpServer`, `serveStdio` or
 * `createHttpHandler`; run it locally with the `comforge-mcp` executable.
 */
export { CAPABILITIES_SCHEMA, ERROR_SCHEMA, GrantEnvelope, INPUTS, LIMITS, PROFILES, type Principal, PrincipalSchema, type Profile, RESULT_SCHEMA, TOOL_NAMES, TOOLS, type ToolContract, type ToolName, } from "./contracts.ts";
export { type AuditEvent, assertBindings, type HostServices, type IsolationProvider, type RepositoryBinding, trustedConfig, } from "./host.ts";
export { createHttpHandler, DEFAULT_HTTP_LIMITS, type HttpHandler, type HttpLimits, type HttpOptions, } from "./http.ts";
export { MCP_CODES, type McpError, type ToolSuccess } from "./results.ts";
export { type ComforgeMcpOptions, createComforgeMcpServer, discoverableTools, permitted, } from "./server.ts";
export { type StdioOptions, serveStdio } from "./stdio.ts";
export { SERVER_NAME, SERVER_VERSION } from "./tools.ts";
