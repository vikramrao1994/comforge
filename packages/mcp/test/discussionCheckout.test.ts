import { afterEach, describe, expect, test } from "bun:test";
import { createSpecificationProtocol } from "@comforge/core";
import { baseConfig, connect, createWorld, principal, SPEC, type World } from "./harness.ts";

// comforge_publish_comment through a checkout (stdio, the CLI's lifecycle services): the same
// command the checkout-free host runs, under the checkout's own authorization.

let world: World;
afterEach(() => world?.dispose());

const DISCUSSION = {
  scheme: "acme-issue-comment/v1",
  markerNamespace: "acme-spec",
  publisherName: "Acme Specs",
  publishToolName: "acme_comment",
};
const credentials = { source: "env", variable: "ACME_TOKEN" };
const config = (authorization: unknown) =>
  baseConfig({
    discussion: DISCUSSION,
    security: { credentials, authorization, capabilities: ["issues:create", "issues:comment"] },
  });

function seedSpecification(w: World) {
  const spec = createSpecificationProtocol({ ...SPEC });
  const body = "## Objective\nShip it.";
  const digest = spec.specificationDigest({ ticketId: "ACME-1", title: "Ship it", body });
  return w.gh.seedIssue({
    title: "Ship it",
    body: spec.composeIssueBody({ ticketId: "ACME-1", body, digest, keyDigest: "b".repeat(32) }),
  });
}

describe("discussion comments through a checkout", () => {
  test("operator mode publishes once and replays by key", async () => {
    world = createWorld({ config: config({ mode: "operator" }) });
    const issue = seedSpecification(world);
    const s = await connect({
      repositories: [world.binding],
      host: world.host(),
      principal: principal(["publisher"]),
      transport: "stdio",
    });
    const args = {
      repository: world.binding.id,
      issue: issue.number,
      body: "Agreed.",
      idempotencyKey: "checkout-key-000001",
      execute: true,
    };
    const first = await s.call("comforge_publish_comment", args);
    expect(first.isError).toBe(false);
    expect(first.body.data.action).toBe("created");
    expect(first.body.data.authorization).toEqual({ mode: "operator" });
    const again = await s.call("comforge_publish_comment", args);
    expect(again.body.data.action).toBe("replayed");
    expect([...world.gh.comments.values()].filter((c) => c.issue === issue.number)).toHaveLength(1);
    await s.close();
  });

  test("owner-grant repositories refuse discussion comments: no grant can be scoped to one", async () => {
    world = createWorld({
      config: config({
        mode: "owner-grant",
        grantScheme: "acme-grant/v1",
        trustedKeys: [
          {
            keyId: "0123456789abcdef",
            publicKeyPem:
              "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAGb9ECWmEzf6FQbrBZ9w7lshQhqowtrbLDFw4rXAxZuE=\n-----END PUBLIC KEY-----\n",
            label: "owner",
          },
        ],
      }),
    });
    const issue = seedSpecification(world);
    const s = await connect({
      repositories: [world.binding],
      host: world.host(),
      principal: principal(["publisher"]),
      transport: "stdio",
    });
    const out = await s.call("comforge_publish_comment", {
      repository: world.binding.id,
      issue: issue.number,
      body: "Agreed.",
      idempotencyKey: "checkout-key-000002",
      execute: true,
    });
    expect(out.isError).toBe(true);
    expect(out.body.code).toBe("authorization-required");
    expect(world.gh.writes()).toHaveLength(0);
    await s.close();
  });
});
