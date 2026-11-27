import { describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign as nodeSign } from "node:crypto";
import { createGrantProtocol, FactoryCoreError } from "@comforge/core";
import {
  type ActionContext,
  AUTHORITY_LIMITS,
  AUTHORITY_VOCABULARY,
  AuthorityError,
  canonicalJson,
  createRuntimeAuthority,
  ed25519Signer,
  GrantEnvelopeSchema,
  keyIdFor,
  RUNTIME_AUTHORITY_SCHEMA,
  type RuntimeAuthorityOptions,
  type Signer,
} from "../src/authority.ts";

// A runtime authority verifies with public keys only, accepts execution grants only, and is
// separated by scheme from every other authority of the repository.

const NOW = new Date("2030-01-01T12:00:00.000Z");
const GRANT_SCHEME = "acme-runtime-grant/v1";
const RECEIPT_SCHEME = "acme-runtime-receipt/v1";
const REPOSITORY = "acme/widgets";
const OPTIONS: RuntimeAuthorityOptions = {
  schema: RUNTIME_AUTHORITY_SCHEMA,
  repository: REPOSITORY,
  ticketPattern: /^WID-[0-9]+$/,
  branchForTicket: (ticket) => `work/${ticket.toLowerCase()}`,
  grantScheme: GRANT_SCHEME,
  receiptScheme: RECEIPT_SCHEME,
  separateFrom: [],
};
const authority = createRuntimeAuthority(OPTIONS);

function keyPair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  return {
    privateKey,
    privateKeyPem,
    publicKeyPem,
    keyId: keyIdFor(publicKeyPem),
    trusted: { keyId: keyIdFor(publicKeyPem), publicKeyPem, label: "owner" },
  };
}
const owner = keyPair();
const TRUSTED = [owner.trusted];
const signer = ed25519Signer(owner.privateKeyPem);

const FIELDS = {
  schema: GRANT_SCHEME,
  grantId: "00000000-0000-4000-8000-000000000001",
  nonce: "0".repeat(32),
  repository: REPOSITORY,
  ticket: "WID-1",
  issue: 1,
  specDigest: "a".repeat(64),
  mode: "implementation",
  capabilities: ["edit-repository"],
  base: { kind: "origin-main" },
  maxAttempts: 2,
  issuedAt: "2030-01-01T11:00:00.000Z",
  expiresAt: "2030-01-02T11:00:00.000Z",
};
const fields = (over: Record<string, unknown> = {}) => ({ ...FIELDS, ...over });
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
    expect(error).toBeInstanceOf(AuthorityError);
    expect(error).not.toBeInstanceOf(FactoryCoreError);
    const e = error as AuthorityError;
    return { code: e.code, message: e.message };
  }
  throw new Error("expected a refusal");
}

/** A command-mode grant signed through the kernel directly, as a lifecycle authority would. */
function commandEnvelope(scheme = GRANT_SCHEME, key = owner) {
  const protocol = createGrantProtocol({
    grantScheme: scheme,
    repository: REPOSITORY,
    ticketPattern: OPTIONS.ticketPattern,
    branchForTicket: OPTIONS.branchForTicket,
  });
  const grant = protocol.grantSchema.parse(
    fields({
      schema: scheme,
      mode: "command",
      capabilities: [],
      scope: {
        version: 1,
        commands: [{ command: "cleanup", pullRequest: 3, mergedHead: "c".repeat(40) }],
      },
    }),
  );
  return {
    grant,
    keyId: key.keyId,
    signature: nodeSign(null, protocol.signingBytes(grant), key.privateKey).toString("base64url"),
  };
}

