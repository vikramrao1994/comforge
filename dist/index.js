/**
 * @comforge/mcp: the @comforge/cli lifecycle as an MCP server, for local stdio and
 * Streamable HTTP. Embed it with `createComforgeMcpServer`, `serveStdio` or
 * `createHttpHandler`, or compose its tools into an existing server with `registerComforgeTools`;
 * run it locally with the `comforge-mcp` executable.
 */
export { CAPABILITIES_SCHEMA, ERROR_SCHEMA, GrantEnvelope, INPUTS, LIMITS, PROFILES, PrincipalSchema, RESULT_SCHEMA, TOOL_NAMES, TOOLS, } from "./contracts.js";
export { assertBindings, trustedConfig, } from "./host.js";
export { createHttpHandler, DEFAULT_HTTP_LIMITS, } from "./http.js";
export { MCP_CODES } from "./results.js";
export { createComforgeMcpServer, discoverableTools, permitted, registerComforgeTools, SERVER_INSTRUCTIONS, } from "./server.js";
export { serveStdio } from "./stdio.js";
export { REMOTE_GOVERNANCE_TOOLS, REMOTE_READ_TOOLS, SERVER_NAME, SERVER_VERSION, } from "./tools.js";
