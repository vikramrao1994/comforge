import { expect, test } from "bun:test";
import { fakeRegistry, rehearseApproval } from "../../tooling/release/rehearse";

// The full pipeline runs in CI (`release:rehearse`); this is its approval step alone.
test("the rehearsed approval accepts only the owner's approval of this run's release environment", async () => {
  const steps = await rehearseApproval("owner/repo");
  expect(steps.map((s) => s.detail)).toEqual([
    "accepted",
    "refused: approval-missing",
    "refused: approval-rejected",
    "refused: approval-not-owner",
    "refused: approval-missing",
    "refused: approval-unreadable",
  ]);
  expect(steps.every((s) => s.pass)).toBe(true);
});

test("the fake registry answers only the routes it was given", async () => {
  const fetchImpl = fakeRegistry({ "https://registry.invalid/x": { status: 200, body: { ok: 1 } } });
  expect(await (await fetchImpl("https://registry.invalid/x")).json()).toEqual({ ok: 1 });
  expect((await fetchImpl("https://registry.invalid/y")).status).toBe(404);
});
