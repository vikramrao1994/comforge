/**
 * @comforge/mcp: the @comforge/cli lifecycle as an MCP server, for local stdio and
 * Streamable HTTP. Embed it with `createComforgeMcpServer`, `serveStdio` or
 * `createHttpHandler`, or compose its tools into an existing server with `registerComforgeTools`;
 * run it locally with the `comforge-mcp` executable.
 */
export {
  CAPABILITIES_SCHEMA,
  ERROR_SCHEMA,
  GrantEnvelope,
  INPUTS,
  LIMITS,
  PROFILES,
  type Principal,
  PrincipalSchema,
  type Profile,
  RESULT_SCHEMA,
  TOOL_NAMES,
  TOOLS,
  type ToolContract,
  type ToolName,
} from "./contracts.ts";
export {
  type AuditEvent,
  assertBindings,
  type HostServices,
  type IsolationProvider,
  type RemoteGovernanceCommand,
  type RemoteGovernanceHost,
  type RemoteHost,
  type RemoteRepositoryBinding,
  type RepositoryBinding,
  type TrustedConfigSnapshot,
  trustedConfig,
} from "./host.ts";
export {
  createHttpHandler,
  DEFAULT_HTTP_LIMITS,
  type HttpHandler,
  type HttpLimits,
  type HttpOptions,
} from "./http.ts";
export { MCP_CODES, type McpError, type ToolSuccess } from "./results.ts";
export {
  type ComforgeMcpOptions,
  createComforgeMcpServer,
  discoverableTools,
  permitted,
  type RegisteredComforgeTools,
  registerComforgeTools,
  SERVER_INSTRUCTIONS,
} from "./server.ts";
export { type StdioOptions, serveStdio } from "./stdio.ts";
export {
  REMOTE_GOVERNANCE_TOOLS,
  REMOTE_READ_TOOLS,
  SERVER_NAME,
  SERVER_VERSION,
} from "./tools.ts";
