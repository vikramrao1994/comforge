import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createPrivateKey, generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRuntimeAuthority, ed25519Signer, RUNTIME_AUTHORITY_SCHEMA } from "@comforge/cli/authority";
import { canonicalJson, keyIdFor } from "@comforge/core";
import { approvalFromCandidate, buildCandidateRecord, type CandidateInput, CandidateRefusal, type ReleaseCandidate } from "../../tooling/release/candidate";
import { ApprovalRefusal, type ApproveIo, addTrustedKey, approveCandidate, generateReleaseKey } from "../../tooling/release/releaseApprove";
import {
  AUTHORIZATION_SCHEME,
  type AuthorizationEnvelope,
  AuthorizationRefusal,
  buildAuthorization,
  decodeEnvelope,
  encodeEnvelope,
  otherRunsCarrying,
  PUBLISH_WORKFLOW,
  parseTrust,
  type ReleaseTrust,
  RUN_NAME_PREFIX,
  sha256,
  signAuthorization,
  TRUST_FILE,
  TRUST_SCHEMA,
  verifyDispatch,
  verifyReleaseAuthorization,
} from "../../tooling/release/releaseAuthorization";
import { INTENT_SCHEMA } from "../../tooling/release/releaseIntent";
import { evaluatePlan, type PlanInput } from "../../tooling/release/releasePlan";
import { RELEASE_REPOSITORY_SLUG as ENGINEERING_REPOSITORY_SLUG } from "../../tooling/release/repository";

// COMFORGE-RELEASE-APPROVAL-001: a release is published only with the owner's signed
// authorization of exactly the candidate being published. Every refusal named in the ticket
// (Phase C) has a scenario here; the valid case must reach the existing publisher's approval.

const REPO = path.resolve(import.meta.dir, "../..");
const SOURCE = "a".repeat(40);
const OWNER = "the-owner";
const NOW = new Date("2026-11-24T12:00:00.000Z");
const WORKFLOW_SHA = sha256("workflow v1");
const FILES = { "src/index.ts": "1", "dist/index.js": "2" };

const planInput = (head = SOURCE): PlanInput => ({
  package: "@comforge/core",
  head,
  baseline: { version: "0.1.2", sourceCommit: "0".repeat(40), files: FILES },
  headVersion: "0.1.3",
  changelog: "# C\n\n## 0.1.3\n\n- Fix a thing.\n\n## 0.1.2\n",
  candidateFiles: { ...FILES, "src/index.ts": "3", "dist/index.js": "4" },
  manifestChanged: false,
  exports: { before: ["a"], after: ["a"] },
  commits: [{ sha: "1".repeat(40), subject: "fix", libraryChange: true, intentsAdded: ["release-intents/fix.json"] }],
  intents: [
    {
      file: "release-intents/fix.json",
      intent: { schema: INTENT_SCHEMA, package: "@comforge/core", bump: "patch", summary: "Fix a thing.", breaking: null, covers: [] },
      addedIn: "1".repeat(40),
    },
  ],
  editedIntents: [],
  invalidIntents: [],
});
const rebuilt = (over: Partial<Omit<CandidateInput, "ci">> = {}): Omit<CandidateInput, "ci"> => ({
  package: "@comforge/core",
  version: "0.1.3",
  tag: "core/v0.1.3",
  sourceCommit: SOURCE,
  releaseRecordSha256: "e".repeat(64),
  tarball: { sha256: "f".repeat(64), integrity: "sha512-x" },
  fileCount: 46,
  workflowChanges: [],
  workflowApproval: null,
  plan: evaluatePlan(planInput(over.sourceCommit ?? SOURCE)),
  ...over,
});
const green = { ok: true, checks: [{ name: "Validate (test:verify)", conclusion: "success" }] };
const red = { ok: false, checks: [{ name: "Validate (test:verify)", conclusion: "failure" }] };
const candidateFor = (over: Partial<Omit<CandidateInput, "ci">> = {}, ci = green) => buildCandidateRecord({ ...rebuilt(over), ci });

