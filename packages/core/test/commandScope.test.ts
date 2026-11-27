import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { createPrivateKey, createPublicKey, sign } from "node:crypto";
import {
  type CommandContext,
  createGrantProtocol,
  envelopeDigest,
  FactoryCoreError,
  type Grant,
  type GrantProtocolConfig,
  keyIdFor,
} from "../src/index.ts";
// The published 0.1 verifier: the 0.1.2 release's compiled files, byte for byte (checked
// against their pinned digests in verifierFixture.test.ts), so the test keeps an older verifier
// after the repository moves to 0.2. Older verifiers must keep accepting older grants and must
// refuse the new scoped forms (fail closed).
import { createGrantProtocol as publishedGrantProtocol } from "./fixtures/core-0.1.2/dist/index.js";

// Command scopes (scope version 1): which commands a signed grant authorizes, with the
// bindings each is checked against. Keys come from a fixed seed so the legacy envelope below
// is a golden vector: its signature and digest must never change.

const NOW = new Date("2030-01-01T12:00:00.000Z");
const CONFIG: GrantProtocolConfig = {
  grantScheme: "example-engineering-grant/v1",
  repository: "example/widgets",
  ticketPattern: /^[A-Z]+-[0-9]+$/,
  branchForTicket: (ticket) => `work/${ticket.toLowerCase()}`,
};
const protocol = createGrantProtocol(CONFIG);

function seededKey(seedHex: string) {
  const privateKey = createPrivateKey({
    key: Buffer.from(`302e020100300506032b657004220420${seedHex}`, "hex"),
    format: "der",
    type: "pkcs8",
  });
  const publicKeyPem = createPublicKey(privateKey)
    .export({ type: "spki", format: "pem" })
    .toString();
  return { privateKey, publicKeyPem, keyId: keyIdFor(publicKeyPem) };
}
const owner = seededKey("11".repeat(32));
const intruder = seededKey("22".repeat(32));
const TRUSTED = [{ keyId: owner.keyId, publicKeyPem: owner.publicKeyPem, label: "owner" }];

const HEAD = "c".repeat(40);
const BASE = "b".repeat(40);
const SPEC = "a".repeat(64);
const base = {
  schema: "example-engineering-grant/v1",
  grantId: "00000000-0000-4000-8000-000000000001",
  nonce: "0".repeat(32),
  repository: "example/widgets",
  ticket: "WID-1",
  issue: 7,
  specDigest: SPEC,
  capabilities: [],
  base: { kind: "exact", sha: BASE },
  maxAttempts: 2,
  issuedAt: "2030-01-01T11:00:00.000Z",
  expiresAt: "2030-01-02T11:00:00.000Z",
};
const publication = (over: Record<string, unknown> = {}) => ({
  ...base,
  mode: "publication",
  publication: { candidateSha: HEAD, branch: "work/wid-1" },
  ...over,
});
const commandGrant = (scope: Record<string, unknown>, over: Record<string, unknown> = {}) => ({
  ...base,
  mode: "command",
  scope: { version: 1, commands: [scope] },
  ...over,
});
const signed = (g: unknown, key = owner) => ({
  grant: g,
  keyId: key.keyId,
  signature: sign(
    null,
    Buffer.from(`${CONFIG.grantScheme}\n${canonical(g)}`, "utf8"),
    key.privateKey,
  ).toString("base64url"),
});
// The protocol's own canonical form, through its signing bytes (only for parsed grants).
const canonical = (g: unknown) =>
  protocol
    .signingBytes(g as Grant)
    .toString("utf8")
    .slice(CONFIG.grantScheme.length + 1);

const verifiedSpec = { ticketId: "WID-1", digest: SPEC, digestMatches: true };
const publishContext = (over: Partial<CommandContext> = {}): CommandContext => ({
  command: "publish",
  ticket: "WID-1",
  revoked: false,
  attemptsUsed: 0,
  issue: 7,
  specification: verifiedSpec,
  baseSha: BASE,
  candidateSha: HEAD,
  branch: "work/wid-1",
  ...over,
});
const refused = (fn: () => unknown, message: RegExp) => {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(FactoryCoreError);
    expect((error as FactoryCoreError).code).toBe("unauthorized");
    expect((error as Error).message).toMatch(message);
    return;
  }
  throw new Error("expected a refusal");
};