describe("construction", () => {
  test("an unknown authority schema is refused", () => {
    for (const schema of [
      undefined,
      "comforge-runtime-authority/v0",
      "comforge-runtime-authority/v2",
    ])
      expect(() => createRuntimeAuthority({ ...OPTIONS, schema } as never)).toThrow(TypeError);
    expect(() => createRuntimeAuthority(undefined as never)).toThrow(TypeError);
  });

  test("separateFrom must be stated as an array", () => {
    for (const separateFrom of [undefined, "other/v1", null])
      expect(() => createRuntimeAuthority({ ...OPTIONS, separateFrom } as never)).toThrow(
        /separateFrom must list/,
      );
  });

  test("grant and receipt schemes must differ", () => {
    expect(() => createRuntimeAuthority({ ...OPTIONS, receiptScheme: GRANT_SCHEME })).toThrow(
      /different schemes/,
    );
  });

  test("a scheme owned by another authority is refused", () => {
    expect(() => createRuntimeAuthority({ ...OPTIONS, separateFrom: [GRANT_SCHEME] })).toThrow(
      /belongs to another authority/,
    );
    expect(() =>
      createRuntimeAuthority({ ...OPTIONS, separateFrom: ["other/v1", RECEIPT_SCHEME] }),
    ).toThrow(/belongs to another authority/);
    expect(
      createRuntimeAuthority({ ...OPTIONS, separateFrom: ["acme-lifecycle-grant/v1"] }).grants
        .scheme,
    ).toBe(GRANT_SCHEME);
  });

  test("the authority is frozen and exposes its identity", () => {
    expect(Object.isFrozen(authority)).toBe(true);
    expect(authority.repository).toBe(REPOSITORY);
    expect(authority.grants.scheme).toBe(GRANT_SCHEME);
    expect(authority.receipts.scheme).toBe(RECEIPT_SCHEME);
  });

  test("fixed limits and vocabulary are exposed", () => {
    expect(AUTHORITY_LIMITS.clockSkewMs).toBe(5 * 60 * 1000);
    expect(AUTHORITY_LIMITS.maxGrantLifetimeMs).toBe(7 * 24 * 60 * 60 * 1000);
    expect(AUTHORITY_LIMITS.receiptMaxAgeMs).toBe(24 * 60 * 60 * 1000);
    expect(AUTHORITY_VOCABULARY.prohibitedModes).toEqual(["merge", "release", "deploy"]);
    expect(AUTHORITY_VOCABULARY.grantModes).toContain("command");
    expect(AUTHORITY_VOCABULARY.actions).toContain("claim");
    expect(
      GrantEnvelopeSchema.safeParse({ grant: {}, keyId: "0".repeat(16), signature: "ab" }).success,
    ).toBe(true);
    expect(canonicalJson({ b: 1, a: [2], c: undefined })).toBe('{"a":[2],"b":1}');
  });
});

describe("grant round trip", () => {
  test("an issued grant verifies and authorizes a matching action", () => {
    const envelope = authority.grants.issue(fields(), signer);
    expect(envelope.keyId).toBe(owner.keyId);
    expect(authority.grants.verify(envelope, TRUSTED, NOW).grant.ticket).toBe("WID-1");
    expect(authority.grants.authorize(envelope, TRUSTED, context(), NOW).mode).toBe(
      "implementation",
    );
  });

  test("the digest is stable for one envelope and changes with the signature", () => {
    const envelope = authority.grants.issue(fields(), signer);
    expect(authority.grants.digest(envelope)).toMatch(/^[0-9a-f]{64}$/);
    expect(authority.grants.digest(envelope)).toBe(authority.grants.digest({ ...envelope }));
    const other = keyPair();
    const reissued = authority.grants.issue(fields(), ed25519Signer(other.privateKeyPem));
    expect(authority.grants.digest(reissued)).not.toBe(authority.grants.digest(envelope));
    expect(authority.grants.digest({ ...envelope, signature: `${envelope.signature}x` })).not.toBe(
      authority.grants.digest(envelope),
    );
  });

  test("Ed25519 signatures are deterministic for equal fields", () => {
    expect(authority.grants.issue(fields(), signer).signature).toBe(
      authority.grants.issue(fields(), signer).signature,
    );
  });

  test("a signer must hold an Ed25519 key", () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    expect(() =>
      ed25519Signer(privateKey.export({ type: "pkcs8", format: "pem" }).toString()),
    ).toThrow(/Ed25519/);
  });

  test("an invalid field set is refused when issuing", () => {
    expect(() => authority.grants.issue(fields({ ticket: "nope" }), signer)).toThrow();
    expect(() => authority.grants.issue(fields({ schema: "other/v1" }), signer)).toThrow();
  });
});