function keyPair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  return { privateKey, publicKeyPem, keyId: keyIdFor(publicKeyPem) };
}
const owner = keyPair();
const agent = keyPair();
const trust: ReleaseTrust = parseTrust({
  schema: TRUST_SCHEMA,
  keys: [{ keyId: owner.keyId, publicKeyPem: owner.publicKeyPem, login: OWNER, label: "owner" }],
  revoked: [],
});

function authorize(
  candidate: ReleaseCandidate,
  over: { key?: typeof owner; issuer?: string; now?: Date; lifetimeMs?: number; workflowSha256?: string; id?: string } = {},
): AuthorizationEnvelope {
  const record = buildAuthorization({
    candidate,
    workflowSha256: over.workflowSha256 ?? WORKFLOW_SHA,
    repository: ENGINEERING_REPOSITORY_SLUG,
    issuer: over.issuer ?? OWNER,
    authorizationId: over.id ?? randomUUID(),
    nonce: randomBytes(16).toString("hex"),
    candidateRun: 42,
    now: over.now ?? NOW,
    lifetimeMs: over.lifetimeMs,
  });
  return signAuthorization(record, (over.key ?? owner).privateKey);
}

const candidate = candidateFor();
const context = (over: Partial<Parameters<typeof verifyReleaseAuthorization>[1]> = {}) => ({
  trust,
  repository: ENGINEERING_REPOSITORY_SLUG,
  candidate,
  workflowSha256: WORKFLOW_SHA,
  triggeringActor: OWNER,
  approveWorkflows: "",
  now: new Date(NOW.getTime() + 60_000),
  ...over,
});
const refusal = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error) {
    if (error instanceof AuthorizationRefusal || error instanceof CandidateRefusal || error instanceof ApprovalRefusal) return error.code;
    throw error;
  }
  return "authorized";
};
const resign = (envelope: AuthorizationEnvelope, edit: (a: Record<string, unknown>) => void, key = owner) => {
  const a = structuredClone(envelope.authorization) as Record<string, unknown>;
  edit(a);
  return {
    ...envelope,
    authorization: a,
    signature: sign(null, Buffer.from(`${AUTHORIZATION_SCHEME}\n${canonicalJson(a)}`), key.privateKey).toString("base64url"),
  };
};

describe("valid owner authorization", () => {
  test("is eligible for the existing release publisher", () => {
    const envelope = authorize(candidate);
    const a = verifyReleaseAuthorization(envelope, context());
    expect(a.candidateDigest).toBe(candidate.digest);
    expect(a.action).toBe("comforge.release.publish");
    // The publisher's own candidate gate yields the approval it pushes with.
    expect(approvalFromCandidate(candidate, rebuilt())).toBe(`0.1.3@${SOURCE}`);
    expect(() =>
      verifyDispatch({ packageInput: "core", authorization: a, authorizationIdInput: a.authorizationId, runAttempt: "1", sha: SOURCE, workflowSha: SOURCE }),
    ).not.toThrow();
  });

  test("survives the workflow-input encoding", () => {
    const envelope = authorize(candidate);
    expect(refusal(() => verifyReleaseAuthorization(decodeEnvelope(encodeEnvelope(envelope)), context()))).toBe("authorized");
  });
});

