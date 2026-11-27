import { describe, expect, test } from "bun:test";
import {
  ACTION_MODES,
  evaluateLifecycleAction,
  LIFECYCLE_ACTIONS,
  LIFECYCLE_REASONS,
  type LifecycleDecision,
} from "../src/index.ts";

// Lifecycle decisions: allow, deny or insufficient
// evidence over observations the caller supplies, with stable reason codes. The
// consumers' own refusal wording is pinned by their golden vectors; this file pins the
// kernel's decisions, reason codes and the properties every decision shares.

const H = "a".repeat(40);
const OTHER = "b".repeat(40);
const BASE = "c".repeat(40);

const codes = (d: LifecycleDecision) =>
  d.decision === "allow" ? [] : d.reasons.map((r) => r.code);

describe("publish: exact-commit validation", () => {
  const publish = (validations: Array<{ commit: string; status: string }>) =>
    evaluateLifecycleAction({ action: "publish", evidence: { head: H, validations } });

  test("allows only when the latest validation of the exact head is PASS", () => {
    const allowed = publish([
      { commit: H, status: "FAIL" },
      { commit: H, status: "PASS" },
      { commit: OTHER, status: "FAIL" },
    ]);
    expect(allowed).toMatchObject({ decision: "allow", facts: { validationIndex: 1 } });
  });

  test("no validation of the head is insufficient evidence, never an allow", () => {
    expect(publish([{ commit: OTHER, status: "PASS" }])).toEqual({
      action: "publish",
      decision: "insufficient_evidence",
      reasons: [
        {
          code: "validation_missing",
          message: "The exact head has no snapshot validation",
          detail: { head: H, latest: null },
        },
      ],
    });
  });

  test("a later FAIL or UNAVAILABLE supersedes an earlier PASS", () => {
    for (const status of ["FAIL", "UNAVAILABLE"])
      expect(
        publish([
          { commit: H, status: "PASS" },
          { commit: H, status },
        ]),
      ).toMatchObject({
        decision: "deny",
        reasons: [{ code: "validation_not_passing", detail: { head: H, latest: status } }],
      });
  });
});

describe("publication-target", () => {
  const pr = (o: Record<string, unknown> = {}) => ({
    number: 7,
    state: "OPEN",
    crossRepository: false,
    baseRef: "main",
    ...o,
  });
  const target = (o: Record<string, unknown>) =>
    evaluateLifecycleAction({
      action: "publication-target",
      evidence: { head: H, remoteSha: null, pullRequests: [], baseBranch: "main", ...o } as never,
    });

  test("create, up-to-date and fast-forward targets are allowed and reported", () => {
    expect(target({})).toMatchObject({
      decision: "allow",
      facts: { push: "create-branch", openPullRequestIndex: null },
    });
    expect(target({ remoteSha: H })).toMatchObject({ facts: { push: "up-to-date" } });
    expect(
      target({
        remoteSha: OTHER,
        remoteIsAncestor: true,
        pullRequests: [pr({ state: "CLOSED", number: 3 }), pr()],
      }),
    ).toMatchObject({
      decision: "allow",
      facts: { push: "fast-forward", openPullRequestIndex: 1 },
    });
    expect(
      target({ remoteSha: OTHER, remoteIsAncestor: true, pullRequests: [pr()] }),
    ).toMatchObject({
      decision: "allow",
      facts: { push: "fast-forward", openPullRequestIndex: 0 },
    });
  });

  test("an unobserved ancestry is insufficient evidence; a non-ancestor is denied", () => {
    expect(target({ remoteSha: OTHER })).toMatchObject({
      decision: "insufficient_evidence",
      reasons: [{ code: "evidence_missing", detail: { fields: ["remoteIsAncestor"] } }],
    });
    expect(codes(target({ remoteSha: OTHER, remoteIsAncestor: false }))).toEqual([
      "remote_not_ancestor",
    ]);
  });

  test("duplicate, closed, cross-repository and wrong-base pull requests are denied", () => {
    expect(codes(target({ pullRequests: [pr(), pr({ number: 8 })] }))).toEqual([
      "multiple_open_pull_requests",
    ]);
    expect(codes(target({ pullRequests: [pr({ state: "MERGED" })] }))).toEqual([
      "closed_pull_request_exists",
    ]);
    expect(codes(target({ pullRequests: [pr({ crossRepository: true })] }))).toEqual([
      "pull_request_not_into_base",
    ]);
    expect(codes(target({ pullRequests: [pr({ baseRef: "release" })] }))).toEqual([
      "pull_request_not_into_base",
    ]);
  });
});