describe("legacy grants (no scope)", () => {
  const legacy = signed(publication());

  test("the legacy envelope is a golden vector", () => {
    expect(owner.keyId).toBe(keyIdFor(owner.publicKeyPem));
    expect(legacy.signature).toBe(GOLDEN.signature);
    expect(envelopeDigest(legacy as never)).toBe(GOLDEN.envelopeDigest);
  });

  test("the published 0.1 verifier and this one accept it for the same action", () => {
    const ctx = {
      action: "publish" as const,
      ticket: "WID-1",
      specification: verifiedSpec,
      issue: 7,
      revoked: false,
      attemptsUsed: 0,
      baseSha: BASE,
      candidateSha: HEAD,
      branch: "work/wid-1",
    };
    expect(publishedGrantProtocol(CONFIG).authorizeAction(legacy, TRUSTED, ctx, NOW).grantId).toBe(
      base.grantId,
    );
    expect(protocol.authorizeAction(legacy, TRUSTED, ctx, NOW).grantId).toBe(base.grantId);
  });

  test("it authorizes the four publication commands, as before", () => {
    for (const command of ["publish", "complete", "deliver", "recover"] as const) {
      const r = protocol.authorizeCommand(legacy, TRUSTED, publishContext({ command }), NOW);
      expect(r.scope).toBeNull();
    }
  });

  test("it never authorizes a destructive or newly introduced command by omission", () => {
    for (const command of ["cleanup", "publish-specification", "publish-review"] as const)
      refused(
        () => protocol.authorizeCommand(legacy, TRUSTED, publishContext({ command }), NOW),
        /needs a command grant that scopes it/,
      );
  });
});

describe("scoped publication grants", () => {
  test("only the listed commands are authorized", () => {
    const g = signed(publication({ scope: { version: 1, commands: [{ command: "publish" }] } }));
    expect(protocol.authorizeCommand(g, TRUSTED, publishContext(), NOW).scope).toEqual({
      command: "publish",
    });
    refused(
      () => protocol.authorizeCommand(g, TRUSTED, publishContext({ command: "deliver" }), NOW),
      /scope does not include deliver/,
    );
  });

  test("a scope cannot be read past: per-action authorization refuses a scoped grant", () => {
    const g = signed(publication({ scope: { version: 1, commands: [{ command: "publish" }] } }));
    refused(
      () =>
        protocol.authorizeAction(
          g,
          TRUSTED,
          { ...publishContext(), action: "publish" } as never,
          NOW,
        ),
      /authorized per command/,
    );
  });

  test("an older verifier refuses a scoped grant instead of ignoring the scope", () => {
    const g = signed(publication({ scope: { version: 1, commands: [{ command: "publish" }] } }));
    expect(() => publishedGrantProtocol(CONFIG).verifyEnvelope(g, TRUSTED, NOW)).toThrow(
      /grant schema/,
    );
  });

  test("a publication grant cannot scope cleanup", () => {
    const raw = publication({
      scope: { version: 1, commands: [{ command: "cleanup", pullRequest: 3, mergedHead: HEAD }] },
    });
    expect(protocol.grantSchema.safeParse(raw).success).toBe(false);
  });
});