describe("refusals (COMFORGE-RELEASE-APPROVAL-001 Phase C)", () => {
  test("missing authorization", () => {
    expect(refusal(() => decodeEnvelope(""))).toBe("authorization-missing");
    expect(refusal(() => decodeEnvelope(undefined))).toBe("authorization-missing");
    expect(refusal(() => verifyReleaseAuthorization(undefined, context()))).toBe("authorization-missing");
    expect(refusal(() => decodeEnvelope("not base64 json"))).toBe("authorization-malformed");
  });

  test("wrong candidate digest", () => {
    const other = candidateFor({ releaseRecordSha256: "d".repeat(64) });
    const envelope = authorize(other);
    expect(refusal(() => verifyReleaseAuthorization(envelope, context()))).toBe("authorization-mismatch");
    expect(() => verifyReleaseAuthorization(envelope, context())).toThrow(/candidateDigest/);
  });

  test("wrong source SHA", () => {
    const envelope = resign(authorize(candidate), (a) => {
      a.sourceCommit = "b".repeat(40);
    });
    expect(() => verifyReleaseAuthorization(envelope, context())).toThrow(/sourceCommit/);
  });

  test("wrong package or version", () => {
    for (const [field, value] of [
      ["package", "@comforge/other"],
      ["version", "0.1.4"],
      ["tag", "core/v0.1.4"],
    ] as const) {
      const envelope = resign(authorize(candidate), (a) => {
        a[field] = value;
      });
      expect(() => verifyReleaseAuthorization(envelope, context())).toThrow(new RegExp(`\\(authorization-mismatch\\).*${field}`));
    }
  });

  test("expired, not yet valid, or valid for longer than a day", () => {
    const envelope = authorize(candidate);
    expect(refusal(() => verifyReleaseAuthorization(envelope, context({ now: new Date(NOW.getTime() + 61 * 60_000) })))).toBe("authorization-expired");
    expect(refusal(() => verifyReleaseAuthorization(envelope, context({ now: new Date(NOW.getTime() - 10 * 60_000) })))).toBe("authorization-not-yet-valid");
    expect(() => authorize(candidate, { lifetimeMs: 25 * 60 * 60_000 })).not.toThrow();
    expect(refusal(() => verifyReleaseAuthorization(authorize(candidate, { lifetimeMs: 25 * 60 * 60_000 }), context()))).toBe("authorization-malformed");
  });

  test("replayed: a re-run attempt, or another run that carried the same authorization", async () => {
    const a = authorize(candidate).authorization;
    expect(
      refusal(() =>
        verifyDispatch({ packageInput: "core", authorization: a, authorizationIdInput: a.authorizationId, runAttempt: "2", sha: SOURCE, workflowSha: SOURCE }),
      ),
    ).toBe("authorization-consumed");
    const runs = (list: { id: number; display_title: string }[]) =>
      (async () => new Response(JSON.stringify({ workflow_runs: list }), { status: 200 })) as unknown as typeof fetch;
    const title = `${RUN_NAME_PREFIX}${a.authorizationId}`;
    expect(
      await otherRunsCarrying({
        repository: "o/r",
        authorization: a,
        runId: 7,
        token: "t",
        fetchImpl: runs([
          { id: 7, display_title: title },
          { id: 5, display_title: title },
        ]),
      }),
    ).toEqual([5]);
    // A dry run and an unrelated release do not consume it.
    expect(
      await otherRunsCarrying({
        repository: "o/r",
        authorization: a,
        runId: 7,
        token: "t",
        fetchImpl: runs([
          { id: 7, display_title: title },
          { id: 6, display_title: "Comforge core candidate" },
          { id: 4, display_title: `${RUN_NAME_PREFIX}${randomUUID()}` },
        ]),
      }),
    ).toEqual([]);
  });

  test("concurrent dispatches of one authorization each see the other and both refuse", async () => {
    const a = authorize(candidate).authorization;
    const title = `${RUN_NAME_PREFIX}${a.authorizationId}`;
    const both = (async () =>
      new Response(
        JSON.stringify({
          workflow_runs: [
            { id: 8, display_title: title },
            { id: 9, display_title: title },
          ],
        }),
      )) as unknown as typeof fetch;
    for (const runId of [8, 9]) expect((await otherRunsCarrying({ repository: "o/r", authorization: a, runId, token: "t", fetchImpl: both })).length).toBe(1);
  });

  test("an unprovable consumption state refuses (fail closed)", async () => {
    const a = authorize(candidate).authorization;
    const failing = (async () => new Response("{}", { status: 403 })) as unknown as typeof fetch;
    const throwing = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    for (const fetchImpl of [failing, throwing])
      await expect(otherRunsCarrying({ repository: "o/r", authorization: a, runId: 1, token: "t", fetchImpl })).rejects.toThrow(/authorization-unavailable/);
  });

  test("revoked", () => {
    const envelope = authorize(candidate);
    const revoked = { ...trust, revoked: [{ authorizationId: envelope.authorization.authorizationId, reason: "owner changed their mind" }] };
    expect(refusal(() => verifyReleaseAuthorization(envelope, context({ trust: revoked })))).toBe("authorization-revoked");
  });

  test("an unknown issuer: an untrusted key, a trusted key naming someone else, or another dispatcher", () => {
    expect(refusal(() => verifyReleaseAuthorization(authorize(candidate, { key: agent }), context()))).toBe("authorization-untrusted");
    expect(refusal(() => verifyReleaseAuthorization(authorize(candidate, { issuer: "someone-else" }), context()))).toBe("authorization-issuer");
    expect(refusal(() => verifyReleaseAuthorization(authorize(candidate), context({ triggeringActor: "someone-else" })))).toBe("authorization-issuer");
    expect(refusal(() => verifyReleaseAuthorization(authorize(candidate), context({ triggeringActor: "" })))).toBe("authorization-issuer");
  });

  test("a tampered signature or record", () => {
    const envelope = authorize(candidate);
    const flipped = envelope.signature.startsWith("A") ? `B${envelope.signature.slice(1)}` : `A${envelope.signature.slice(1)}`;
    expect(refusal(() => verifyReleaseAuthorization({ ...envelope, signature: flipped }, context()))).toBe("authorization-signature");
    const edited = { ...envelope, authorization: { ...envelope.authorization, expiresAt: "2026-11-30T00:00:00.000Z" } };
    expect(refusal(() => verifyReleaseAuthorization(edited, context()))).toBe("authorization-signature");
    // A record re-signed by a key that is not trusted, claiming a trusted key id.
    const forged = { ...resign(envelope, () => {}, agent), keyId: owner.keyId };
    expect(refusal(() => verifyReleaseAuthorization(forged, context()))).toBe("authorization-signature");
  });

  test("a modified workflow digest", () => {
    expect(refusal(() => verifyReleaseAuthorization(authorize(candidate), context({ workflowSha256: sha256("workflow v2") })))).toBe("authorization-workflow");
  });

  test("source changes after approval", () => {
    const envelope = authorize(candidate);
    const moved = "c".repeat(40);
    // The run is for a newer main: the dispatch check refuses.
    expect(
      refusal(() =>
        verifyDispatch({
          packageInput: "core",
          authorization: envelope.authorization,
          authorizationIdInput: envelope.authorization.authorizationId,
          runAttempt: "1",
          sha: moved,
          workflowSha: moved,
        }),
      ),
    ).toBe("authorization-mismatch");
    // And the candidate built from it is not the approved one.
    expect(refusal(() => verifyReleaseAuthorization(envelope, context({ candidate: candidateFor({ sourceCommit: moved }) })))).toBe("authorization-mismatch");
    // A rebuild that no longer matches the approved candidate never reaches the publisher.
    expect(refusal(() => approvalFromCandidate(candidate, rebuilt({ sourceCommit: moved })))).toBe("candidate-stale");
  });

  test("failed CI", async () => {
    const failing = candidateFor({}, red);
    expect(refusal(() => approvalFromCandidate(failing, rebuilt()))).toBe("ci-unproven");
    expect(await approvalOutcome({ candidate: failing })).toBe("ci-unproven");
  });

  test("an unauthorized workflow dispatch", () => {
    const a = authorize(candidate).authorization;
    // authorization_id names the run; it must be the signed record's.
    expect(
      refusal(() =>
        verifyDispatch({ packageInput: "core", authorization: a, authorizationIdInput: randomUUID(), runAttempt: "1", sha: SOURCE, workflowSha: SOURCE }),
      ),
    ).toBe("authorization-dispatch");
    // A dispatch carrying only `publish` has nothing to verify.
    expect(refusal(() => decodeEnvelope(""))).toBe("authorization-missing");
    // approve_workflows must be the mirror-workflow change the owner signed.
    expect(refusal(() => verifyReleaseAuthorization(authorize(candidate), context({ approveWorkflows: ".github/workflows/x.yml@abc" })))).toBe(
      "authorization-mismatch",
    );
  });

  test("an agent-generated approval: an engineering lifecycle grant, an agent key, another repository", () => {
    const grant = engineeringGrant(owner.privateKey.export({ type: "pkcs8", format: "pem" }).toString());
    expect(refusal(() => verifyReleaseAuthorization(grant, context()))).toBe("authorization-malformed");
    expect(refusal(() => verifyReleaseAuthorization({ authorization: grant.grant, keyId: grant.keyId, signature: grant.signature }, context()))).toBe(
      "authorization-malformed",
    );
    expect(refusal(() => verifyReleaseAuthorization(authorize(candidate, { key: agent }), context()))).toBe("authorization-untrusted");
    const elsewhere = resign(authorize(candidate), (a) => {
      a.repository = "someone/fork";
    });
    expect(refusal(() => verifyReleaseAuthorization(elsewhere, context()))).toBe("authorization-repository");
  });

  test("a trust file whose key id does not match its key", () => {
    expect(
      refusal(() =>
        parseTrust({ schema: TRUST_SCHEMA, keys: [{ keyId: agent.keyId, publicKeyPem: owner.publicKeyPem, login: OWNER, label: "x" }], revoked: [] }),
      ),
    ).toBe("trust-invalid");
  });

  test("a failed attempt never permits a later retry with the same authorization; a new one is required", () => {
    const first = authorize(candidate).authorization;
    expect(
      refusal(() =>
        verifyDispatch({
          packageInput: "core",
          authorization: first,
          authorizationIdInput: first.authorizationId,
          runAttempt: "2",
          sha: SOURCE,
          workflowSha: SOURCE,
        }),
      ),
    ).toBe("authorization-consumed");
    const second = authorize(candidate);
    expect(second.authorization.authorizationId).not.toBe(first.authorizationId);
    expect(refusal(() => verifyReleaseAuthorization(second, context()))).toBe("authorized");
  });
});

