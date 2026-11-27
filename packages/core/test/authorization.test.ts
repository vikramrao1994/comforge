import { describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import {
  type ActionContext,
  canonicalJson,
  createGrantProtocol,
  createReceiptProtocol,
  envelopeDigest,
  FactoryCoreError,
  type Grant,
  type GrantProtocolConfig,
  keyIdFor,
  type Receipt,
  requireCapability,
} from "../src/index.ts";

// Grant and receipt verification under a neutral identity. Keys are generated per run
// here; the portfolio's frozen signed records live in
// tests/unit/engineeringRuntime/authorizationGolden.test.ts.

const NOW = new Date("2030-01-01T12:00:00.000Z");
const CONFIG: GrantProtocolConfig = {
  grantScheme: "example-engineering-grant/v1",
  repository: "example/widgets",
  ticketPattern: /^[A-Z]+-[0-9]+$/,
  branchForTicket: (ticket) => `work/${ticket.toLowerCase()}`,
};
const grants = createGrantProtocol(CONFIG);
const receipts = createReceiptProtocol({
  receiptScheme: "example-engineering-receipt/v1",
  repository: "example/widgets",
});

function keyPair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  return { publicKeyPem, privateKey, keyId: keyIdFor(publicKeyPem) };
}
const owner = keyPair();
const TRUSTED = [{ keyId: owner.keyId, publicKeyPem: owner.publicKeyPem, label: "owner" }];

const grant = (over: Partial<Grant> = {}): Grant =>
  grants.grantSchema.parse({
    schema: "example-engineering-grant/v1",
    grantId: "00000000-0000-4000-8000-000000000001",
    nonce: "0".repeat(32),
    repository: "example/widgets",
    ticket: "WID-1",
    issue: 1,
    specDigest: "a".repeat(64),
    mode: "implementation",
    capabilities: [],
    base: { kind: "origin-main" },
    maxAttempts: 1,
    issuedAt: "2030-01-01T11:00:00.000Z",
    expiresAt: "2030-01-02T11:00:00.000Z",
    ...over,
  });
const envelope = (g: Grant, key = owner) => ({
  grant: g,
  keyId: key.keyId,
  signature: sign(null, grants.signingBytes(g), key.privateKey).toString("base64url"),
});
const context = (over: Partial<ActionContext> = {}): ActionContext => ({
  action: "launch-session",
  ticket: "WID-1",
  issue: 1,
  specification: { ticketId: "WID-1", digest: "a".repeat(64), digestMatches: true },
  revoked: false,
  attemptsUsed: 0,
  ...over,
});
function refusal(run: () => unknown) {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(FactoryCoreError);
    return { code: (error as FactoryCoreError).code, message: (error as FactoryCoreError).message };
  }
  throw new Error("expected a refusal");
}

describe("grant protocol", () => {
  test("signs over the configured scheme and canonical JSON", () => {
    const g = grant();
    expect(grants.signingBytes(g).toString("utf8")).toBe(
      `example-engineering-grant/v1\n${canonicalJson(g)}`,
    );
    expect(grants.scheme).toBe("example-engineering-grant/v1");
    expect(Object.isFrozen(grants)).toBe(true);
  });

  test("a signed grant authorizes its action under the configured identity", () => {
    expect(grants.authorizeAction(envelope(grant()), TRUSTED, context(), NOW).ticket).toBe("WID-1");
    expect(envelopeDigest(envelope(grant()))).toMatch(/^[0-9a-f]{64}$/);
  });

  test("the configured repository, ticket grammar and branch rule are enforced", () => {
    expect(
      refusal(() =>
        grants.verifyEnvelope(envelope(grant({ repository: "example/other" })), TRUSTED, NOW),
      ),
    ).toEqual({
      code: "unauthorized",
      message: "The grant names another repository",
    });
    expect(() => grant({ ticket: "ENGINEERING-DEMO-001" })).toThrow();
    const publication = grant({
      mode: "publication",
      publication: { candidateSha: "c".repeat(40), branch: "work/wid-1" },
    });
    const publish = context({
      action: "publish",
      candidateSha: "c".repeat(40),
      branch: "work/wid-1",
    });
    expect(grants.authorizeAction(envelope(publication), TRUSTED, publish, NOW).mode).toBe(
      "publication",
    );
    const elsewhere = grant({
      mode: "publication",
      publication: { candidateSha: "c".repeat(40), branch: "agent/wid-1" },
    });
    expect(
      refusal(() =>
        grants.authorizeAction(
          envelope(elsewhere),
          TRUSTED,
          { ...publish, branch: "agent/wid-1" },
          NOW,
        ),
      ).message,
    ).toBe("The publication grant names another destination branch");
  });

  test("an untrusted key, a forged signature and a valid signature without authority are all refused", () => {
    const stranger = keyPair();
    expect(
      refusal(() => grants.verifyEnvelope(envelope(grant(), stranger), TRUSTED, NOW)).message,
    ).toBe("The grant is signed by a key that is not trusted");
    const forged = {
      ...envelope(grant()),
      keyId: owner.keyId,
      signature: envelope(grant(), stranger).signature,
    };
    expect(refusal(() => grants.verifyEnvelope(forged, TRUSTED, NOW)).message).toBe(
      "The grant signature is invalid",
    );
    // A perfectly signed grant still authorizes nothing outside its bindings.
    expect(
      refusal(() =>
        grants.authorizeAction(envelope(grant()), TRUSTED, context({ action: "publish" }), NOW),
      ).message,
    ).toBe("A implementation grant does not authorize publish");
    expect(
      refusal(() =>
        grants.authorizeAction(envelope(grant()), TRUSTED, context({ specification: null }), NOW),
      ).message,
    ).toBe("The issue is no longer an unmodified published specification");
  });

  test("time is the caller's: the same grant is valid or expired only by the `now` passed in", () => {
    const e = envelope(grant());
    expect(grants.verifyEnvelope(e, TRUSTED, NOW).grant.grantId).toBe(grant().grantId);
    expect(
      refusal(() => grants.verifyEnvelope(e, TRUSTED, new Date("2030-01-02T11:00:00.000Z")))
        .message,
    ).toBe("The grant has expired");
  });

  test("capabilities are explicit", () => {
    expect(refusal(() => requireCapability(grant(), "run-e2e", "Running browser tests"))).toEqual({
      code: "unauthorized",
      message:
        "Running browser tests requires the run-e2e capability, which this grant does not include",
    });
  });

  test("configuration is validated at construction", () => {
    for (const patch of [
      { grantScheme: "nope" },
      { repository: "no-slash" },
      { repository: "a/b/c" },
      { ticketPattern: "^X$" as unknown as RegExp },
      { branchForTicket: "agent/" as unknown as GrantProtocolConfig["branchForTicket"] },
    ]) {
      expect(() => createGrantProtocol({ ...CONFIG, ...patch })).toThrow(/invalid grant protocol/);
    }
    expect(() =>
      createReceiptProtocol({ receiptScheme: "nope", repository: "example/widgets" }),
    ).toThrow(/invalid receipt protocol receiptScheme/);
  });
});