describe("verification needs no private key", () => {
  test("only keyId and publicKeyPem are used to verify", () => {
    const envelope = authority.grants.issue(fields(), signer);
    const publicOnly = [{ keyId: owner.keyId, publicKeyPem: owner.publicKeyPem, label: "" }];
    expect(authority.grants.verify(envelope, publicOnly, NOW).grant.grantId).toBe(FIELDS.grantId);
  });

  test("a custom signer that signs elsewhere produces a verifying grant", () => {
    const seen: number[] = [];
    const custom: Signer = {
      publicKeyPem: owner.publicKeyPem,
      sign: (bytes) => {
        seen.push(bytes.length);
        return nodeSign(null, bytes, owner.privateKey);
      },
    };
    const envelope = authority.grants.issue(fields(), custom);
    expect(seen).toHaveLength(1);
    expect(envelope.signature).toBe(authority.grants.issue(fields(), signer).signature);
    expect(authority.grants.verify(envelope, TRUSTED, NOW).keyId).toBe(owner.keyId);
  });
});

describe("cross-authority rejection", () => {
  test("a grant of an authority under another grant scheme is refused", () => {
    const second = createRuntimeAuthority({ ...OPTIONS, grantScheme: "acme-other-grant/v1" });
    const envelope = second.grants.issue(fields({ schema: "acme-other-grant/v1" }), signer);
    expect(second.grants.verify(envelope, TRUSTED, NOW).grant.ticket).toBe("WID-1");
    expect(refusal(() => authority.grants.verify(envelope, TRUSTED, NOW)).code).toBe(
      "unauthorized",
    );
    expect(refusal(() => authority.grants.authorize(envelope, TRUSTED, context(), NOW)).code).toBe(
      "unauthorized",
    );
  });

  test("a command grant never verifies, even under the same scheme and key", () => {
    const envelope = commandEnvelope();
    const verify = refusal(() => authority.grants.verify(envelope, TRUSTED, NOW));
    expect(verify.code).toBe("unauthorized");
    expect(verify.message).toContain("never authorizes a runtime execution");
  });

  test("a command grant never authorizes an action", () => {
    const envelope = commandEnvelope();
    for (const action of ["claim", "launch-session", "commit", "validate", "publish"] as const) {
      const result = refusal(() =>
        authority.grants.authorize(envelope, TRUSTED, context({ action }), NOW),
      );
      expect(result.code).toBe("unauthorized");
    }
  });

  test("issuing command-mode fields is refused", () => {
    const command = fields({
      mode: "command",
      capabilities: [],
      scope: {
        version: 1,
        commands: [{ command: "cleanup", pullRequest: 3, mergedHead: "c".repeat(40) }],
      },
    });
    const result = refusal(() => authority.grants.issue(command, signer));
    expect(result.code).toBe("unauthorized");
    expect(result.message).toContain("never authorizes a runtime execution");
  });

  test("a grant signed under the lifecycle scheme is not accepted as a runtime grant", () => {
    const lifecycle = commandEnvelope("acme-lifecycle-grant/v1");
    expect(refusal(() => authority.grants.verify(lifecycle, TRUSTED, NOW)).code).toBe(
      "unauthorized",
    );
  });
});