// ---- The owner's approval command --------------------------------------------------------

const PASSPHRASE = "correct horse battery staple";
const encryptedOwnerKey = owner.privateKey.export({ type: "pkcs8", format: "pem", cipher: "aes-256-cbc", passphrase: PASSPHRASE }).toString();

function scriptedIo(answers: string[], interactive = true): ApproveIo & { printed: string[] } {
  const queue = [...answers];
  const printed: string[] = [];
  return {
    interactive,
    printed,
    print: (t) => printed.push(t),
    ask: async () => queue.shift() ?? "",
    askHidden: async () => queue.shift() ?? "",
  };
}

async function approvalOutcome(over: Partial<Parameters<typeof approveCandidate>[0]> = {}, io = scriptedIo(["0.1.3", PASSPHRASE])) {
  try {
    await approveCandidate(
      {
        candidate,
        candidateRun: 42,
        mainSha: SOURCE,
        workflowSha256: WORKFLOW_SHA,
        trust,
        keyPem: encryptedOwnerKey,
        repository: ENGINEERING_REPOSITORY_SLUG,
        now: NOW,
        ...over,
      },
      io,
    );
    return "approved";
  } catch (error) {
    if (error instanceof ApprovalRefusal || error instanceof CandidateRefusal || error instanceof AuthorizationRefusal) return error.code;
    throw error;
  }
}

