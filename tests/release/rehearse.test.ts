import { expect, test } from "bun:test";
import type { ReleaseCandidate } from "../../tooling/release/candidate";
import { fakeRegistry, rehearseAuthorization } from "../../tooling/release/rehearse";

// Only the fields the authorization binds; the full pipeline runs in CI (`release:rehearse`).
const candidate = {
  package: "@comforge/ledger",
  version: "0.1.1",
  tag: "ledger/v0.1.1",
  sourceCommit: "a".repeat(40),
  digest: `sha256:${"b".repeat(64)}`,
  releaseRecordSha256: "c".repeat(64),
  plan: { digest: `sha256:${"d".repeat(64)}` },
  workflowApproval: null,
} as unknown as ReleaseCandidate;

test("the rehearsed authorization accepts only the trusted, intact, current record for this candidate", () => {
  const steps = rehearseAuthorization(candidate, "e".repeat(64), "owner/repo");
  expect(steps.map((s) => s.detail)).toEqual([
    "accepted",
    "refused: authorization-signature",
    "refused: authorization-untrusted",
    "refused: authorization-expired",
    "refused: authorization-mismatch",
  ]);
  expect(steps.every((s) => s.pass)).toBe(true);
});

test("the fake registry answers only the routes it was given", async () => {
  const fetchImpl = fakeRegistry({ "https://registry.invalid/x": { status: 200, body: { ok: 1 } } });
  expect(await (await fetchImpl("https://registry.invalid/x")).json()).toEqual({ ok: 1 });
  expect((await fetchImpl("https://registry.invalid/y")).status).toBe(404);
});
