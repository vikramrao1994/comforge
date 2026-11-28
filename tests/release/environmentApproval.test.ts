import { describe, expect, test } from "bun:test";
import { ApprovalRefusal, verifyEnvironmentApproval } from "../../tooling/release/environmentApproval";

// The owner's release approval is GitHub's record of this run's comforge-release environment
// approval; every answer that is not exactly the owner's approval of that environment refuses.

const REPO = "acme/comforge";
const RUN = "1234";
const record = (state: string, login: string, environment = "comforge-release") => ({
  state,
  environments: [{ name: environment }],
  user: { login },
});
const answer = (status: number, body: unknown, seen: string[] = []) =>
  (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push(`${String(url)} ${JSON.stringify(init?.headers ?? {})}`);
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
const verify = (fetchImpl: typeof fetch, over: Partial<Parameters<typeof verifyEnvironmentApproval>[0]> = {}) =>
  verifyEnvironmentApproval({ repository: REPO, runId: RUN, owner: "acme", token: "t", fetchImpl, ...over });
const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return "accepted";
  } catch (error) {
    return error instanceof ApprovalRefusal ? error.code : `unexpected: ${String(error)}`;
  }
};

describe("environment approval", () => {
  test("the owner's approval of this run's comforge-release environment is accepted", async () => {
    const seen: string[] = [];
    const a = await verify(answer(200, [record("approved", "Acme")], seen));
    expect(a).toEqual({ environment: "comforge-release", approver: "Acme", runId: RUN });
    expect(seen[0]).toContain(`https://api.github.com/repos/${REPO}/actions/runs/${RUN}/approvals`);
    expect(seen[0]).toContain("Bearer t");
  });

  test("no approval, another environment's, or another person's is refused", async () => {
    expect(await code(verify(answer(200, [])))).toBe("approval-missing");
    expect(await code(verify(answer(200, [record("approved", "acme", "npm")])))).toBe("approval-missing");
    expect(await code(verify(answer(200, [record("approved", "mallory")])))).toBe("approval-not-owner");
    expect(await code(verify(answer(200, [{ state: "approved", environments: [{ name: "comforge-release" }], user: null }])))).toBe("approval-not-owner");
  });

  test("a rejection refuses even next to an approval", async () => {
    expect(await code(verify(answer(200, [record("approved", "acme"), record("rejected", "acme")])))).toBe("approval-rejected");
  });

  test("an unreadable answer is refused, never read as approved", async () => {
    expect(await code(verify(answer(403, {})))).toBe("approval-unreadable");
    expect(await code(verify(answer(200, "<html>")))).toBe("approval-unreadable");
    expect(await code(verify(answer(200, { approvals: [] })))).toBe("approval-unreadable");
    const throwing = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    expect(await code(verify(throwing))).toBe("approval-unreadable");
  });

  test("a malformed repository or run id is refused before any request", async () => {
    const seen: string[] = [];
    expect(await code(verify(answer(200, [record("approved", "acme")], seen), { runId: "12/../34" }))).toBe("approval-unreadable");
    expect(await code(verify(answer(200, [record("approved", "acme")], seen), { repository: "acme" }))).toBe("approval-unreadable");
    expect(seen).toEqual([]);
  });
});
