import {
  evaluateLifecycleAction,
  FactoryCoreError,
  idempotencyKeyDigest,
  isReviewStale,
  reviewProvenance,
} from "@comforge/core";
import { completions, grants, receipts, reviews, specifications } from "./identity.ts";
import { signGrant, signReceipt, testKey, trusted } from "./testSigner.ts";

export interface Check {
  id: string;
  pass: boolean;
  detail?: string;
}

// Synthetic, deterministic observations. In a real integration each of these comes from
// your own trusted adapter (your Git, your forge API, your clock), never from the record
// being checked and never from an agent's claim.
const TICKET = "ACME-101";
const ISSUE = 12;
const BASE = "1".repeat(40);
const CANDIDATE = "2".repeat(40);
const TREE = "3".repeat(40);
const MOVED_HEAD = "4".repeat(40);
const NOW = new Date("2030-06-01T12:00:00.000Z");

const refusal = (run: () => unknown): string | null => {
  try {
    run();
    return null;
  } catch (err) {
    if (err instanceof FactoryCoreError) return `${err.code}: ${err.message}`;
    throw err;
  }
};

/** Use case 1: publish a specification, then verify what the forge serves back. */
export function specificationFlow(): Check[] {
  // #region specification
  const spec = {
    ticketId: TICKET,
    title: "Rate-limit the export endpoint",
    body: "## Objective\n\nReturn 429 after 10 requests per minute.\n",
  };
  const digest = specifications.specificationDigest(spec);
  const issueBody = specifications.composeIssueBody({
    ticketId: spec.ticketId,
    body: spec.body,
    digest,
    keyDigest: idempotencyKeyDigest("acme-spec-key-0001"),
  });
  // Later, read the issue back from your forge and verify it.
  const verified = specifications.verifyPublishedSpecification({
    title: spec.title,
    body: issueBody,
  });
  // verified: { ticketId: "ACME-101", digest, digestScheme, digestMatches: true }
  const edited = specifications.verifyPublishedSpecification({
    title: spec.title,
    body: issueBody.replace("10 requests", "1000 requests"),
  });
  // edited?.digestMatches === false: the specification changed after publication.
  // #endregion specification
  return [
    { id: "specification-verifies", pass: verified?.digestMatches === true && verified.digest === digest },
    { id: "specification-edit-detected", pass: edited?.digestMatches === false },
    {
      id: "specification-absent-is-null",
      pass: specifications.verifyPublishedSpecification({ title: spec.title, body: "plain issue" }) === null,
    },
  ];
}

