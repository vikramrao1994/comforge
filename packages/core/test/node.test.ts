import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createSpecificationProtocol } from "../src/index.ts";

// The kernel must load in plain Node (type stripping, no loader, no bundler, no
// path aliases) and produce the same bytes as Bun. Node strips TypeScript types
// by default from 22.18 and 23.6. Where no such Node is on PATH the comparison
// cannot run, and the test says so by name instead of passing.

const PACKAGE_ROOT = resolve(import.meta.dir, "..");
const CONFIG = {
  digestScheme: "example-engineering-spec/v1",
  markerNamespace: "example-mcp",
  publisherName: "Example MCP",
  publishToolName: "create_specification",
};
const SPEC = { ticketId: "DEMO-TICKET-001", title: " Démo ", body: "## Objective\r\nCafé  \n" };

function nodeWithTypeStripping(): string | null {
  const probe = spawnSync("node", ["-p", "process.versions.node"], { encoding: "utf8" });
  if (probe.status !== 0) return null;
  const [major = 0, minor = 0] = probe.stdout.trim().split(".").map(Number);
  return major > 23 || (major === 23 && minor >= 6) || (major === 22 && minor >= 18)
    ? probe.stdout.trim()
    : null;
}

const nodeVersion = nodeWithTypeStripping();
// Only PATH (and NODE_ENV): the child must not inherit the test runner's configuration.
const MINIMAL_ENV: NodeJS.ProcessEnv = { NODE_ENV: "test", PATH: process.env.PATH ?? "" };

describe("factory-core under Node", () => {
  test.skipIf(nodeVersion === null)(
    `loads and computes Bun-identical results in Node ${nodeVersion ?? "(no Node >= 22.18 on PATH)"}`,
    () => {
      const script = `
        const kernel = await import(${JSON.stringify(pathToFileURL(join(PACKAGE_ROOT, "src", "index.ts")).href)});
        const protocol = kernel.createSpecificationProtocol(${JSON.stringify(CONFIG)});
        const spec = ${JSON.stringify(SPEC)};
        const digest = protocol.specificationDigest(spec);
        const body = protocol.composeIssueBody({ ticketId: spec.ticketId, body: spec.body, digest, keyDigest: kernel.idempotencyKeyDigest("k") });
        process.stdout.write(JSON.stringify({ digest, body, verification: protocol.verifyPublishedSpecification({ title: spec.title, body }) }));
      `;
      const result = spawnSync("node", ["--input-type=module", "-e", script], {
        encoding: "utf8",
        env: MINIMAL_ENV,
      });
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);

      const protocol = createSpecificationProtocol(CONFIG);
      const digest = protocol.specificationDigest(SPEC);
      const body = protocol.composeIssueBody({
        ticketId: SPEC.ticketId,
        body: SPEC.body,
        digest,
        keyDigest: "",
      });
      const fromNode = JSON.parse(result.stdout) as {
        digest: string;
        body: string;
        verification: unknown;
      };
      expect(fromNode.digest).toBe(digest);
      expect(fromNode.body.split("<!-- example-mcp:engineering-spec")[0]).toBe(
        body.split("<!-- example-mcp:engineering-spec")[0],
      );
      expect(fromNode.verification).toEqual(
        protocol.verifyPublishedSpecification({ title: SPEC.title, body: fromNode.body }),
      );
    },
  );

  // The published release is installed in harness/ (outside the workspace), never as a candidate.
  const HARNESS = resolve(PACKAGE_ROOT, "..", "..", "harness");
  test.skipIf(
    nodeVersion === null || !existsSync(resolve(HARNESS, "node_modules", "@comforge", "core")),
  )("Node also resolves the package by name, from the release the repository installs", () => {
    const result = spawnSync(
      "node",
      [
        "--input-type=module",
        "-e",
        'const k = await import("@comforge/core"); process.stdout.write(typeof k.createSpecificationProtocol);',
      ],
      {
        encoding: "utf8",
        cwd: HARNESS,
        env: MINIMAL_ENV,
      },
    );
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("function");
  });
});