describe("release:approve", () => {
  test("the owner types the version and the passphrase; the result verifies in the workflow", async () => {
    const io = scriptedIo(["0.1.3", PASSPHRASE]);
    const envelope = await approveCandidate(
      {
        candidate,
        candidateRun: 42,
        mainSha: SOURCE,
        workflowSha256: WORKFLOW_SHA,
        trust,
        keyPem: encryptedOwnerKey,
        repository: ENGINEERING_REPOSITORY_SLUG,
        now: NOW,
      },
      io,
    );
    expect(io.printed.join("\n")).toContain(candidate.digest);
    expect(envelope.authorization.issuer).toBe(OWNER);
    expect(refusal(() => verifyReleaseAuthorization(envelope, context()))).toBe("authorized");
  });

  test("without a terminal it refuses before anything else (an agent cannot approve)", async () => {
    expect(await approvalOutcome({}, scriptedIo(["0.1.3", PASSPHRASE], false))).toBe("not-interactive");
  });

  test("an unencrypted key, a wrong passphrase, an untrusted key, or no explicit approval refuses", async () => {
    const plain = owner.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    expect(await approvalOutcome({ keyPem: plain })).toBe("key-unprotected");
    expect(await approvalOutcome({}, scriptedIo(["0.1.3", "wrong passphrase"]))).toBe("key-locked");
    const agentKey = agent.privateKey.export({ type: "pkcs8", format: "pem", cipher: "aes-256-cbc", passphrase: PASSPHRASE }).toString();
    expect(await approvalOutcome({ keyPem: agentKey })).toBe("key-untrusted");
    expect(await approvalOutcome({}, scriptedIo(["yes", PASSPHRASE]))).toBe("declined");
    expect(await approvalOutcome({}, scriptedIo(["", PASSPHRASE]))).toBe("declined");
  });

  test("a candidate not built from origin/main, or a tampered one, is never shown for approval", async () => {
    expect(await approvalOutcome({ mainSha: "c".repeat(40) })).toBe("candidate-stale");
    expect(await approvalOutcome({ candidate: { ...candidate, version: "0.2.0" } })).toBe("candidate-invalid");
  });

  test("a mirror-workflow change needs its own typed confirmation and is signed into the record", async () => {
    const approval = ".github/workflows/npm-publish.yml@" + "9".repeat(64);
    const changing = candidateFor({ workflowChanges: [{ file: ".github/workflows/npm-publish.yml", sha256: "9".repeat(64) }], workflowApproval: approval });
    expect(await approvalOutcome({ candidate: changing }, scriptedIo(["0.1.3", "no", PASSPHRASE]))).toBe("declined");
    const envelope = await approveCandidate(
      {
        candidate: changing,
        candidateRun: 1,
        mainSha: SOURCE,
        workflowSha256: WORKFLOW_SHA,
        trust,
        keyPem: encryptedOwnerKey,
        repository: ENGINEERING_REPOSITORY_SLUG,
        now: NOW,
      },
      scriptedIo(["0.1.3", "approve workflow change", PASSPHRASE]),
    );
    expect(envelope.authorization.mirrorWorkflowApproval).toBe(approval);
    expect(refusal(() => verifyReleaseAuthorization(envelope, context({ candidate: changing, approveWorkflows: approval })))).toBe("authorized");
    expect(refusal(() => verifyReleaseAuthorization(envelope, context({ candidate: changing, approveWorkflows: "" })))).toBe("authorization-mismatch");
  });
});

