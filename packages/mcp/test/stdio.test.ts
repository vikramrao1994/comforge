import { afterEach, describe, expect, test } from "bun:test";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createWorld, type World } from "./harness.ts";

// The `comforge-mcp` executable over real stdio: the operator picks repositories and
// profiles at launch, the server resolves the repository identity from the trusted config.

let world: World;
afterEach(() => world?.dispose());
const BIN = path.join(import.meta.dir, "..", "src", "bin.ts");

async function launch(args: string[]) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [BIN, ...args],
    env: { ...world.env },
    stderr: "pipe",
  });
  const client = new Client({ name: "stdio-test", version: "0" });
  await client.connect(transport);
  return client;
}

describe("comforge-mcp over stdio", () => {
  test("defaults to read-only and names the repository by its configured name", async () => {
    world = createWorld();
    const client = await launch(["--repository", world.primary]);
    const tools = (await client.listTools()).tools.map((t) => t.name);
    expect(tools).toContain("comforge_status");
    expect(tools).not.toContain("comforge_start");
    const r = await client.callTool({ name: "comforge_capabilities", arguments: {} });
    const body = JSON.parse((r.content as { text: string }[])[0]?.text ?? "{}");
    expect(body.data.repositories).toEqual(["widgets"]);
    expect(body.data.principal).toEqual({ id: "local", profiles: ["read-only"] });
    expect(body.data.execution.available).toBe(true);
    const status = await client.callTool({
      name: "comforge_status",
      arguments: { repository: "widgets" },
    });
    expect(
      JSON.parse((status.content as { text: string }[])[0]?.text ?? "{}").data.initiatives,
    ).toEqual([]);
    await client.close();
  });

  test("profiles chosen at launch widen discovery; unknown options refuse to start", async () => {
    world = createWorld();
    const client = await launch(["--repository", world.primary, "--profile", "executor"]);
    const tools = (await client.listTools()).tools.map((t) => t.name);
    expect(tools).toContain("comforge_verify");
    expect(tools).not.toContain("comforge_deliver");
    await client.close();
    const bad = Bun.spawnSync([process.execPath, BIN, "--profile", "root"], {
      env: world.env,
      cwd: world.primary,
    });
    expect(bad.exitCode).toBe(2);
    expect(bad.stderr.toString()).toContain("unknown profile");
  });
});
