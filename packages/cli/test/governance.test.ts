import { afterEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { createGrantProtocol, keyIdFor } from "@comforge/core";
import { artifactReadable } from "../src/commands/governance.ts";
import { ConfigSchema, trustedChanges } from "../src/config.ts";
import { createLifecycleServices } from "../src/services.ts";
import { BOT, baseConfig, createWorld, type World } from "./harness.ts";

// M10: the governance services — publishing a specification and an advisory review, and the
// verified reads around them — under the trusted configuration, with owner-grant authorization.

let world: World;
afterEach(() => world?.dispose());

const TICKET = "DEMO-001";
const credentials = { source: "env", variable: "ACME_TOKEN" };
const REVIEW = {
  reviewScheme: "acme-review/v1",
  markerNamespace: "acme-review",
  publisherName: "Acme Review",
  publishToolName: "acme_review",
  trustedAuthors: [BOT],
};
const SPEC_CAPS = ["issues:create", "issues:update", "issues:comment"];
const HEAD = "a".repeat(40);
const REVOKED = "00000000-0000-4000-8000-00000000dead";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const owner = {
  publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
};

const operatorConfig = (extra: Record<string, unknown> = {}, capabilities = SPEC_CAPS) =>
  baseConfig({
    review: REVIEW,
    security: { credentials, authorization: { mode: "operator" }, capabilities },
    ...extra,
  });
const ownerConfig = () =>
  baseConfig({
    review: REVIEW,
    security: {
      credentials,
      capabilities: SPEC_CAPS,
      authorization: {
        mode: "owner-grant",
        grantScheme: "acme-grant/v1",
        revokedGrants: [REVOKED],
        trustedKeys: [
          { keyId: keyIdFor(owner.publicKeyPem), publicKeyPem: owner.publicKeyPem, label: "owner" },
        ],
      },
    },
  });

/** Signs an unsigned grant as the owner would (governance grants belong to no initiative). */
function signGrant(w: World, template: Record<string, unknown>, edit?: (g: any) => void): string {
  const grant = structuredClone(template);
  edit?.(grant);
  const protocol = createGrantProtocol({
    grantScheme: "acme-grant/v1",
    repository: "acme/widgets",
    ticketPattern: /^[A-Z][A-Z0-9]*-\d{3}$/,
    branchForTicket: (t) => `agent/${t.toLowerCase()}`,
  });
  const parsed = protocol.grantSchema.parse(grant);
  const envelope = {
    grant: parsed,
    keyId: keyIdFor(owner.publicKeyPem),
    signature: sign(null, protocol.signingBytes(parsed), owner.privateKeyPem).toString("base64url"),
  };
  const file = path.join(w.root, `grant-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(file, JSON.stringify(envelope));
  return file;
}

function body(w: World, text: string): string {
  const file = path.join(w.root, `body-${Math.random().toString(36).slice(2)}.md`);
  writeFileSync(file, text);
  return file;
}
const specArgs = (w: World, text = "Build the thing.", extra: string[] = []) => [
  "spec",
  "publish",
  TICKET,
  "--title",
  "DEMO-001 specification",
  "--body-file",
  body(w, text),
  ...extra,
];

function review(prNumber: number, over: Record<string, unknown> = {}) {
  return {
    prNumber,
    expectedHeadSha: HEAD,
    ticketId: TICKET,
    verdict: "revision_recommended",
    summary: "One thing to fix.",
    findings: [{ id: "H1", severity: "high", title: "A defect", evidence: "See file a.txt." }],
    idempotencyKey: "review-key-0123456789",
    ...over,
  };
}
function reviewFile(w: World, input: unknown): string {
  const file = path.join(w.root, `review-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(file, JSON.stringify(input));
  return file;
}
const openPull = (w: World, author = "alice") => w.gh.seedPull("feature/x", HEAD, { author });
const issueCount = (w: World) => w.gh.issues.size;
const writesTo = (w: World, re: RegExp) => w.gh.writes().filter((r) => re.test(r.path));

describe("spec publish", () => {
  test("dry run reports create and the digest; execute creates one verified issue; rerun replays", async () => {
    world = createWorld({ config: operatorConfig() });
    const w = world;
    const dry = await w.cli(specArgs(w));
    expect([dry.code, dry.json.action, dry.json.executed]).toEqual([0, "create", false]);
    expect(dry.json.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(dry.json.grantTemplate).toBeUndefined();
    expect(w.gh.writes()).toEqual([]);

    const done = await w.cli(specArgs(w, "Build the thing.", ["--execute"]));
    expect([done.code, done.json.action, done.json.executed]).toEqual([0, "created", true]);
    expect(done.json.digest).toBe(dry.json.digest);
    expect(done.json.authorization).toEqual({ mode: "operator" });
    expect(issueCount(w)).toBe(1);
    const issue = w.gh.issues.get(done.json.issueNumber);
    expect(issue?.body).toContain("Build the thing.");

    const again = await w.cli(specArgs(w, "Build the thing.", ["--execute"]));
    expect([again.code, again.json.action, again.json.issueNumber]).toEqual([
      0,
      "replayed",
      done.json.issueNumber,
    ]);
    expect(issueCount(w)).toBe(1);
    expect(writesTo(w, /\/issues$/)).toHaveLength(1);
  });

  test("the same ticket with different content and no --issue is a conflict", async () => {
    world = createWorld({ config: operatorConfig() });
    const w = world;
    await w.cli(specArgs(w, "First.", ["--execute"]));
    const r = await w.cli(specArgs(w, "Second.", ["--execute"]));
    expect([r.code === 0, r.json.error]).toEqual([false, "conflict"]);
    expect(issueCount(w)).toBe(1);
  });

  test("--issue N replaces the specification of that issue; it is replayed when unchanged", async () => {
    world = createWorld({ config: operatorConfig() });
    const w = world;
    const first = await w.cli(specArgs(w, "First.", ["--execute"]));
    const n = String(first.json.issueNumber);
    const dry = await w.cli(specArgs(w, "Second.", ["--issue", n]));
    expect([dry.json.action, dry.json.issueNumber]).toEqual(["update", first.json.issueNumber]);
    const done = await w.cli(specArgs(w, "Second.", ["--issue", n, "--execute"]));
    expect([done.code, done.json.action]).toEqual([0, "updated"]);
    expect(w.gh.issues.get(first.json.issueNumber)?.body).toContain("Second.");
    expect(issueCount(w)).toBe(1);
    const again = await w.cli(specArgs(w, "Second.", ["--issue", n, "--execute"]));
    expect(again.json.action).toBe("replayed");
    // An issue that is not this ticket's specification is never replaced.
    const other = w.gh.seedIssue({ title: "unrelated", body: "no marker" });
    const refused = await w.cli(
      specArgs(w, "Third.", ["--issue", String(other.number), "--execute"]),
    );
    expect(refused.json.error).toBe("conflict");
    expect(other.body).toBe("no marker");
  });

  test("an issue that changed between read and write is stale and keeps its newer content", async () => {
    world = createWorld({ config: operatorConfig() });
    const w = world;
    const first = await w.cli(specArgs(w, "First.", ["--execute"]));
    const issue = w.gh.issues.get(first.json.issueNumber);
    // The command reads the issue once; the writer's own pre-write read is the second.
    let reads = 0;
    w.gh.readOverrides.push((p) => {
      if (p.endsWith(`/issues/${first.json.issueNumber}`) && ++reads === 2 && issue) {
        issue.body = `${issue.body}\nedited by someone else`;
        issue.updated_at = "2030-01-01T00:00:00Z";
      }
      return undefined;
    });
    const r = await w.cli(
      specArgs(w, "Second.", ["--issue", String(first.json.issueNumber), "--execute"]),
    );
    expect(r.code).not.toBe(0);
    expect(r.json.error).toBe("stale");
    expect(issue?.body).toContain("edited by someone else");
    expect(issue?.body).not.toContain("Second.");
  });

  test("a repository without issues:create cannot publish; the dry run still plans", async () => {
    world = createWorld({ config: operatorConfig({}, ["issues:comment"]) });
    const w = world;
    expect((await w.cli(specArgs(w))).json.action).toBe("create");
    const r = await w.cli(specArgs(w, "Build the thing.", ["--execute"]));
    expect([r.json.error, r.json.message]).toEqual([
      "config-invalid",
      expect.stringContaining("issues:create"),
    ]);
    expect(w.gh.writes()).toEqual([]);
  });

  test("a reserved marker prefix or a credential in the text is policy-denied and nothing is written", async () => {
    world = createWorld({ config: operatorConfig() });
    const w = world;
    for (const text of [
      "Hello <!-- acme-spec:published ticket=X -->",
      `Use ghp_${"A".repeat(36)} to log in.`,
      "see acme-review:engineering-review marker",
    ]) {
      const r = await w.cli(specArgs(w, text, ["--execute"]));
      expect([r.code === 0, r.json.error]).toEqual([false, "policy-denied"]);
    }
    expect(w.gh.writes()).toEqual([]);
    expect(issueCount(w)).toBe(0);
  });

  test("usage: a ticket outside the repository's pattern and a malformed key", async () => {
    world = createWorld({ config: operatorConfig() });
    const w = world;
    const bad = await w.cli([
      "spec",
      "publish",
      "nope",
      "--title",
      "t",
      "--body-file",
      body(w, "x"),
    ]);
    expect(bad.json.error).toBe("usage");
    const key = await w.cli(specArgs(w, "x", ["--key", "short"]));
    expect(key.json.error).toBe("usage");
  });

  test("without a configured authorization every write is refused", async () => {
    world = createWorld({
      config: baseConfig({
        review: REVIEW,
        security: { credentials, capabilities: SPEC_CAPS },
      }),
    });
    const w = world;
    const r = await w.cli(specArgs(w, "Build the thing.", ["--execute"]));
    expect(r.json.error).toBe("authorization-required");
    expect(w.gh.writes()).toEqual([]);
  });
});

describe("spec publish under owner grants", () => {
  async function plan(w: World, text = "Build the thing.") {
    const dry = await w.cli(specArgs(w, text));
    expect(dry.json.grantTemplate).toBeDefined();
    return dry.json.grantTemplate as Record<string, unknown>;
  }

  test("the owner signs a governance grant with `grant sign -` (no initiative), and it publishes", async () => {
    world = createWorld({ config: ownerConfig() });
    const w = world;
    const template = await plan(w);
    const unsigned = path.join(w.root, "spec-grant.json");
    const key = path.join(w.root, "owner.pem");
    writeFileSync(unsigned, JSON.stringify(template));
    writeFileSync(key, owner.privateKeyPem);
    const signed = await w.cli(["grant", "sign", "-", "--grant", unsigned, "--key", key]);
    expect(signed.code).toBe(0);
    const file = path.join(w.root, "spec-grant.signed.json");
    writeFileSync(file, JSON.stringify(signed.json));
    const r = await w.cli(specArgs(w, "Build the thing.", ["--grant", file, "--execute"]));
    expect([r.code, r.json.action]).toEqual([0, "created"]);
    expect(issueCount(w)).toBe(1);
  });

  test("no grant, a publication grant, and a revoked grant are refused", async () => {
    world = createWorld({ config: ownerConfig() });
    const w = world;
    const template = await plan(w);
    expect((await w.cli(specArgs(w, "Build the thing.", ["--execute"]))).json.error).toBe(
      "authorization-required",
    );
    // A scope-less publication grant never authorizes a specification publication.
    const publication = signGrant(w, template, (g) => {
      g.mode = "publication";
      g.issue = 1;
      delete g.scope;
      g.base = { kind: "exact", sha: "b".repeat(40) };
      g.publication = { candidateSha: "b".repeat(40), branch: "agent/demo-001" };
      g.maxAttempts = 3;
    });
    const p = await w.cli(specArgs(w, "Build the thing.", ["--grant", publication, "--execute"]));
    expect([p.code === 0, p.json.error]).toEqual([false, "unauthorized"]);
    const revoked = signGrant(w, template, (g) => {
      g.grantId = REVOKED;
    });
    const r = await w.cli(specArgs(w, "Build the thing.", ["--grant", revoked, "--execute"]));
    expect([r.json.error, r.json.message]).toEqual([
      "unauthorized",
      expect.stringContaining("revoked"),
    ]);
    expect(issueCount(w)).toBe(0);
  });

  test("a command grant from the dry run works exactly once", async () => {
    world = createWorld({ config: ownerConfig() });
    const w = world;
    const grant = signGrant(w, await plan(w, "One."));
    const done = await w.cli(specArgs(w, "One.", ["--grant", grant, "--execute"]));
    expect([done.code, done.json.action, done.json.authorization.mode]).toEqual([
      0,
      "created",
      "owner-grant",
    ]);
    expect(done.json.authorization.scope).toBe("publish-specification");
    expect(issueCount(w)).toBe(1);
    // The same grant cannot authorize another write; its digest also differs.
    const second = await w.cli(
      specArgs(w, "Two.", [
        "--issue",
        String(done.json.issueNumber),
        "--grant",
        grant,
        "--execute",
      ]),
    );
    expect([second.code === 0, second.json.error]).toEqual([false, "unauthorized"]);
    expect(w.gh.issues.get(done.json.issueNumber)?.body).toContain("One.");
  });

  test("a grant whose attempt was spent on a failed write is exhausted, never reusable", async () => {
    world = createWorld({ config: ownerConfig() });
    const w = world;
    const grant = signGrant(w, await plan(w, "One."));
    w.gh.faults.push("403");
    const failed = await w.cli(specArgs(w, "One.", ["--grant", grant, "--execute"]));
    expect(failed.code).not.toBe(0);
    expect(issueCount(w)).toBe(0);
    const again = await w.cli(specArgs(w, "One.", ["--grant", grant, "--execute"]));
    expect([again.code === 0, again.json.error, again.json.message]).toEqual([
      false,
      "unauthorized",
      expect.stringContaining("exhausted"),
    ]);
    expect(issueCount(w)).toBe(0);
  });

  test("a grant naming another digest or another destination is refused", async () => {
    world = createWorld({ config: ownerConfig() });
    const w = world;
    const template = await plan(w, "One.");
    const otherDigest = signGrant(w, template, (g) => {
      g.specDigest = "f".repeat(64);
    });
    const a = await w.cli(specArgs(w, "One.", ["--grant", otherDigest, "--execute"]));
    expect([a.code === 0, a.json.error]).toEqual([false, "unauthorized"]);
    const otherDestination = signGrant(w, template, (g) => {
      g.scope.commands[0].target = { kind: "issue", number: 7 };
      g.issue = 7;
    });
    const b = await w.cli(specArgs(w, "One.", ["--grant", otherDestination, "--execute"]));
    expect([b.code === 0, b.json.error]).toEqual([false, "unauthorized"]);
    const expired = signGrant(w, template, (g) => {
      g.issuedAt = "2000-01-01T00:00:00.000Z";
      g.expiresAt = "2000-01-02T00:00:00.000Z";
    });
    expect((await w.cli(specArgs(w, "One.", ["--grant", expired, "--execute"]))).json.error).toBe(
      "unauthorized",
    );
    expect(issueCount(w)).toBe(0);
    // None of the refused grants was spent: the right one still works.
    const good = signGrant(w, template);
    expect((await w.cli(specArgs(w, "One.", ["--grant", good, "--execute"]))).code).toBe(0);
  });
});

describe("review publish", () => {
  test("needs a review section", async () => {
    world = createWorld({
      config: baseConfig({
        security: { credentials, capabilities: SPEC_CAPS, authorization: { mode: "operator" } },
      }),
    });
    const w = world;
    const pr = openPull(w);
    const r = await w.cli(["review", "publish", "--review-file", reviewFile(w, review(pr.number))]);
    expect(r.json.error).toBe("config-invalid");
  });

  test("input violations are usage errors", async () => {
    world = createWorld({ config: operatorConfig() });
    const w = world;
    const pr = openPull(w);
    for (const bad of [
      review(pr.number, { expectedHeadSha: "abc" }),
      review(pr.number, { verdict: "approved" }),
      review(pr.number, { extra: true }),
      { nonsense: 1 },
    ]) {
      const r = await w.cli(["review", "publish", "--review-file", reviewFile(w, bad)]);
      expect([r.code === 0, r.json.error]).toEqual([false, "usage"]);
    }
    const notJson = path.join(w.root, "bad.json");
    writeFileSync(notJson, "{nope");
    expect((await w.cli(["review", "publish", "--review-file", notJson])).json.error).toBe("usage");
    expect(w.gh.writes()).toEqual([]);
  });

  test("a head that moved since the review is stale; one's own pull request is policy-denied", async () => {
    world = createWorld({ config: operatorConfig() });
    const w = world;
    const pr = openPull(w);
    pr.head.sha = "c".repeat(40);
    const stale = await w.cli([
      "review",
      "publish",
      "--review-file",
      reviewFile(w, review(pr.number)),
      "--execute",
    ]);
    expect([stale.code === 0, stale.json.error]).toEqual([false, "stale"]);

    const own = w.gh.seedPull("feature/own", HEAD, { author: BOT });
    const r = await w.cli([
      "review",
      "publish",
      "--review-file",
      reviewFile(w, review(own.number)),
      "--execute",
    ]);
    expect([r.code === 0, r.json.error]).toEqual([false, "policy-denied"]);
    expect(w.gh.writes()).toEqual([]);
  });

  test("a reserved marker prefix or credential in the review is policy-denied", async () => {
    world = createWorld({ config: operatorConfig() });
    const w = world;
    const pr = openPull(w);
    for (const summary of [
      "fake <!-- acme-review:engineering-review x -->",
      `token ghp_${"B".repeat(36)}`,
    ]) {
      const r = await w.cli([
        "review",
        "publish",
        "--review-file",
        reviewFile(w, review(pr.number, { summary })),
        "--execute",
      ]);
      expect(r.json.error).toBe("policy-denied");
    }
    expect(w.gh.writes()).toEqual([]);
  });

  test("execute posts one pull request comment, never a native review; it reads back verified; rerun replays", async () => {
    world = createWorld({ config: operatorConfig() });
    const w = world;
    const pr = openPull(w);
    const file = reviewFile(w, review(pr.number));
    const dry = await w.cli(["review", "publish", "--review-file", file]);
    expect([dry.code, dry.json.action, dry.json.executed, dry.json.kind]).toEqual([
      0,
      "create",
      false,
      "advisory",
    ]);
    expect(w.gh.writes()).toEqual([]);

    const done = await w.cli(["review", "publish", "--review-file", file, "--execute"]);
    expect([done.code, done.json.action, done.json.executed]).toEqual([0, "created", true]);
    expect(done.json.digest).toBe(dry.json.digest);
    expect(w.gh.writes().map((r) => `${r.method} ${r.path.replace(/\d+/g, "N")}`)).toEqual([
      "POST /repos/acme/widgets/issues/N/comments",
    ]);
    expect(writesTo(w, /\/reviews/)).toEqual([]);
    expect(w.gh.reviews.size).toBe(0);

    const list = await w.cli(["review", "list", String(pr.number)]);
    expect(list.json).toMatchObject({
      pullRequest: pr.number,
      currentHead: HEAD,
      kind: "advisory",
    });
    expect(list.json.reviews).toHaveLength(1);
    expect(list.json.reviews[0]).toMatchObject({
      commentId: done.json.commentId,
      integrity: "verified",
      provenance: "trusted_author",
      stale: false,
      verdict: "revision_recommended",
      reviewDigest: done.json.digest,
    });
    expect(list.json.reviews[0].review.findings[0].id).toBe("H1");

    const again = await w.cli(["review", "publish", "--review-file", file, "--execute"]);
    expect([again.code, again.json.action, again.json.commentId]).toEqual([
      0,
      "replayed",
      done.json.commentId,
    ]);
    expect(w.gh.comments.size).toBe(1);
  });

  test("a review naming a specification issue binds its verified digest", async () => {
    world = createWorld({ config: operatorConfig() });
    const w = world;
    const pr = openPull(w);
    const spec = w.specIssue(TICKET);
    const ok = await w.cli([
      "review",
      "publish",
      "--review-file",
      reviewFile(w, review(pr.number, { specificationIssueNumber: spec })),
      "--execute",
    ]);
    expect(ok.code).toBe(0);
    const list = await w.cli(["review", "list", String(pr.number)]);
    expect(list.json.reviews[0].review.specification).toMatchObject({
      issueNumber: spec,
      digestVerified: true,
    });
    const plain = w.gh.seedIssue({ title: "x", body: "plain" });
    const bad = await w.cli([
      "review",
      "publish",
      "--review-file",
      reviewFile(
        w,
        review(pr.number, {
          specificationIssueNumber: plain.number,
          idempotencyKey: "review-key-other-0001",
        }),
      ),
      "--execute",
    ]);
    expect(bad.json.error).toBe("conflict");
  });

  describe("under owner grants", () => {
    async function setup(w: World) {
      const pr = openPull(w);
      const spec = w.specIssue(TICKET);
      const file = reviewFile(w, review(pr.number, { specificationIssueNumber: spec }));
      const dry = await w.cli(["review", "publish", "--review-file", file]);
      return { pr, spec, file, template: dry.json.grantTemplate as Record<string, unknown> };
    }

    test("a review without a specification issue has no grant template and cannot be authorized", async () => {
      world = createWorld({ config: ownerConfig() });
      const w = world;
      const pr = openPull(w);
      const dry = await w.cli([
        "review",
        "publish",
        "--review-file",
        reviewFile(w, review(pr.number)),
      ]);
      expect(dry.json.grantTemplate).toBeUndefined();
      const r = await w.cli([
        "review",
        "publish",
        "--review-file",
        reviewFile(w, review(pr.number)),
        "--execute",
      ]);
      expect(r.json.error).toBe("authorization-required");
    });

    test("the publish-review command grant from the dry run works; other grants do not", async () => {
      world = createWorld({ config: ownerConfig() });
      const w = world;
      const { pr, spec, file, template } = await setup(w);
      expect(template).toMatchObject({ mode: "command", issue: spec });
      const run = (g?: string) =>
        w.cli([
          "review",
          "publish",
          "--review-file",
          file,
          ...(g ? ["--grant", g] : []),
          "--execute",
        ]);
      expect((await run()).json.error).toBe("authorization-required");

      const publication = signGrant(w, template, (g) => {
        g.mode = "publication";
        delete g.scope;
        g.base = { kind: "exact", sha: "b".repeat(40) };
        g.publication = { candidateSha: "b".repeat(40), branch: "agent/demo-001" };
      });
      expect((await run(publication)).json.error).toBe("unauthorized");
      const cleanup = signGrant(w, template, (g) => {
        g.scope.commands = [{ command: "cleanup", pullRequest: pr.number, mergedHead: HEAD }];
      });
      expect((await run(cleanup)).json.error).toBe("unauthorized");
      const otherHead = signGrant(w, template, (g) => {
        g.scope.commands[0].reviewedHead = "d".repeat(40);
      });
      expect((await run(otherHead)).json.error).toBe("unauthorized");
      const otherDigest = signGrant(w, template, (g) => {
        g.scope.commands[0].reviewDigest = "e".repeat(64);
      });
      expect((await run(otherDigest)).json.error).toBe("unauthorized");
      const revoked = signGrant(w, template, (g) => {
        g.grantId = REVOKED;
      });
      expect((await run(revoked)).json.error).toBe("unauthorized");
      expect(w.gh.comments.size).toBe(0);

      const good = await run(signGrant(w, template));
      expect([good.code, good.json.action, good.json.authorization.scope]).toEqual([
        0,
        "created",
        "publish-review",
      ]);
      expect(w.gh.comments.size).toBe(1);
    });

    test("a grant spent on a review does not authorize a second one", async () => {
      world = createWorld({ config: ownerConfig() });
      const w = world;
      const { pr, spec, file, template } = await setup(w);
      const grant = signGrant(w, template);
      expect(
        (await w.cli(["review", "publish", "--review-file", file, "--grant", grant, "--execute"]))
          .code,
      ).toBe(0);
      const second = reviewFile(
        w,
        review(pr.number, {
          specificationIssueNumber: spec,
          summary: "Different.",
          idempotencyKey: "review-key-second-001",
        }),
      );
      const r = await w.cli([
        "review",
        "publish",
        "--review-file",
        second,
        "--grant",
        grant,
        "--execute",
      ]);
      expect(r.json.error).toBe("unauthorized");
      expect(w.gh.comments.size).toBe(1);
    });
  });
});

describe("review list", () => {
  async function published(w: World) {
    const pr = openPull(w);
    const done = await w.cli([
      "review",
      "publish",
      "--review-file",
      reviewFile(w, review(pr.number)),
      "--execute",
    ]);
    expect(done.code).toBe(0);
    return { pr, comment: w.gh.comments.get(done.json.commentId)! };
  }

  test("an altered or forged marker never yields a payload", async () => {
    world = createWorld({ config: operatorConfig() });
    const w = world;
    const { pr, comment } = await published(w);
    const genuine = comment.body;
    // Altered: a digest character flipped.
    const digest = genuine.match(/ digest=([0-9a-f]{64}) /)?.[1] as string;
    const flipped = `${digest[0] === "0" ? "1" : "0"}${digest.slice(1)}`;
    const altered = genuine.replace(`digest=${digest}`, `digest=${flipped}`);
    expect(altered).not.toBe(genuine);
    comment.body = altered;
    // Forged: marker prefix with garbage, by a stranger.
    w.gh.seedComment(pr.number, "<!-- acme-review:engineering-review not-a-marker -->", "mallory");
    const list = await w.cli(["review", "list", String(pr.number)]);
    expect(list.code).toBe(0);
    expect(list.json.reviews).toHaveLength(2);
    for (const r of list.json.reviews) {
      expect(["mismatch", "unreadable"]).toContain(r.integrity);
      expect(r.review).toBeUndefined();
      expect(r.verdict).toBeNull();
    }
  });

  test("a genuine review copied by a stranger verifies but is not trusted provenance", async () => {
    world = createWorld({ config: operatorConfig() });
    const w = world;
    const { pr, comment } = await published(w);
    w.gh.seedComment(pr.number, comment.body, "mallory");
    const list = await w.cli(["review", "list", String(pr.number)]);
    const byAuthor = Object.fromEntries(list.json.reviews.map((r: any) => [r.author, r]));
    expect(byAuthor[BOT].provenance).toBe("trusted_author");
    expect(byAuthor.mallory).toMatchObject({
      integrity: "verified",
      provenance: "untrusted_author",
    });
  });

  test("with no trusted authors no review has verified provenance; a moved head makes it stale", async () => {
    world = createWorld({ config: operatorConfig({ review: { ...REVIEW, trustedAuthors: [] } }) });
    const w = world;
    const { pr } = await published(w);
    w.gh.pulls.get(pr.number)!.head.sha = "c".repeat(40);
    const list = await w.cli(["review", "list", String(pr.number)]);
    expect(list.json.reviews[0]).toMatchObject({
      integrity: "verified",
      provenance: "author_not_verified",
      stale: true,
    });
    expect(list.json.currentHead).toBe("c".repeat(40));
  });

  test("a review copied from another pull request does not verify for this one", async () => {
    world = createWorld({ config: operatorConfig() });
    const w = world;
    const { comment } = await published(w);
    const other = w.gh.seedPull("feature/y", HEAD, { author: "bob" });
    w.gh.seedComment(other.number, comment.body, BOT);
    const list = await w.cli(["review", "list", String(other.number)]);
    expect(list.json.reviews[0].integrity).toBe("mismatch");
    expect(list.json.reviews[0].review).toBeUndefined();
  });
});

describe("comments, prs and artifact", () => {
  test("comments lists an issue's comments; prs lists by state", async () => {
    world = createWorld({ config: operatorConfig() });
    const w = world;
    const pr = openPull(w);
    w.gh.seedComment(pr.number, "hello", "alice");
    const comments = await w.cli(["comments", String(pr.number)]);
    expect(comments.json.issue).toBe(pr.number);
    expect(comments.json.comments.map((c: any) => c.body.text)).toEqual(["hello"]);
    const closed = w.gh.seedPull("feature/z", "b".repeat(40), { state: "closed", author: "bob" });
    const open = await w.cli(["prs"]);
    expect(open.json.pullRequests.map((p: any) => p.number)).toEqual([pr.number]);
    const all = await w.cli(["prs", "--state", "all"]);
    expect(all.json.pullRequests.map((p: any) => p.number).sort()).toEqual(
      [pr.number, closed.number].sort(),
    );
    expect((await w.cli(["prs", "--state", "weird"])).json.error).toBe("usage");
    expect((await w.cli(["comments", "abc"])).json.error).toBe("usage");
    expect(w.gh.writes()).toEqual([]);
  });

  test("artifact reads inside the report directory, refuses outside it without a request", async () => {
    world = createWorld({ config: operatorConfig() });
    const w = world;
    w.gh.files.set(`${HEAD}:docs/comforge/report.md`, "# Report\n");
    w.gh.files.set(`${HEAD}:src/secret.ts`, "export const x = 1;\n");
    const ok = await w.cli(["artifact", HEAD, "docs/comforge/report.md"]);
    expect([ok.code, ok.json.artifact.kind, ok.json.artifact.text.text]).toEqual([
      0,
      "text",
      "# Report\n",
    ]);
    const before = w.gh.requests.length;
    for (const p of [
      "src/secret.ts",
      "docs/comforge/../../src/secret.ts",
      "docs/comforgeX/report.md",
    ]) {
      const r = await w.cli(["artifact", HEAD, p]);
      expect([r.code === 0, r.json.error]).toEqual([false, "policy-denied"]);
    }
    expect(w.gh.requests.slice(before).filter((r) => r.path.includes("/contents/"))).toEqual([]);
    for (const commit of ["main", "abc123", HEAD.toUpperCase()]) {
      expect((await w.cli(["artifact", commit, "docs/comforge/report.md"])).json.error).toBe(
        "usage",
      );
    }
    expect((await w.cli(["artifact", HEAD])).json.error).toBe("usage");
    const missing = await w.cli(["artifact", HEAD, "docs/comforge/none.md"]);
    expect(missing.code).not.toBe(0);
  });

  test("artifacts.readable replaces the report directory default", async () => {
    world = createWorld({ config: operatorConfig({ artifacts: { readable: ["docs/public"] } }) });
    const w = world;
    w.gh.files.set(`${HEAD}:docs/public/a.md`, "a\n");
    w.gh.files.set(`${HEAD}:docs/comforge/report.md`, "r\n");
    expect((await w.cli(["artifact", HEAD, "docs/public/a.md"])).code).toBe(0);
    expect((await w.cli(["artifact", HEAD, "docs/comforge/report.md"])).json.error).toBe(
      "policy-denied",
    );
  });

  test("artifactReadable: prefix match is directory-bounded", () => {
    const parse = (extra: Record<string, unknown>) => ConfigSchema.parse(baseConfig(extra));
    const defaults = parse({});
    expect(artifactReadable(defaults, "docs/comforge/a.md")).toBe(true);
    expect(artifactReadable(defaults, "docs/comforge")).toBe(true);
    expect(artifactReadable(defaults, "docs/comforge-other/a.md")).toBe(false);
    const custom = parse({ artifacts: { readable: ["docs/x"] } });
    expect(artifactReadable(custom, "docs/x/y.md")).toBe(true);
    expect(artifactReadable(custom, "docs/comforge/a.md")).toBe(false);
  });
});

describe("configuration", () => {
  test("review and artifacts sections validate; unknown keys and bad capabilities are refused", () => {
    const parse = (extra: Record<string, unknown>) =>
      ConfigSchema.safeParse(baseConfig(extra)).success;
    expect(parse({ review: REVIEW })).toBe(true);
    expect(parse({ review: { ...REVIEW, surprise: 1 } })).toBe(false);
    expect(parse({ review: { ...REVIEW, reviewScheme: "no-version" } })).toBe(false);
    expect(parse({ review: { ...REVIEW, trustedAuthors: ["not ok"] } })).toBe(false);
    expect(parse({ artifacts: { readable: ["docs/x"] } })).toBe(true);
    expect(parse({ artifacts: { readable: ["/etc"] } })).toBe(false);
    expect(parse({ artifacts: { other: [] } })).toBe(false);
    const caps = (capabilities: string[]) =>
      parse({ security: { credentials, authorization: { mode: "operator" }, capabilities } });
    expect(caps(["issues:create", "issues:update"])).toBe(true);
    expect(caps(["issues:delete"])).toBe(false);
  });
});

// M17: where review and artifact policy comes from, and what cannot widen it.
describe("trust boundary of review and artifact policy", () => {
  const writeWorking = (w: World, config: Record<string, unknown>) =>
    writeFileSync(path.join(w.primary, "comforge.config.json"), `${JSON.stringify(config)}\n`);
  const contents = (w: World, from: number) =>
    w.gh.requests.slice(from).filter((r) => r.path.includes("/contents/"));

  test("an uncommitted edit of the primary's configuration widens neither artifacts nor review trust", async () => {
    world = createWorld({ config: operatorConfig() });
    const w = world;
    const { comment, pr } = await (async () => {
      const p = openPull(w);
      const done = await w.cli([
        "review",
        "publish",
        "--review-file",
        reviewFile(w, review(p.number)),
        "--execute",
      ]);
      return { pr: p, comment: w.gh.comments.get(done.json.commentId)! };
    })();
    w.gh.seedComment(pr.number, comment.body, "mallory");
    w.gh.files.set(`${HEAD}:src/secret.ts`, "export const x = 1;\n");
    // Same remote and base, wider policy: only the base revision's configuration counts.
    writeWorking(
      w,
      operatorConfig({
        review: { ...REVIEW, trustedAuthors: [BOT, "mallory"] },
        artifacts: { readable: ["src"] },
      }),
    );
    const before = w.gh.requests.length;
    expect((await w.cli(["artifact", HEAD, "src/secret.ts"])).json.error).toBe("policy-denied");
    expect(contents(w, before)).toEqual([]);
    const list = await w.cli(["review", "list", String(pr.number)]);
    const byAuthor = Object.fromEntries(list.json.reviews.map((r: any) => [r.author, r]));
    expect(byAuthor.mallory.provenance).toBe("untrusted_author");
    expect(byAuthor[BOT].provenance).toBe("trusted_author");
  });

  test("a working configuration naming another base branch is refused before any GitHub request", async () => {
    world = createWorld({ config: operatorConfig() });
    const w = world;
    // A branch whose committed configuration is wider but still names main as its base.
    w.sh(w.primary, "git", "checkout", "--quiet", "-b", "wider");
    w.commitFile(
      w.primary,
      "comforge.config.json",
      `${JSON.stringify(operatorConfig({ artifacts: { readable: ["src"] } }))}\n`,
      "widen",
    );
    w.sh(w.primary, "git", "push", "--quiet", "origin", "wider");
    w.sh(w.primary, "git", "checkout", "--quiet", "main");
    writeWorking(
      w,
      operatorConfig({
        repository: { owner: "acme", name: "widgets", baseBranch: "wider", remote: "origin" },
      }),
    );
    const pr = openPull(w);
    const before = w.gh.requests.length;
    for (const args of [
      ["artifact", HEAD, "src/secret.ts"],
      ["review", "list", String(pr.number)],
      ["review", "publish", "--review-file", reviewFile(w, review(pr.number))],
      ["prs"],
      ["comments", "1"],
      ...[specArgs(w)],
    ]) {
      const r = await w.cli(args);
      expect([args[0], r.code === 0, r.json.error]).toEqual([
        args[0],
        false,
        "untrusted-config-change",
      ]);
    }
    expect(w.gh.requests.slice(before)).toEqual([]);
  });

  test("a candidate changing review, artifacts or only the report directory is a trusted change", () => {
    const parse = (extra: Record<string, unknown>) => ConfigSchema.parse(operatorConfig(extra));
    const trusted = parse({});
    expect(trustedChanges(trusted, parse({}))).toEqual([]);
    expect(
      trustedChanges(trusted, parse({ review: { ...REVIEW, trustedAuthors: [BOT, "mallory"] } })),
    ).toEqual(["review"]);
    expect(
      trustedChanges(trusted, parse({ review: { ...REVIEW, markerNamespace: "other" } })),
    ).toEqual(["review"]);
    expect(trustedChanges(trusted, parse({ artifacts: { readable: ["src"] } }))).toEqual([
      "artifacts",
    ]);
    // The default readable set is the report directory: moving it widens what may be read.
    expect(trustedChanges(trusted, parse({ evidence: { reportDir: "src" } }))).toEqual([
      "artifacts",
    ]);
    // Spelling the default explicitly reads the same files and is still a change of the section.
    expect(trustedChanges(trusted, parse({ artifacts: { readable: ["docs/comforge"] } }))).toEqual([
      "artifacts",
    ]);
    // With an explicit list, the report directory no longer decides what is readable.
    const listed = parse({ artifacts: { readable: ["docs/public"] } });
    expect(
      trustedChanges(
        listed,
        parse({ artifacts: { readable: ["docs/public"] }, evidence: { reportDir: "src" } }),
      ),
    ).toEqual([]);
  });

  test("publication of a candidate that moves the report directory is refused", async () => {
    world = createWorld({
      config: baseConfig({
        security: {
          credentials,
          authorization: { mode: "operator" },
          capabilities: ["pulls:create", "pulls:update", "issues:comment"],
        },
      }),
    });
    const w = world;
    const issue = w.specIssue(TICKET);
    const { checkout } = (await w.cli(["start", TICKET, "--issue", String(issue)])).json;
    const moved = baseConfig({
      evidence: { reportDir: "src" },
      security: {
        credentials,
        authorization: { mode: "operator" },
        capabilities: ["pulls:create", "pulls:update", "issues:comment"],
      },
    });
    w.commitFile(
      checkout,
      "comforge.config.json",
      `${JSON.stringify(moved)}\n`,
      `feat: move reports\n\nTicket: ${TICKET}`,
    );
    expect((await w.cli(["verify", TICKET])).code).toBe(0);
    const before = w.gh.writes().length;
    const r = await w.cli(["publish", TICKET, "--title", "Move", "--execute"]);
    expect(r.json).toMatchObject({
      error: "untrusted-config-change",
      detail: { sections: ["artifacts"] },
    });
    expect(w.gh.writes().length).toBe(before);
  });

  test("non-canonical artifact paths are refused before any contents request", async () => {
    world = createWorld({ config: operatorConfig() });
    const w = world;
    w.gh.files.set(`${HEAD}:docs/comforge/report.md`, "# Report\n");
    const before = w.gh.requests.length;
    for (const p of [
      "docs/comforge/./report.md",
      "docs/comforge//report.md",
      "./docs/comforge/report.md",
      "/docs/comforge/report.md",
      "docs\\comforge\\report.md",
      "docs/comforge/report.md/",
      "docs/comforge/../comforge/report.md",
      "docs/comforge/report.md\u0001",
    ]) {
      expect(artifactReadable(ConfigSchema.parse(operatorConfig()), p)).toBe(false);
      const r = await w.cli(["artifact", HEAD, p]);
      expect([p, r.json.error, r.json.detail?.reason]).toEqual([
        p,
        "policy-denied",
        "not a canonical repository path",
      ]);
    }
    expect(contents(w, before)).toEqual([]);
  });

  test("readable entries must be canonical and unique; a trusted author list is matched exactly", async () => {
    const ok = (readable: string[]) =>
      ConfigSchema.safeParse(operatorConfig({ artifacts: { readable } })).success;
    expect(ok(["docs/x", "docs/y"])).toBe(true);
    for (const bad of [
      ["docs/x/"],
      ["docs/./x"],
      ["docs//x"],
      [""],
      ["docs\\x"],
      ["../x"],
      ["docs/x", "docs/x"],
    ])
      expect([bad, ok(bad)]).toEqual([bad, false]);
    // A differently cased login is not the configured identity: nothing is trusted (fail closed).
    world = createWorld({
      config: operatorConfig({
        review: { ...REVIEW, trustedAuthors: [BOT.replace(/^[a-z]/, (c) => c.toUpperCase())] },
      }),
    });
    const w = world;
    const pr = openPull(w);
    await w.cli([
      "review",
      "publish",
      "--review-file",
      reviewFile(w, review(pr.number)),
      "--execute",
    ]);
    const list = await w.cli(["review", "list", String(pr.number)]);
    expect(list.json.reviews[0]).toMatchObject({
      integrity: "verified",
      provenance: "untrusted_author",
    });
  });
});

describe("services API", () => {
  const repository = (w: World) => ({ root: w.primary, commonDir: path.join(w.primary, ".git") });

  test("results are ServiceResults with stable error codes; an `authorized` field is ignored", async () => {
    world = createWorld({
      config: baseConfig({ review: REVIEW, security: { credentials, capabilities: SPEC_CAPS } }),
    });
    const w = world;
    const services = createLifecycleServices({ runtime: w.rt(), repository: repository(w) });
    const dry = await services.publishSpecification({
      ticket: TICKET,
      title: "DEMO-001 specification",
      body: "Build.",
      execute: false,
    });
    expect(dry).toEqual({
      ok: true,
      exit: 0,
      value: expect.objectContaining({ action: "create", executed: false }),
    });
    // A caller cannot authorize itself: no security.authorization still refuses.
    const forced = await services.publishSpecification({
      ticket: TICKET,
      title: "DEMO-001 specification",
      body: "Build.",
      execute: true,
      authorized: { mode: "operator" },
    } as never);
    expect(forced).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "authorization-required" }),
    });
    expect(w.gh.writes()).toEqual([]);

    const pr = openPull(w);
    const published = await services.publishReview({
      review: review(pr.number),
      execute: true,
      authorized: { mode: "operator" },
    } as never);
    expect(published).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "authorization-required" }),
    });
    const bad = await services.publishReview({ review: { nope: 1 }, execute: false });
    expect(bad).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "usage", exit: expect.any(Number) }),
    });
    const reads = await services.advisoryReviews({ pr: pr.number });
    expect(reads).toMatchObject({ ok: true, value: { kind: "advisory", reviews: [] } });
    expect(await services.issueComments({ issue: pr.number })).toMatchObject({ ok: true });
    expect(await services.pullRequests({})).toMatchObject({ ok: true, value: { state: "open" } });
    expect(await services.artifact({ commit: "main", path: "docs/comforge/a.md" })).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "usage" }),
    });
    expect(w.gh.writes()).toEqual([]);
  });

  test("an operator-mode service publishes under the trusted configuration", async () => {
    world = createWorld({ config: operatorConfig() });
    const w = world;
    const services = createLifecycleServices({ runtime: w.rt(), repository: repository(w) });
    const done = await services.publishSpecification({
      ticket: TICKET,
      title: "DEMO-001 specification",
      body: "Build.",
      execute: true,
    });
    expect(done).toMatchObject({
      ok: true,
      value: { action: "created", authorization: { mode: "operator" } },
    });
    const pr = openPull(w);
    const r = await services.publishReview({ review: review(pr.number), execute: true });
    expect(r).toMatchObject({ ok: true, value: { action: "created", kind: "advisory" } });
  });
});