describe("release:keygen", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "release-keygen-"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("writes an encrypted key outside the repository and a matching trust entry", async () => {
    const out = path.join(dir, "key.pem");
    const entry = await generateReleaseKey({ out, login: OWNER, label: "owner", repoRoot: REPO }, scriptedIo([PASSPHRASE, PASSPHRASE]));
    const pem = readFileSync(out, "utf8");
    expect(pem).toContain("BEGIN ENCRYPTED PRIVATE KEY");
    expect(keyIdFor(entry.publicKeyPem)).toBe(entry.keyId);
    expect(() => createPrivateKey({ key: pem, format: "pem", passphrase: PASSPHRASE })).not.toThrow();
    const trustFile = path.join(dir, "trust.json");
    writeFileSync(trustFile, JSON.stringify({ schema: TRUST_SCHEMA, keys: [], revoked: [] }));
    addTrustedKey(trustFile, entry);
    addTrustedKey(trustFile, entry);
    expect(parseTrust(JSON.parse(readFileSync(trustFile, "utf8"))).keys.map((k) => k.keyId)).toEqual([entry.keyId]);
  });

  test("refuses a terminal-less caller, a key inside the repository, a short or mismatched passphrase", async () => {
    const outcome = async (fn: () => Promise<unknown>) => {
      try {
        await fn();
        return "generated";
      } catch (error) {
        return error instanceof ApprovalRefusal ? error.code : String(error);
      }
    };
    const out = path.join(dir, "k2.pem");
    expect(await outcome(() => generateReleaseKey({ out, login: OWNER, label: "x", repoRoot: REPO }, scriptedIo([PASSPHRASE, PASSPHRASE], false)))).toBe(
      "not-interactive",
    );
    expect(
      await outcome(() =>
        generateReleaseKey({ out: path.join(REPO, "generated", "k.pem"), login: OWNER, label: "x", repoRoot: REPO }, scriptedIo([PASSPHRASE, PASSPHRASE])),
      ),
    ).toBe("key-location");
    expect(await outcome(() => generateReleaseKey({ out, login: OWNER, label: "x", repoRoot: REPO }, scriptedIo(["short", "short"])))).toBe("key-unprotected");
    expect(await outcome(() => generateReleaseKey({ out, login: OWNER, label: "x", repoRoot: REPO }, scriptedIo([PASSPHRASE, `${PASSPHRASE}!`])))).toBe(
      "declined",
    );
  });
});

