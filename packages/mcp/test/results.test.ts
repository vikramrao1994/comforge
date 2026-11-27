import { describe, expect, test } from "bun:test";
import { bound, paginate, redact } from "../src/results.ts";

describe("result shaping", () => {
  test("redacts the call's credentials, secret-like text and secret-named fields", () => {
    const token = "ghs_FAKEtokenFAKEtokenFAKEtoken0123";
    const out = redact(
      {
        message: `failed with ${token}`,
        nested: { accessToken: "x", note: "ghp_abcdefghijklmnopqrstuvwxyz0123456789" },
        keep: "fine",
      },
      [token],
    ) as Record<string, unknown>;
    expect(JSON.stringify(out)).not.toContain(token);
    expect(JSON.stringify(out)).not.toContain("ghp_");
    expect((out.nested as Record<string, unknown>).accessToken).toBeUndefined();
    expect(out.keep).toBe("fine");
  });

  test("bounds long strings and oversized values instead of returning them whole", () => {
    expect(String(bound("x".repeat(30_000)))).toEndWith("… [truncated]");
    const big = bound(
      { items: Array.from({ length: 5_000 }, (_, i) => ({ i, text: "y".repeat(50) })) },
      2_000,
    ) as { truncated: boolean };
    expect(big.truncated).toBe(true);
    expect(JSON.stringify(big).length).toBeLessThan(2_100);
  });

  test("paginates with stable cursors and caps the page size", () => {
    const all = Array.from({ length: 23 }, (_, i) => i);
    const first = paginate(all, undefined, 10);
    expect(first.items).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(first.page).toEqual({ cursor: "0", next: "10", total: 23, pageSize: 10 });
    expect(paginate(all, "20", 10).page.next).toBeNull();
    expect(paginate(all, undefined, 500).items).toHaveLength(23);
  });
});
