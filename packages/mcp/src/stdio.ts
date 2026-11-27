/**
 * Local stdio: the trust boundary is the local user. The process that launched the server
 * (an editor or agent on the same machine) is the principal the operator configured; there
 * is no authentication, so the operator chooses the profiles and repositories at launch.
 * Repository commands run in the server's own process environment, as the CLI would.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Principal } from "./contracts.ts";
import type { HostServices, RepositoryBinding } from "./host.ts";
import { createComforgeMcpServer } from "./server.ts";

export interface StdioOptions {
  repositories: readonly RepositoryBinding[];
  host: HostServices;
  principal: Principal;
  compactDiscovery?: boolean;
  textContent?: "full" | "summary";
}

export async function serveStdio(options: StdioOptions): Promise<McpServer> {
  const server = createComforgeMcpServer({ ...options, transport: "stdio" });
  await server.connect(new StdioServerTransport());
  return server;
}