describe("the committed trust file", () => {
  test("is valid and lists only keys whose id matches", () => {
    expect(() => parseTrust(JSON.parse(readFileSync(path.join(REPO, TRUST_FILE), "utf8")))).not.toThrow();
  });
});

// ---- The workflow's verify step, end to end ----------------------------------------------

describe("releaseAuthorization.ts verify (the workflow gate)", () => {
  let repo: string;
  let server: ReturnType<typeof Bun.serve>;
  let runs: { id: number; display_title: string }[] = [];
  let head: string;
  let signed: ReleaseCandidate;

  beforeAll(() => {
    repo = mkdtempSync(path.join(tmpdir(), "release-verify-"));
    const g = (...args: string[]) => spawnSync("git", args, { cwd: repo, encoding: "utf8" }).stdout.trim();
    g("init", "-q", "-b", "main");
    mkdirSync(path.join(repo, path.dirname(TRUST_FILE)), { recursive: true });
    mkdirSync(path.join(repo, path.dirname(PUBLISH_WORKFLOW)), { recursive: true });
    writeFileSync(path.join(repo, TRUST_FILE), JSON.stringify(trust));
    writeFileSync(path.join(repo, PUBLISH_WORKFLOW), "name: publish\n");
    g("add", "-A");
    g("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "--no-verify", "-m", "init");
    head = g("rev-parse", "HEAD");
    signed = candidateFor({ sourceCommit: head });
    writeFileSync(path.join(repo, "candidate.json"), JSON.stringify(signed));
    server = Bun.serve({ port: 0, fetch: () => Response.json({ workflow_runs: runs }) });
  });
  afterAll(() => {
    server.stop(true);
    rmSync(repo, { recursive: true, force: true });
  });

  // Async: the stub GitHub API runs in this process and must keep answering.
  const verifyCli = async (envelope: AuthorizationEnvelope | null, env: Record<string, string> = {}) => {
    const child = Bun.spawn(
      ["bun", path.join(REPO, "tooling/release/releaseAuthorization.ts"), "verify", "--candidate", "candidate.json", "--out", "out/authorization.json"],
      {
        cwd: repo,
        stdout: "pipe",
        stderr: "pipe",
        env: {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
          AUTHORIZATION: envelope ? encodeEnvelope(envelope) : "",
          AUTHORIZATION_ID: envelope?.authorization.authorizationId ?? "",
          PACKAGE: "core",
          APPROVE_WORKFLOWS: "",
          GITHUB_REPOSITORY: ENGINEERING_REPOSITORY_SLUG,
          GITHUB_TRIGGERING_ACTOR: OWNER,
          GITHUB_RUN_ID: "100",
          GITHUB_RUN_ATTEMPT: "1",
          GITHUB_SHA: head,
          GITHUB_WORKFLOW_SHA: head,
          GITHUB_TOKEN: "t",
          GITHUB_API_URL: `http://127.0.0.1:${server.port}`,
          ...env,
        },
      },
    );
    const [status, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    return { status, stderr };
  };
  const fresh = () => authorize(signed, { now: new Date(), workflowSha256: sha256("name: publish\n") });

  test("passes a valid owner authorization and writes it for the publisher", async () => {
    const envelope = fresh();
    runs = [{ id: 100, display_title: `${RUN_NAME_PREFIX}${envelope.authorization.authorizationId}` }];
    const r = await verifyCli(envelope);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(JSON.parse(readFileSync(path.join(repo, "out/authorization.json"), "utf8")).authorization.authorizationId).toBe(
      envelope.authorization.authorizationId,
    );
  }, 30_000);

  test.each([
    ["no authorization", null, {}, "authorization-missing"],
    ["a re-run", "fresh", { GITHUB_RUN_ATTEMPT: "2" }, "authorization-consumed"],
    ["another dispatcher", "fresh", { GITHUB_TRIGGERING_ACTOR: "someone-else" }, "authorization-issuer"],
    ["a fork", "fresh", { GITHUB_REPOSITORY: "someone/portfolio" }, "authorization-repository"],
    ["main moved", "fresh", { GITHUB_SHA: "c".repeat(40) }, "authorization-mismatch"],
  ] as const)(
    "refuses %s",
    async (_name, kind, env, code) => {
      const envelope = kind ? fresh() : null;
      runs = [];
      const r = await verifyCli(envelope, env);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(`(${code})`);
    },
    30_000,
  );

  test("refuses an authorization another run already carried", async () => {
    const envelope = fresh();
    const title = `${RUN_NAME_PREFIX}${envelope.authorization.authorizationId}`;
    runs = [
      { id: 100, display_title: title },
      { id: 99, display_title: title },
    ];
    const r = await verifyCli(envelope);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("(authorization-consumed)");
  }, 30_000);
});

// An engineering lifecycle grant (another authority's record, signed by the same key): the
// release gate must refuse it as malformed, never accept it as a release authorization.
function engineeringGrant(privateKeyPem: string) {
  const authority = createRuntimeAuthority({
    schema: RUNTIME_AUTHORITY_SCHEMA,
    repository: ENGINEERING_REPOSITORY_SLUG,
    ticketPattern: /^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+$/,
    branchForTicket: (t: string) => `agent/${t.toLowerCase()}`,
    grantScheme: "example-engineering-grant/v1",
    receiptScheme: "example-engineering-receipt/v1",
    separateFrom: [],
  });
  return authority.grants.issue(
    {
      schema: authority.grants.scheme,
      grantId: randomUUID(),
      nonce: "0".repeat(32),
      repository: ENGINEERING_REPOSITORY_SLUG,
      ticket: "DEMO-RELEASE-001",
      issue: 1,
      specDigest: "0".repeat(64),
      mode: "implementation",
      capabilities: [],
      base: { kind: "origin-main" },
      maxAttempts: 1,
      issuedAt: NOW.toISOString(),
      expiresAt: new Date(NOW.getTime() + 60 * 60 * 1000).toISOString(),
    },
    ed25519Signer(privateKeyPem),
  );
}
