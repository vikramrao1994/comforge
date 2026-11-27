import { describe, expect, test } from "bun:test";
import {
  canonicalBody,
  canonicalTitle,
  createSpecificationProtocol,
  idempotencyKeyDigest,
  type SpecificationProtocolConfig,
} from "../src/index.ts";

// The kernel under a neutral publisher identity. Issues published under a consumer's own
// identity are frozen in that consumer's tests.

const CONFIG: SpecificationProtocolConfig = {
  digestScheme: "example-engineering-spec/v1",
  markerNamespace: "example-mcp",
  publisherName: "Example MCP",
  publishToolName: "create_specification",
};
const protocol = createSpecificationProtocol(CONFIG);
const SPEC = { ticketId: "DEMO-TICKET-001", title: "Demo", body: "## Objective\r\nShip it  \n\n" };

function publish(spec = SPEC, key = "demo-key") {
  const digest = protocol.specificationDigest(spec);
  const body = protocol.composeIssueBody({
    ticketId: spec.ticketId,
    body: spec.body,
    digest,
    keyDigest: idempotencyKeyDigest(key),
  });
  return { digest, body };
}

describe("identity-free primitives", () => {
  test("canonicalization is independent of any configuration", () => {
    expect(canonicalTitle(" é ")).toBe("é");
    expect(canonicalBody("\n\nA  \r\nB\t\r\rC\n\n")).toBe("A\nB\n\nC");
    expect(idempotencyKeyDigest("demo-key")).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("a configured protocol", () => {
  test("derives its delimiters, marker and reserved prefix from the namespace", () => {
    const { body, digest } = publish();
    expect(protocol.reservedMarkerPrefix).toBe("example-mcp:");
    expect(body).toContain(
      "<!-- example-mcp:spec-begin -->\n## Objective\nShip it\n<!-- example-mcp:spec-end -->",
    );
    expect(body.split("\n").at(-1)).toBe(
      `<!-- example-mcp:engineering-spec v1 ticket=DEMO-TICKET-001 digest=${digest} key=${idempotencyKeyDigest("demo-key")} -->`,
    );
    expect(body).toContain("published via Example MCP `create_specification`");
    expect(protocol.executionNotAuthorized).toContain("that the Example MCP cannot grant.");
  });

  test("the digest is domain-separated by the scheme", () => {
    const other = createSpecificationProtocol({
      ...CONFIG,
      digestScheme: "example-engineering-spec/v2",
    });
    expect(other.specificationDigest(SPEC)).not.toBe(protocol.specificationDigest(SPEC));
  });

  test("a published issue verifies, and edits to its title or delimited text are detected", () => {
    const { body, digest } = publish();
    expect(protocol.verifyPublishedSpecification({ title: " Demo ", body })).toEqual({
      ticketId: "DEMO-TICKET-001",
      digest,
      digestScheme: "example-engineering-spec/v1",
      digestMatches: true,
    });
    expect(protocol.verifyPublishedSpecification({ title: "Demo!", body })?.digestMatches).toBe(
      false,
    );
    expect(
      protocol.verifyPublishedSpecification({
        title: "Demo",
        body: body.replace("Ship it", "Ship it now"),
      })?.digestMatches,
    ).toBe(false);
  });

  test("another publisher's markers are not recognised", () => {
    const otherPublisher = createSpecificationProtocol({ ...CONFIG, markerNamespace: "other-mcp" });
    const { body } = publish();
    expect(otherPublisher.parsePublishedMarker(body)).toBeNull();
    expect(otherPublisher.verifyPublishedSpecification({ title: "Demo", body })).toBeNull();
    expect(otherPublisher.extractSpecificationBody(body)).toBeNull();
  });

  test("the marker grammar is fixed: lowercase tickets, uppercase hex and wrong lengths are not markers", () => {
    const { body, digest } = publish();
    const key = idempotencyKeyDigest("demo-key");
    for (const forged of [
      body.replace("ticket=DEMO-TICKET-001", "ticket=demo-ticket-001"),
      body.replace(`digest=${digest}`, `digest=${digest.toUpperCase()}`),
      body.replace(`key=${key}`, `key=${key}0`),
      body.replace(" v1 ticket=", " v9 ticket="),
    ]) {
      expect(protocol.parsePublishedMarker(forged)).toBeNull();
    }
  });

  test("the protocol object is frozen, and its functions work detached", () => {
    expect(Object.isFrozen(protocol)).toBe(true);
    const { specificationDigest, verifyPublishedSpecification } = protocol;
    const { body } = publish();
    expect(specificationDigest(SPEC)).toBe(protocol.specificationDigest(SPEC));
    expect(verifyPublishedSpecification({ title: "Demo", body })?.digestMatches).toBe(true);
  });
});

describe("configuration is validated at construction", () => {
  const cases: Array<[keyof SpecificationProtocolConfig, string]> = [
    ["digestScheme", "no-version"],
    ["digestScheme", "Upper/v1"],
    ["digestScheme", "a/v1\nb"],
    ["markerNamespace", "Example"],
    ["markerNamespace", "a.b"],
    ["markerNamespace", "a:b"],
    ["markerNamespace", "a b"],
    ["markerNamespace", "(a|b)"],
    ["markerNamespace", ""],
    ["publisherName", "Evil -->"],
    ["publisherName", "Back`tick"],
    ["publisherName", "Two\nlines"],
    ["publisherName", ""],
    ["publishToolName", "create-issue"],
    ["publishToolName", "Tool"],
  ];
  for (const [field, value] of cases) {
    test(`rejects ${field} ${JSON.stringify(value)}`, () => {
      expect(() => createSpecificationProtocol({ ...CONFIG, [field]: value })).toThrow(
        `invalid specification protocol ${field}`,
      );
    });
  }
});