describe("command grants", () => {
  const cleanup = signed(commandGrant({ command: "cleanup", pullRequest: 3, mergedHead: HEAD }));
  const cleanupContext = (over: Partial<CommandContext> = {}): CommandContext =>
    publishContext({
      command: "cleanup",
      pullRequest: { number: 3, headSha: HEAD, open: false, merged: true },
      ...over,
    });

  test("cleanup: authorized for the merged pull request and head it names", () => {
    expect(protocol.authorizeCommand(cleanup, TRUSTED, cleanupContext(), NOW).scope).toMatchObject({
      command: "cleanup",
    });
  });

  test("cleanup: refused for another PR, an unmerged PR, another merged head, another branch", () => {
    const pr = { number: 3, headSha: HEAD, open: false, merged: true };
    refused(
      () =>
        protocol.authorizeCommand(
          cleanup,
          TRUSTED,
          cleanupContext({ pullRequest: { ...pr, number: 4 } }),
          NOW,
        ),
      /another pull request/,
    );
    refused(
      () =>
        protocol.authorizeCommand(
          cleanup,
          TRUSTED,
          cleanupContext({ pullRequest: { ...pr, merged: false } }),
          NOW,
        ),
      /not merged/,
    );
    refused(
      () =>
        protocol.authorizeCommand(
          cleanup,
          TRUSTED,
          cleanupContext({ pullRequest: { ...pr, headSha: "d".repeat(40) } }),
          NOW,
        ),
      /merged head/,
    );
    refused(
      () => protocol.authorizeCommand(cleanup, TRUSTED, cleanupContext({ branch: "main" }), NOW),
      /another branch/,
    );
  });

  test("cross-command use is refused: a cleanup grant does not publish, review or specify", () => {
    for (const command of ["publish", "publish-review", "publish-specification"] as const)
      refused(
        () => protocol.authorizeCommand(cleanup, TRUSTED, cleanupContext({ command }), NOW),
        /does not authorize|scoped to cleanup/,
      );
  });

  test("a command grant scopes exactly one scoped-only command", () => {
    const two = {
      ...commandGrant({ command: "cleanup", pullRequest: 3, mergedHead: HEAD }),
      scope: {
        version: 1,
        commands: [
          { command: "cleanup", pullRequest: 3, mergedHead: HEAD },
          { command: "publish-review", pullRequest: 3, reviewedHead: HEAD },
        ],
      },
    };
    expect(protocol.grantSchema.safeParse(two).success).toBe(false);
    expect(protocol.grantSchema.safeParse(commandGrant({ command: "publish" })).success).toBe(
      false,
    );
    expect(protocol.grantSchema.safeParse({ ...base, mode: "command" }).success).toBe(false);
  });

  test("unknown or ambiguous scopes are refused by the schema", () => {
    for (const scope of [
      { version: 2, commands: [{ command: "cleanup", pullRequest: 3, mergedHead: HEAD }] },
      { version: 1, commands: [{ command: "merge" }] },
      {
        version: 1,
        commands: [{ command: "cleanup", pullRequest: 3, mergedHead: HEAD, all: true }],
      },
      { version: 1, commands: [] },
    ])
      expect(protocol.grantSchema.safeParse({ ...base, mode: "command", scope }).success).toBe(
        false,
      );
  });

  test("publish-specification: new issue and replacement are bound to digest and destination", () => {
    const { issue: _issue, ...noIssue } = base;
    const fresh = signed({
      ...noIssue,
      mode: "command",
      scope: {
        version: 1,
        commands: [{ command: "publish-specification", target: { kind: "new" } }],
      },
    });
    const ctx = (publishing: CommandContext["publishing"]): CommandContext => ({
      command: "publish-specification",
      ticket: "WID-1",
      revoked: false,
      attemptsUsed: 0,
      ...(publishing ? { publishing } : {}),
    });
    expect(
      protocol.authorizeCommand(
        fresh,
        TRUSTED,
        ctx({ ticketId: "WID-1", digest: SPEC, issue: null }),
        NOW,
      ).scope,
    ).toMatchObject({ command: "publish-specification" });
    refused(
      () =>
        protocol.authorizeCommand(
          fresh,
          TRUSTED,
          ctx({ ticketId: "WID-1", digest: "e".repeat(64), issue: null }),
          NOW,
        ),
      /not the one the grant names/,
    );
    refused(
      () =>
        protocol.authorizeCommand(
          fresh,
          TRUSTED,
          ctx({ ticketId: "WID-1", digest: SPEC, issue: 9 }),
          NOW,
        ),
      /destination/,
    );
    refused(
      () =>
        protocol.authorizeCommand(
          fresh,
          TRUSTED,
          ctx({ ticketId: "WID-2", digest: SPEC, issue: null }),
          NOW,
        ),
      /another ticket/,
    );
    const replace = signed(
      commandGrant({ command: "publish-specification", target: { kind: "issue", number: 7 } }),
    );
    expect(
      protocol.authorizeCommand(
        replace,
        TRUSTED,
        ctx({ ticketId: "WID-1", digest: SPEC, issue: 7 }),
        NOW,
      ).scope,
    ).toMatchObject({ target: { kind: "issue", number: 7 } });
    // The issue field and the target must agree; an issue-less grant is only a new specification.
    expect(
      protocol.grantSchema.safeParse(
        commandGrant({ command: "publish-specification", target: { kind: "issue", number: 8 } }),
      ).success,
    ).toBe(false);
    expect(
      protocol.grantSchema.safeParse({
        ...noIssue,
        ...publication(),
        issue: undefined,
      }).success,
    ).toBe(false);
  });

  test("publish-review: bound to the open PR, the exact reviewed head and an optional digest", () => {
    const digest = "f".repeat(64);
    const g = signed(
      commandGrant({
        command: "publish-review",
        pullRequest: 3,
        reviewedHead: HEAD,
        reviewDigest: digest,
      }),
    );
    const ctx = (over: Partial<CommandContext> = {}): CommandContext =>
      publishContext({
        command: "publish-review",
        pullRequest: { number: 3, headSha: HEAD, open: true, merged: false },
        review: { pullRequest: 3, reviewedHead: HEAD, digest },
        ...over,
      });
    expect(protocol.authorizeCommand(g, TRUSTED, ctx(), NOW).scope).toMatchObject({
      command: "publish-review",
    });
    refused(
      () =>
        protocol.authorizeCommand(
          g,
          TRUSTED,
          ctx({ pullRequest: { number: 3, headSha: "d".repeat(40), open: true, merged: false } }),
          NOW,
        ),
      /stale/,
    );
    refused(
      () =>
        protocol.authorizeCommand(
          g,
          TRUSTED,
          ctx({ review: { pullRequest: 3, reviewedHead: HEAD, digest: "0".repeat(64) } }),
          NOW,
        ),
      /not the one the grant names/,
    );
    refused(
      () =>
        protocol.authorizeCommand(
          g,
          TRUSTED,
          ctx({ pullRequest: { number: 3, headSha: HEAD, open: false, merged: true } }),
          NOW,
        ),
      /not open/,
    );
    refused(
      () =>
        protocol.authorizeCommand(
          g,
          TRUSTED,
          ctx({ specification: { ...verifiedSpec, digestMatches: false } }),
          NOW,
        ),
      /no longer an unmodified/,
    );
  });
});