/** Use case 2: verify a signed grant and a signed receipt against keys you trust. */
export function authorizationFlow(): Check[] {
  const owner = testKey(1);
  const controller = testKey(2);
  const stranger = testKey(3);
  const spec = { ticketId: TICKET, title: "Rate-limit the export endpoint", body: "## Objective\n\nShip it.\n" };
  const specDigest = specifications.specificationDigest(spec);
  const liveSpecification = specifications.verifyPublishedSpecification({
    title: spec.title,
    body: specifications.composeIssueBody({ ...spec, digest: specDigest, keyDigest: idempotencyKeyDigest("k") }),
  });

  const grantFields = {
    schema: "acme-engineering-grant/v1",
    grantId: "00000000-0000-4000-8000-000000000001",
    nonce: "a".repeat(32),
    repository: "acme/widgets",
    ticket: TICKET,
    issue: ISSUE,
    specDigest,
    capabilities: [],
    base: { kind: "exact", sha: BASE },
    maxAttempts: 1,
    issuedAt: "2030-06-01T11:00:00.000Z",
    expiresAt: "2030-06-02T11:00:00.000Z",
  };
  const implementation = signGrant(grants.grantSchema.parse({ ...grantFields, mode: "implementation" }), owner);
  const publication = signGrant(
    grants.grantSchema.parse({
      ...grantFields,
      grantId: "00000000-0000-4000-8000-000000000002",
      mode: "publication",
      publication: { candidateSha: CANDIDATE, branch: "agent/acme-101" },
    }),
    owner,
  );

  // #region authorize
  // Trusted keys come from your own configuration, never from the envelope.
  const trustedKeys = [trusted(owner, "owner")];
  const context = {
    ticket: TICKET,
    issue: ISSUE,
    specification: liveSpecification, // verified from the issue you just fetched
    revoked: false, // from your own revocation list
    attemptsUsed: 0, // from your own ledger
    baseSha: BASE,
  };
  const granted = grants.authorizeAction(
    implementation,
    trustedKeys,
    { ...context, action: "launch-session" },
    NOW,
  );
  // An implementation grant never authorizes publication; that needs its own grant.
  const refused = refusal(() =>
    grants.authorizeAction(implementation, trustedKeys, { ...context, action: "publish", candidateSha: CANDIDATE, branch: "agent/acme-101" }, NOW),
  );
  // refused === "unauthorized: A implementation grant does not authorize publish"
  // #endregion authorize

  const receiptFields = {
    schema: "acme-engineering-receipt/v1",
    receiptId: "00000000-0000-4000-8000-0000000000b1",
    repository: "acme/widgets",
    ticket: TICKET,
    specDigest,
    executionId: "00000000-0000-4000-8000-0000000000c1",
    candidateSha: CANDIDATE,
    tree: TREE,
    baseSha: BASE,
    controllerRevision: BASE,
    profile: "command",
    command: "npm test",
    provisioning: ["npm ci"],
    provisioningDigest: "d".repeat(64),
    startedAt: "2030-06-01T11:10:00.000Z",
    completedAt: "2030-06-01T11:20:00.000Z",
    durationMs: 600_000,
    outcome: "PASS",
    summarySha256: null,
    summaryCounts: { tests: 12 },
    trustSensitiveChanges: [],
    workflowChanges: [],
    validationIntegrity: { focused: [], findings: [] },
    integrity: { objects: "ok", baseIsAncestor: true },
  };
  const receipt = signReceipt(receipts.receiptSchema.parse(receiptFields), controller);

  // #region verify-receipt
  const expectation = {
    ticket: TICKET,
    specDigest,
    candidateSha: CANDIDATE, // the commit you are about to publish, from your Git
    tree: TREE,
    controllerRevision: BASE, // the validation controller revision you trust
    now: NOW,
  };
  const verifiedReceipt = receipts.verifyReceipt(receipt, controller.publicKeyPem, expectation);
  // verifiedReceipt.outcome === "PASS"; any other commit, key or outcome throws.
  // #endregion verify-receipt

  return [
    { id: "grant-authorizes-its-action", pass: granted.mode === "implementation" },
    { id: "implementation-grant-cannot-publish", pass: refused === "unauthorized: A implementation grant does not authorize publish" },
    {
      id: "publication-grant-authorizes-publish",
      pass:
        grants.authorizeAction(publication, trustedKeys, { ...context, action: "publish", candidateSha: CANDIDATE, branch: "agent/acme-101" }, NOW)
          .mode === "publication",
    },
    {
      id: "untrusted-signer-refused",
      pass: refusal(() => grants.verifyEnvelope(signGrant(implementation.grant, stranger), trustedKeys, NOW)) === "unauthorized: The grant is signed by a key that is not trusted",
    },
    { id: "receipt-verifies", pass: verifiedReceipt.outcome === "PASS" },
    {
      id: "receipt-other-commit-refused",
      pass: refusal(() => receipts.verifyReceipt(receipt, controller.publicKeyPem, { ...expectation, candidateSha: MOVED_HEAD })) === "validation_failed: The receipt is for another commit",
    },
  ];
}

