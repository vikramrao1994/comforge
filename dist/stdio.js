/**
 * Local stdio: the trust boundary is the local user. The process that launched the server
 * (an editor or agent on the same machine) is the principal the operator configured; there
 * is no authentication, so the operator chooses the profiles and repositories at launch.
 * Repository commands run in the server's own process environment, as the CLI would.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createComforgeMcpServer } from "./server.js";
export async function serveStdio(options) {
    const server = createComforgeMcpServer({ ...options, transport: "stdio" });
    await server.connect(new StdioServerTransport());
    return server;
}
