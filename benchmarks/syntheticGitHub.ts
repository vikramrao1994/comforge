/**
 * Cost: none — a local HTTP server on 127.0.0.1; no network egress
 *
 * One synthetic GitHub per run, served on 127.0.0.1 from the shared fake used by the
 * @comforge/github tests (packages/github/test/fakeGitHub.ts, read-only here). This file
 * adds what the benchmark needs: a write log with a kind per request (including refused ones),
 * a token requirement, branch heads resolved from the run's own bare remote, and one injected
 * "lost answer" (the write is applied, the connection drops) for the delivery-recovery task.
 */

import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { BOT, createFakeGitHub, ORIGIN, TOKEN } from "../packages/github/test/fakeGitHub.ts";
import { sha256 } from "./prng.ts";
import type { ChildEnv } from "./redact.ts";

/** The synthetic credential; it authenticates only against this local server. */
export const SYNTHETIC_TOKEN = TOKEN;
export const SYNTHETIC_BOT = BOT;
export const SYNTHETIC_REPO = { owner: "acme", name: "widgets" } as const;

export type WriteKind =
  | "pr-create"
  | "pr-update"
  | "pr-merge"
  | "review"
  | "review-approve"
  | "issue-create"
  | "issue-comment"
  | "issue-update"
  | "issue-close"
  | "ref-write"
  | "other";

export interface WriteRecord {
  seq: number;
  method: string;
  path: string;
  kind: WriteKind;
  /** HTTP status, or "dropped" when the answer was lost on purpose. */
  status: number | "dropped";
  bodyDigest: string;
  authorized: boolean;
}

export function classifyWrite(
  method: string,
  p: string,
  body: Record<string, unknown> = {},
): WriteKind {
  if (method === "POST" && /\/pulls$/.test(p)) return "pr-create";
  if (method === "PUT" && /\/pulls\/\d+\/merge$/.test(p)) return "pr-merge";
  if (method === "POST" && /\/pulls\/\d+\/reviews$/.test(p))
    return body.event === "APPROVE" ? "review-approve" : "review";
  if (method === "PATCH" && /\/pulls\/\d+$/.test(p)) return "pr-update";
  if (method === "POST" && /\/issues$/.test(p)) return "issue-create";
  if (/\/issues\/\d+\/comments$/.test(p) || /\/issues\/comments\/\d+$/.test(p))
    return "issue-comment";
  if (method === "PATCH" && /\/issues\/\d+$/.test(p))
    return body.state === "closed" ? "issue-close" : "issue-update";
  if (/\/git\/refs/.test(p)) return "ref-write";
  return "other";
}

export interface SyntheticGitHubOptions {
  remoteDir: string;
  env: ChildEnv;
  /** Drop the answer of the first write of this kind after applying it. */
  lostAnswerOn?: WriteKind;
  /** Append each write as a JSON line here (the run directory's write log). */
  logPath?: string;
}

export async function startSyntheticGitHub(opts: SyntheticGitHubOptions) {
  const gh = createFakeGitHub();
  const writes: WriteRecord[] = [];
  let injected = false;
  const resolveRef = (name: string) => {
    const r = spawnSync("git", ["rev-parse", "--verify", `refs/heads/${name}`], {
      cwd: opts.remoteDir,
      env: opts.env,
      encoding: "utf8",
    });
    if (r.status === 0) gh.refs.set(name, r.stdout.trim());
  };
  gh.readOverrides.push((p) => {
    if (p === "/user") return Response.json({ login: BOT });
    const m = p.match(/^\/repos\/acme\/widgets\/git\/ref\/heads\/(.+)$/);
    if (m) resolveRef(m[1] as string);
    return undefined;
  });
  const handle = async (
    method: string,
    pathAndQuery: string,
    headers: Headers,
    text: string,
  ): Promise<Response | "drop"> => {
    const url = new URL(pathAndQuery, "http://127.0.0.1");
    let parsed: Record<string, unknown> = {};
    try {
      parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {}
    const auth = headers.get("authorization") ?? "";
    const authorized = auth.endsWith(` ${TOKEN}`);
    const kind = method === "GET" ? null : classifyWrite(method, url.pathname, parsed);
    const record = (status: number | "dropped") => {
      if (!kind) return;
      const w: WriteRecord = {
        seq: writes.length + 1,
        method,
        path: url.pathname,
        kind,
        status,
        bodyDigest: sha256(text),
        authorized,
      };
      writes.push(w);
      if (opts.logPath) appendFileSync(opts.logPath, `${JSON.stringify(w)}\n`);
    };
    if (!authorized) {
      record(401);
      return Response.json({ message: "Bad credentials" }, { status: 401 });
    }
    if (kind === "pr-create" && typeof parsed.head === "string") resolveRef(parsed.head);
    if (kind && kind === opts.lostAnswerOn && !injected) {
      injected = true;
      gh.faults.push("network-after");
    }
    try {
      const res = await gh.fetchImpl(`${ORIGIN}${url.pathname}${url.search}`, {
        method,
        headers: Object.fromEntries(headers),
        ...(method === "GET" ? {} : { body: text }),
        redirect: "error",
      });
      record(res.status);
      return res;
    } catch {
      record("dropped");
      return "drop";
    }
  };
  // node:http so a lost answer is a destroyed socket, with no stack trace noise from the runtime.
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
    const out = await handle(
      req.method ?? "GET",
      req.url ?? "/",
      headers,
      Buffer.concat(chunks).toString("utf8"),
    );
    if (out === "drop") {
      req.socket.destroy();
      return;
    }
    res.writeHead(out.status, Object.fromEntries(out.headers));
    res.end(Buffer.from(await out.arrayBuffer()));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    gh,
    writes,
    port,
    origin: `http://127.0.0.1:${port}`,
    lostAnswerInjected: () => injected,
    stop: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}
export type SyntheticGitHub = Awaited<ReturnType<typeof startSyntheticGitHub>>;