describe("refused grants", () => {
  const envelope = authority.grants.issue(fields(), signer);

  test("a tampered grant", () => {
    const tampered = { ...envelope, grant: { ...envelope.grant, ticket: "WID-2" } };
    const r = refusal(() => authority.grants.verify(tampered, TRUSTED, NOW));
    expect(r).toEqual({ code: "unauthorized", message: "The grant signature is invalid" });
  });

  test("an untrusted key", () => {
    const stranger = keyPair();
    const foreign = authority.grants.issue(fields(), ed25519Signer(stranger.privateKeyPem));
    expect(refusal(() => authority.grants.verify(foreign, TRUSTED, NOW)).message).toBe(
      "The grant is signed by a key that is not trusted",
    );
    expect(refusal(() => authority.grants.verify(envelope, [], NOW)).code).toBe("unauthorized");
  });

  test("a trusted key whose identifier does not match its public key", () => {
    const other = keyPair();
    const lying = [{ keyId: owner.keyId, publicKeyPem: other.publicKeyPem, label: "x" }];
    expect(refusal(() => authority.grants.verify(envelope, lying, NOW)).message).toBe(
      "A trusted key's identifier does not match its public key",
    );
  });

  test("an expired grant", () => {
    const r = refusal(() =>
      authority.grants.verify(envelope, TRUSTED, new Date("2030-01-02T11:00:00.000Z")),
    );
    expect(r).toEqual({ code: "unauthorized", message: "The grant has expired" });
  });

  test("a grant issued in the future beyond the skew", () => {
    const early = new Date(Date.parse(FIELDS.issuedAt) - AUTHORITY_LIMITS.clockSkewMs - 1000);
    expect(refusal(() => authority.grants.verify(envelope, TRUSTED, early)).message).toBe(
      "The grant is issued in the future",
    );
    const withinSkew = new Date(Date.parse(FIELDS.issuedAt) - AUTHORITY_LIMITS.clockSkewMs + 1000);
    expect(authority.grants.verify(envelope, TRUSTED, withinSkew).grant.ticket).toBe("WID-1");
  });

  test("a grant for another repository", () => {
    const elsewhere = authority.grants.issue(fields({ repository: "acme/other" }), signer);
    expect(refusal(() => authority.grants.verify(elsewhere, TRUSTED, NOW)).message).toBe(
      "The grant names another repository",
    );
  });

  test("a malformed envelope", () => {
    expect(refusal(() => authority.grants.verify({ nope: true }, TRUSTED, NOW)).code).toBe(
      "unauthorized",
    );
    expect(refusal(() => authority.grants.verify(null, TRUSTED, NOW)).code).toBe("unauthorized");
  });

  test("a prohibited mode can never be granted", () => {
    const bad = { ...envelope, grant: { ...envelope.grant, mode: "deploy" } };
    expect(refusal(() => authority.grants.verify(bad, TRUSTED, NOW)).message).toBe(
      "Mode deploy can never be granted",
    );
  });
});