describe("pull-request-handoff", () => {
  const handoff = (pullRequest: Record<string, unknown>, o: Record<string, unknown> = {}) =>
    evaluateLifecycleAction({
      action: "pull-request-handoff",
      evidence: {
        head: H,
        pullRequest: {
          state: "OPEN",
          headSha: H,
          isDraft: false,
          assignees: ["owner"],
          ...pullRequest,
        },
        requireReady: true,
        assignee: "owner",
        ...o,
      } as never,
    });

  test("an open, ready, assigned PR at the head is allowed", () => {
    expect(handoff({})).toMatchObject({ decision: "allow" });
  });

  test("every mismatch is reported, in a fixed order", () => {
    expect(
      codes(handoff({ state: "CLOSED", headSha: OTHER, isDraft: true, assignees: [] })),
    ).toEqual(["pull_request_not_open", "head_moved", "pull_request_draft", "assignee_missing"]);
  });

  test("readiness and assignment are required only when requested", () => {
    expect(
      handoff({ isDraft: true, assignees: [] }, { requireReady: false, assignee: null }),
    ).toMatchObject({ decision: "allow" });
  });
});

describe("complete: the completion record's pull request against the ledger", () => {
  const ledger = {
    validations: [{ commit: H, status: "PASS" }],
    publications: [{ commit: H, prNumber: 30 }],
  };
  const complete = (o: Record<string, unknown> = {}, pullRequest: Record<string, unknown> = {}) =>
    evaluateLifecycleAction({
      action: "complete",
      evidence: {
        issueType: "implementation",
        outcome: "completed",
        head: H,
        ticketBranch: "agent/demo-001",
        repository: "acme/widgets",
        pullRequest: {
          number: 30,
          headRef: "agent/demo-001",
          headRepository: "acme/widgets",
          ...pullRequest,
        },
        ledger,
        ...o,
      } as never,
    });

  test("a validated, published lifecycle PR is allowed", () => {
    expect(complete()).toMatchObject({
      decision: "allow",
      facts: { applies: true, validationIndex: 0 },
    });
  });

  test("a report PR from another branch is not a lifecycle PR; an implementation PR always is", () => {
    expect(complete({ issueType: "audit", ledger: null }, { headRef: "docs/x" })).toMatchObject({
      decision: "allow",
      facts: { applies: false },
    });
    expect(codes(complete({}, { headRef: "docs/x" }))).toEqual(["wrong_branch"]);
    expect(codes(complete({ issueType: "audit" }, { headRepository: "fork/widgets" }))).toEqual([
      "foreign_head_repository",
    ]);
  });

  test("missing ledger, validation or publication is insufficient evidence; a completed result needs PASS", () => {
    expect(complete({ ledger: null })).toMatchObject({
      decision: "insufficient_evidence",
      reasons: [{ code: "ledger_missing" }],
    });
    expect(complete({ ledger: { ...ledger, validations: [] } })).toMatchObject({
      decision: "insufficient_evidence",
      reasons: [{ code: "validation_missing" }],
    });
    expect(
      complete({ ledger: { ...ledger, publications: [{ commit: H, prNumber: 31 }] } }),
    ).toMatchObject({
      decision: "insufficient_evidence",
      reasons: [{ code: "publication_not_recorded" }],
    });
    const failing = { ...ledger, validations: [{ commit: H, status: "FAIL" }] };
    expect(codes(complete({ ledger: failing }))).toEqual(["validation_not_passing"]);
    expect(complete({ ledger: failing, outcome: "partial" })).toMatchObject({ decision: "allow" });
  });
});