describe("receipt protocol", () => {
  const controller = keyPair();
  const receipt = (over: Partial<Receipt> = {}): Receipt =>
    receipts.receiptSchema.parse({
      schema: "example-engineering-receipt/v1",
      receiptId: "00000000-0000-4000-8000-0000000000a1",
      repository: "example/widgets",
      ticket: "WID-1",
      specDigest: "a".repeat(64),
      executionId: "00000000-0000-4000-8000-0000000000e1",
      candidateSha: "c".repeat(40),
      tree: "f".repeat(40),
      baseSha: "b".repeat(40),
      controllerRevision: "1".repeat(40),
      profile: "command",
      command: "npm test",
      provisioning: [],
      provisioningDigest: "2".repeat(64),
      startedAt: "2030-01-01T11:00:00.000Z",
      completedAt: "2030-01-01T11:30:00.000Z",
      durationMs: 1,
      outcome: "PASS",
      summarySha256: null,
      summaryCounts: null,
      trustSensitiveChanges: [],
      workflowChanges: [],
      validationIntegrity: { focused: [], findings: [] },
      integrity: { objects: "ok", baseIsAncestor: true },
      ...over,
    });
  const signed = (r: Receipt, key = controller) => ({
    receipt: r,
    keyId: key.keyId,
    signature: sign(null, receipts.signingBytes(r), key.privateKey).toString("base64url"),
  });
  const expectation = {
    ticket: "WID-1",
    specDigest: "a".repeat(64),
    candidateSha: "c".repeat(40),
    tree: "f".repeat(40),
    controllerRevision: "1".repeat(40),
    now: NOW,
  };

  test("a passing receipt for the expected commit verifies", () => {
    expect(
      receipts.verifyReceipt(signed(receipt()), controller.publicKeyPem, expectation).outcome,
    ).toBe("PASS");
  });

  test("another key, an alteration, another repository or commit, staleness and a failure are refused", () => {
    const cases: Array<[() => unknown, string]> = [
      [
        () => receipts.verifyReceipt(signed(receipt()), keyPair().publicKeyPem, expectation),
        "The receipt is signed by an unknown key",
      ],
      [
        () =>
          receipts.verifyReceipt(
            { ...signed(receipt()), receipt: receipt({ durationMs: 2 }) },
            controller.publicKeyPem,
            expectation,
          ),
        "The receipt signature is invalid (forged or altered)",
      ],
      [
        () =>
          receipts.verifyReceipt(
            signed(receipt({ repository: "example/other" })),
            controller.publicKeyPem,
            expectation,
          ),
        "The receipt names another repository",
      ],
      [
        () =>
          receipts.verifyReceipt(signed(receipt()), controller.publicKeyPem, {
            ...expectation,
            tree: "0".repeat(40),
          }),
        "The receipt is for another commit",
      ],
      [
        () =>
          receipts.verifyReceipt(signed(receipt()), controller.publicKeyPem, {
            ...expectation,
            now: new Date("2030-01-03T00:00:00.000Z"),
          }),
        "The receipt is stale",
      ],
      [
        () =>
          receipts.verifyReceipt(
            signed(receipt({ outcome: "FAIL" })),
            controller.publicKeyPem,
            expectation,
          ),
        "Validation outcome is FAIL",
      ],
    ];
    for (const [run, message] of cases)
      expect(refusal(run)).toEqual({ code: "validation_failed", message });
  });
});