describe("replay and stale bindings", () => {
  const envelope = authority.grants.issue(fields({ maxAttempts: 2 }), signer);

  test("attempts are counted for claim and launch", () => {
    expect(
      authority.grants.authorize(
        envelope,
        TRUSTED,
        context({ action: "claim", attemptsUsed: 1 }),
        NOW,
      ).maxAttempts,
    ).toBe(2);
    for (const action of ["claim", "launch-session"] as const)
      expect(
        refusal(() =>
          authority.grants.authorize(envelope, TRUSTED, context({ action, attemptsUsed: 2 }), NOW),
        ).message,
      ).toBe("The grant's attempts are exhausted (replay refused)");
  });

  test("a revoked grant", () => {
    expect(
      refusal(() => authority.grants.authorize(envelope, TRUSTED, context({ revoked: true }), NOW)),
    ).toEqual({ code: "unauthorized", message: "The grant has been revoked" });
  });

  test("a changed specification", () => {
    const changed = context({
      specification: { ticketId: "WID-1", digest: "f".repeat(64), digestMatches: true },
    });
    expect(refusal(() => authority.grants.authorize(envelope, TRUSTED, changed, NOW)).message).toBe(
      "The specification changed after the grant was issued",
    );
    const edited = context({
      specification: { ticketId: "WID-1", digest: "a".repeat(64), digestMatches: false },
    });
    expect(refusal(() => authority.grants.authorize(envelope, TRUSTED, edited, NOW)).message).toBe(
      "The issue is no longer an unmodified published specification",
    );
    expect(
      refusal(() =>
        authority.grants.authorize(envelope, TRUSTED, context({ specification: null }), NOW),
      ).code,
    ).toBe("unauthorized");
  });

  test("another ticket, issue or action mode", () => {
    expect(
      refusal(() =>
        authority.grants.authorize(envelope, TRUSTED, context({ ticket: "WID-2" }), NOW),
      ).message,
    ).toBe("The grant names another ticket or issue");
    expect(
      refusal(() => authority.grants.authorize(envelope, TRUSTED, context({ issue: 2 }), NOW))
        .message,
    ).toBe("The grant names another ticket or issue");
    expect(
      refusal(() =>
        authority.grants.authorize(envelope, TRUSTED, context({ action: "publish" }), NOW),
      ).message,
    ).toBe("A implementation grant does not authorize publish");
  });

  test("an exact base other than the authorized one", () => {
    const exact = authority.grants.issue(
      fields({ base: { kind: "exact", sha: "1".repeat(40) } }),
      signer,
    );
    expect(
      authority.grants.authorize(exact, TRUSTED, context({ baseSha: "1".repeat(40) }), NOW).mode,
    ).toBe("implementation");
    expect(
      refusal(() =>
        authority.grants.authorize(exact, TRUSTED, context({ baseSha: "2".repeat(40) }), NOW),
      ).message,
    ).toBe("The base revision is not the authorized one");
  });

  test("a revision grant refuses a moved pull request head and another review", () => {
    const reviewedHead = "3".repeat(40);
    const reviewDigest = "4".repeat(64);
    const revision = authority.grants.issue(
      fields({ mode: "revision", revision: { pr: 9, reviewedHead, reviewDigest } }),
      signer,
    );
    const ok = context({
      pullRequest: { number: 9, headSha: reviewedHead, open: true },
      reviewDigest,
    });
    expect(authority.grants.authorize(revision, TRUSTED, ok, NOW).mode).toBe("revision");
    const moved = { ...ok, pullRequest: { number: 9, headSha: "5".repeat(40), open: true } };
    expect(
      refusal(() => authority.grants.authorize(revision, TRUSTED, moved, NOW)).message,
    ).toContain("The review is stale");
    const otherReview = { ...ok, reviewDigest: "6".repeat(64) };
    expect(
      refusal(() => authority.grants.authorize(revision, TRUSTED, otherReview, NOW)).message,
    ).toBe("The revision grant is bound to another review");
    const closed = { ...ok, pullRequest: { number: 9, headSha: reviewedHead, open: false } };
    expect(refusal(() => authority.grants.authorize(revision, TRUSTED, closed, NOW)).message).toBe(
      "The pull request is not open",
    );
  });

  test("a publication grant is bound to its commit and the ticket's branch", () => {
    const candidateSha = "7".repeat(40);
    const publication = authority.grants.issue(
      fields({ mode: "publication", publication: { candidateSha, branch: "work/wid-1" } }),
      signer,
    );
    const publish = context({ action: "publish", candidateSha, branch: "work/wid-1" });
    expect(authority.grants.authorize(publication, TRUSTED, publish, NOW).mode).toBe("publication");
    expect(
      refusal(() =>
        authority.grants.authorize(
          publication,
          TRUSTED,
          { ...publish, candidateSha: "8".repeat(40) },
          NOW,
        ),
      ).message,
    ).toBe("The publication grant is for another commit");
  });
});

describe("capabilities", () => {
  test("a capability the grant lacks is refused, one it has is allowed", () => {
    const { grant } = authority.grants.issue(fields({ capabilities: ["edit-repository"] }), signer);
    expect(() =>
      authority.grants.requireCapability(grant, "edit-repository", "Editing"),
    ).not.toThrow();
    const r = refusal(() =>
      authority.grants.requireCapability(grant, "run-e2e", "Running browser tests"),
    );
    expect(r).toEqual({
      code: "unauthorized",
      message:
        "Running browser tests requires the run-e2e capability, which this grant does not include",
    });
  });
});