/** Use case 3: one lifecycle decision over evidence you observed yourself. */
export function lifecycleFlow(): Check[] {
  // #region lifecycle
  const decision = evaluateLifecycleAction({
    action: "publish",
    evidence: {
      head: CANDIDATE,
      validations: [
        { commit: CANDIDATE, status: "FAIL" },
        { commit: CANDIDATE, status: "PASS" }, // the latest validation of this commit decides
      ],
    },
  });
  if (decision.decision === "allow") {
    // decision.scope says what this allow means, and that it does not authorize publication.
  } else {
    // "deny": the evidence breaks a rule. "insufficient_evidence": something required is
    // missing. Never treat either as an allow.
    for (const reason of decision.reasons) console.error(reason.code, reason.message);
  }
  // #endregion lifecycle
  const deny = evaluateLifecycleAction({
    action: "publish",
    evidence: { head: CANDIDATE, validations: [{ commit: CANDIDATE, status: "UNAVAILABLE" }] },
  });
  const missing = evaluateLifecycleAction({ action: "publish", evidence: { head: CANDIDATE, validations: [] } });
  return [
    { id: "lifecycle-allow", pass: decision.decision === "allow" && /does not authorize/.test(decision.scope) },
    { id: "lifecycle-deny", pass: deny.decision === "deny" && deny.reasons[0]?.code === "validation_not_passing" },
    {
      id: "lifecycle-insufficient-evidence",
      pass: missing.decision === "insufficient_evidence" && missing.reasons[0]?.code === "validation_missing",
    },
    { id: "lifecycle-merge-unsupported", pass: evaluateLifecycleAction({ action: "merge", evidence: {} }).decision === "deny" },
  ];
}

/** Use case 4: read an advisory review and a completion record from comment text. */
export function recordsFlow(): Check[] {
  const reviewInput = reviews.inputSchema.parse({
    prNumber: 7,
    expectedHeadSha: CANDIDATE,
    ticketId: TICKET,
    verdict: "revision_recommended",
    summary: "One finding.",
    findings: [{ id: "M1", severity: "medium", title: "Check bounds", evidence: "Off by one.", requiredCorrection: "Use <=." }],
    idempotencyKey: "acme-review-key-0001",
  });
  const commentBody = reviews.composeReviewComment(reviews.buildReviewPayload(reviewInput, null), "c".repeat(32));

  // #region review
  const marker = reviews.parseReviewMarker(commentBody); // null if the comment has none
  const review = marker ? reviews.decodeReview(marker) : null;
  // review.integrity: "verified" | "mismatch" | "unreadable". Verified means unaltered, not trusted.
  const currentHead = MOVED_HEAD; // read from your forge now, never from the review
  const stale = marker ? isReviewStale(marker.headSha, currentHead) : true;
  // The author is the one your forge reports for the comment, checked against your own list.
  const provenance = reviewProvenance("acme-reviewer", ["acme-reviewer"]);
  // #endregion review

  const completionInput = completions.inputSchema.parse({
    contract: "acme-engineering-completion/v1",
    issueNumber: ISSUE,
    ticketId: TICKET,
    specificationDigest: "d".repeat(64),
    issueType: "implementation",
    outcome: "completed",
    sourceRevision: CANDIDATE,
    pullRequest: { number: 7, headSha: CANDIDATE },
    execution: { runner: "acme-runner" },
    summary: "Rate limit delivered.",
    sections: { changed_behavior: "The export endpoint returns 429 after 10 requests per minute." },
    validation: [{ gate: "unit", status: "PASS" }],
  });
  const completionBody = completions.composeCompletionComment(
    completions.buildCompletionPayload(completionInput, { digestVerified: true, ledgerGates: [], supersedes: [] }),
  );

  // #region completion
  const completionMarker = completions.parseCompletionMarker(completionBody);
  const completion = completionMarker ? completions.decodeCompletion(completionMarker) : null;
  // completion.integrity === "verified"; completion.payload holds the structured result.
  // #endregion completion

  return [
    { id: "review-verified", pass: review?.integrity === "verified" },
    { id: "review-stale-against-moved-head", pass: stale && marker !== null && !isReviewStale(marker.headSha, CANDIDATE) },
    { id: "review-author-trusted", pass: provenance === "trusted_author" && reviewProvenance("mallory", ["acme-reviewer"]) === "untrusted_author" },
    { id: "completion-verified", pass: completion?.integrity === "verified" && completion.payload?.outcome === "completed" },
    {
      id: "completion-tamper-detected",
      pass:
        completionMarker !== null &&
        completions.decodeCompletion({ ...completionMarker, ticketId: "ACME-102" }).integrity === "mismatch",
    },
  ];
}