describe("shared bindings", () => {
  const g = signed(commandGrant({ command: "cleanup", pullRequest: 3, mergedHead: HEAD }));
  const ctx = (over: Partial<CommandContext> = {}): CommandContext =>
    publishContext({
      command: "cleanup",
      pullRequest: { number: 3, headSha: HEAD, open: false, merged: true },
      ...over,
    });

  test("tampering with any signed field, including the scope, invalidates the signature", () => {
    const tampered = structuredClone(g) as { grant: Record<string, unknown> };
    (tampered.grant.scope as { commands: Array<Record<string, unknown>> }).commands[0] = {
      command: "cleanup",
      pullRequest: 4,
      mergedHead: HEAD,
    };
    refused(() => protocol.authorizeCommand(tampered, TRUSTED, ctx(), NOW), /signature is invalid/);
    // Downgrade: stripping the scope from a signed command grant is a different grant.
    const stripped = structuredClone(
      signed(publication({ scope: { version: 1, commands: [{ command: "publish" }] } })),
    ) as {
      grant: Record<string, unknown>;
    };
    delete stripped.grant.scope;
    refused(
      () =>
        protocol.authorizeCommand(stripped, TRUSTED, publishContext({ command: "deliver" }), NOW),
      /signature is invalid/,
    );
  });

  test("a foreign key, a foreign repository and another ticket are refused", () => {
    refused(
      () =>
        protocol.authorizeCommand(
          signed(commandGrant({ command: "cleanup", pullRequest: 3, mergedHead: HEAD }), intruder),
          TRUSTED,
          ctx(),
          NOW,
        ),
      /not trusted/,
    );
    refused(
      () =>
        protocol.authorizeCommand(
          signed(
            commandGrant(
              { command: "cleanup", pullRequest: 3, mergedHead: HEAD },
              { repository: "other/widgets" },
            ),
          ),
          TRUSTED,
          ctx(),
          NOW,
        ),
      /another repository/,
    );
    refused(
      () => protocol.authorizeCommand(g, TRUSTED, ctx({ ticket: "WID-2" }), NOW),
      /another ticket/,
    );
    refused(
      () => protocol.authorizeCommand(g, TRUSTED, ctx({ baseSha: "9".repeat(40) }), NOW),
      /base revision/,
    );
  });

  test("expired, revoked and exhausted grants are refused", () => {
    refused(
      () => protocol.authorizeCommand(g, TRUSTED, ctx(), new Date("2030-01-03T00:00:00.000Z")),
      /expired/,
    );
    refused(() => protocol.authorizeCommand(g, TRUSTED, ctx({ revoked: true }), NOW), /revoked/);
    refused(
      () => protocol.authorizeCommand(g, TRUSTED, ctx({ attemptsUsed: 2 }), NOW),
      /exhausted/,
    );
  });

  test("a command outside the vocabulary is refused", () => {
    refused(
      () => protocol.authorizeCommand(g, TRUSTED, ctx({ command: "merge" as never }), NOW),
      /vocabulary/,
    );
  });
});

// Frozen from the first run of this file: a change here breaks every grant already signed.
const GOLDEN = {
  signature:
    "m9dx_FmLUUBuy8Z8W6aPmkJo2_UqegNHc7HpPUOCa49wSgYh_ccs0PKLzIEyUW9CYpMXqG3yFQd4s7aPt0joAA",
  envelopeDigest: "0b5964037b93860d7f2954074c063a67bc113a6f07b7447134f8ef87ec748437",
};