describe("receipts", () => {
  const controller = keyPair();
  const controllerSigner = ed25519Signer(controller.privateKeyPem);
  const RECEIPT = {
    schema: RECEIPT_SCHEME,
    receiptId: "00000000-0000-4000-8000-0000000000a1",
    repository: REPOSITORY,
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
  };
  const receipt = (over: Record<string, unknown> = {}) => ({ ...RECEIPT, ...over });
  const expectation = {
    ticket: "WID-1",
    specDigest: "a".repeat(64),
    candidateSha: "c".repeat(40),
    tree: "f".repeat(40),
    controllerRevision: "1".repeat(40),
    now: NOW,
  };

  test("a sealed PASS receipt verifies for the expected commit", () => {
    const signed = authority.receipts.seal(receipt(), controllerSigner);
    expect(signed.keyId).toBe(controller.keyId);
    expect(authority.receipts.verify(signed, controller.publicKeyPem, expectation).outcome).toBe(
      "PASS",
    );
    expect(authority.receipts.seal(receipt(), controllerSigner).signature).toBe(signed.signature);
  });

  test("each refusal is a validation failure with its own message", () => {
    const signed = authority.receipts.seal(receipt(), controllerSigner);
    const cases: Array<[() => unknown, string]> = [
      [
        () => authority.receipts.verify(signed, keyPair().publicKeyPem, expectation),
        "The receipt is signed by an unknown key",
      ],
      [
        () =>
          authority.receipts.verify(
            { ...signed, receipt: { ...signed.receipt, durationMs: 2 } },
            controller.publicKeyPem,
            expectation,
          ),
        "The receipt signature is invalid (forged or altered)",
      ],
      [
        () =>
          authority.receipts.verify(signed, controller.publicKeyPem, {
            ...expectation,
            candidateSha: "d".repeat(40),
          }),
        "The receipt is for another commit",
      ],
      [
        () =>
          authority.receipts.verify(signed, controller.publicKeyPem, {
            ...expectation,
            tree: "e".repeat(40),
          }),
        "The receipt is for another commit",
      ],
      [
        () =>
          authority.receipts.verify(signed, controller.publicKeyPem, {
            ...expectation,
            controllerRevision: "9".repeat(40),
          }),
        "The receipt was produced by another controller revision (stale)",
      ],
      [
        () =>
          authority.receipts.verify(signed, controller.publicKeyPem, {
            ...expectation,
            now: new Date(Date.parse(RECEIPT.completedAt) + AUTHORITY_LIMITS.receiptMaxAgeMs + 1),
          }),
        "The receipt is stale",
      ],
      [
        () =>
          authority.receipts.verify(signed, controller.publicKeyPem, {
            ...expectation,
            now: new Date(Date.parse(RECEIPT.completedAt) + 61_000),
            maxAgeMs: 60_000,
          }),
        "The receipt is stale",
      ],
      [
        () =>
          authority.receipts.verify(
            authority.receipts.seal(receipt({ outcome: "FAIL" }), controllerSigner),
            controller.publicKeyPem,
            expectation,
          ),
        "Validation outcome is FAIL",
      ],
      [
        () =>
          authority.receipts.verify(
            authority.receipts.seal(receipt({ repository: "acme/other" }), controllerSigner),
            controller.publicKeyPem,
            expectation,
          ),
        "The receipt names another repository",
      ],
      [
        () =>
          authority.receipts.verify(
            authority.receipts.seal(
              receipt({ integrity: { objects: "failed", baseIsAncestor: true } }),
              controllerSigner,
            ),
            controller.publicKeyPem,
            expectation,
          ),
        "The receipt records an integrity failure",
      ],
      [
        () => authority.receipts.verify({ nope: 1 }, controller.publicKeyPem, expectation),
        "The validation receipt is malformed",
      ],
    ];
    for (const [run, message] of cases)
      expect(refusal(run)).toEqual({ code: "validation_failed", message });
  });

  test("a receipt under another receipt scheme is refused", () => {
    const other = createRuntimeAuthority({ ...OPTIONS, receiptScheme: "acme-other-receipt/v1" });
    const foreign = other.receipts.seal(
      receipt({ schema: "acme-other-receipt/v1" }),
      controllerSigner,
    );
    expect(
      refusal(() => authority.receipts.verify(foreign, controller.publicKeyPem, expectation)).code,
    ).toBe("validation_failed");
  });
});

describe("errors", () => {
  test("refusals are AuthorityError and never the kernel's error", () => {
    try {
      authority.grants.verify({}, TRUSTED, NOW);
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(AuthorityError);
      expect(error).not.toBeInstanceOf(FactoryCoreError);
      expect((error as AuthorityError).name).toBe("AuthorityError");
    }
    try {
      authority.receipts.verify({}, owner.publicKeyPem, {
        ticket: "WID-1",
        specDigest: "a".repeat(64),
        candidateSha: "c".repeat(40),
        tree: "f".repeat(40),
        controllerRevision: "1".repeat(40),
        now: NOW,
      });
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(AuthorityError);
      expect(error).not.toBeInstanceOf(FactoryCoreError);
    }
  });
});