describe("deliver: the delivery path", () => {
  const deliver = (o: Record<string, unknown> = {}) =>
    evaluateLifecycleAction({
      action: "deliver",
      evidence: {
        issueType: "implementation",
        outcome: "completed",
        head: H,
        baseSha: BASE,
        withoutPullRequest: false,
        ...o,
      } as never,
    });

  test("an implementation is delivered with its PR at the head; a mismatched revision is denied", () => {
    expect(deliver()).toMatchObject({
      decision: "allow",
      facts: { pullRequest: "required", sourceRevision: H, reportPullRequest: false },
    });
    expect(codes(deliver({ withoutPullRequest: true }))).toEqual([
      "implementation_requires_pull_request",
    ]);
    expect(deliver({ sourceRevision: OTHER })).toMatchObject({
      decision: "deny",
      reasons: [{ code: "source_revision_mismatch", detail: { result: OTHER, head: H } }],
    });
  });

  test("a completed report is PR-first about the base; blocked results and --no-pr have no PR", () => {
    expect(deliver({ issueType: "audit" })).toMatchObject({
      facts: { pullRequest: "required", sourceRevision: BASE, reportPullRequest: true },
    });
    expect(deliver({ issueType: "audit", sourceRevision: OTHER })).toMatchObject({
      facts: { sourceRevision: OTHER },
    });
    expect(deliver({ issueType: "audit", withoutPullRequest: true })).toMatchObject({
      facts: { pullRequest: "none" },
    });
    expect(deliver({ outcome: "blocked" })).toMatchObject({
      facts: { pullRequest: "none", sourceRevision: BASE },
    });
  });

  test("an unknown or inherited issue type is denied", () => {
    for (const issueType of ["rewrite", "toString", "__proto__"])
      expect(codes(deliver({ issueType }))).toEqual(["unsupported_issue_type"]);
  });
});

describe("properties every decision shares", () => {
  test("unsupported actions, including merge, release and deploy, are denied", () => {
    for (const action of ["merge", "release", "deploy", "approve", "", 42, undefined])
      expect(evaluateLifecycleAction({ action, evidence: {} })).toMatchObject({
        decision: "deny",
        reasons: [{ code: "unsupported_action" }],
      });
    expect(evaluateLifecycleAction(null)).toMatchObject({ decision: "deny" });
  });

  test("absent evidence is insufficient; evidence of the wrong type is denied", () => {
    for (const action of LIFECYCLE_ACTIONS) {
      const missing = evaluateLifecycleAction({ action, evidence: undefined } as never);
      expect(missing).toMatchObject({
        decision: "insufficient_evidence",
        reasons: [{ code: "evidence_missing" }],
      });
    }
    expect(
      evaluateLifecycleAction({ action: "publish", evidence: { head: H } } as never),
    ).toMatchObject({
      decision: "insufficient_evidence",
      reasons: [{ code: "evidence_missing", detail: { fields: ["validations"] } }],
    });
    expect(
      evaluateLifecycleAction({
        action: "publish",
        evidence: { head: H, validations: "PASS" },
      } as never),
    ).toMatchObject({
      decision: "deny",
      reasons: [{ code: "malformed_evidence" }],
    });
  });

  test("decisions are deterministic, deeply frozen, and never mutate the evidence", () => {
    const evidence = { head: H, validations: [{ commit: H, status: "PASS" }] };
    const snapshot = JSON.stringify(evidence);
    const first = evaluateLifecycleAction({ action: "publish", evidence });
    expect(evaluateLifecycleAction({ action: "publish", evidence })).toEqual(first);
    expect(JSON.stringify(evidence)).toBe(snapshot);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(evidence)).toBe(false);
    if (first.decision === "allow") expect(Object.isFrozen(first.facts)).toBe(true);
  });

  test("an allow states its scope and is never an authorization", () => {
    for (const d of [
      evaluateLifecycleAction({
        action: "publish",
        evidence: { head: H, validations: [{ commit: H, status: "PASS" }] },
      }),
      evaluateLifecycleAction({
        action: "deliver",
        evidence: {
          issueType: "implementation",
          outcome: "completed",
          head: H,
          baseSha: BASE,
          withoutPullRequest: false,
        },
      }),
    ]) {
      expect(d.decision).toBe("allow");
      if (d.decision === "allow") expect(d.scope).toMatch(/does not authorize/);
    }
    // Implementation authority never implies publication: only a publication grant
    // authorizes publish, and no decision here can widen that.
    expect(ACTION_MODES.publish).toEqual(["publication"]);
  });

  test("every reason code maps to deny or insufficient evidence, never allow", () => {
    for (const decision of Object.values(LIFECYCLE_REASONS))
      expect(["deny", "insufficient_evidence"]).toContain(decision);
  });
});
