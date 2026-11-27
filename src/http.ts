/**
 * Streamable HTTP for comforge-mcp, as a web-standard `(Request) => Promise<Response>`
 * handler the host mounts in its own HTTP server (Node, Bun, Deno, a framework route).
 *
 * Order of checks, before any MCP message is parsed:
 *   Host allowlist (DNS rebinding) → Origin allowlist → method → body size →
 *   host authentication (a principal or 401) → per-principal rate and concurrency →
 *   session: created by `initialize` and bound to that principal; any other principal
 *   presenting its id is refused, an unknown or expired id is 404.
 *
 * Authentication is the host's: this module never sees a password, cookie or token format,
 * only the principal `authenticate` returns. Executing tools exist on this transport only
 * with a host `IsolationProvider` (see host.ts).
 */
import { randomUUID } from "node:crypto";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { type Principal, PrincipalSchema } from "./contracts.ts";
import type {
  HostServices,
  IsolationProvider,
  RemoteHost,
  RemoteRepositoryBinding,
  RepositoryBinding,
} from "./host.ts";
import { assertIsolation, createComforgeMcpServer } from "./server.ts";

export interface HttpLimits {
  maxBodyBytes: number;
  maxSessions: number;
  sessionIdleMs: number;
  requestsPerMinute: number;
  maxConcurrentPerPrincipal: number;
}

export const DEFAULT_HTTP_LIMITS: HttpLimits = {
  maxBodyBytes: 1_000_000,
  maxSessions: 32,
  sessionIdleMs: 15 * 60_000,
  requestsPerMinute: 60,
  maxConcurrentPerPrincipal: 4,
};

export interface HttpOptions {
  repositories: readonly RepositoryBinding[];
  host: HostServices;
  /**
   * Checkout-free repositories (see ComforgeMcpOptions.remoteRepositories): GitHub evidence reads
   * only, whatever the isolation. Requires `remote`; `repositories` may then be empty.
   */
  remoteRepositories?: readonly RemoteRepositoryBinding[];
  /** The host's trusted-configuration source and credentials for `remoteRepositories`. */
  remote?: RemoteHost;
  /** The host's authentication: a principal for this request, or null for 401. */
  authenticate(request: Request): Promise<Principal | null> | Principal | null;
  /** Exact `Host` header values served; required, never empty. */
  allowedHosts: readonly string[];
  /** Exact `Origin` values accepted when a request carries one (browsers do). */
  allowedOrigins: readonly string[];
  /** `WWW-Authenticate` value for 401 answers (e.g. a Bearer challenge with resource metadata). */
  challenge?: string;
  isolation?: IsolationProvider;
  /** See ComforgeMcpOptions.compactDiscovery. */
  compactDiscovery?: boolean;
  /** See ComforgeMcpOptions.textContent. */
  textContent?: "full" | "summary";
  limits?: Partial<HttpLimits>;
  now?: () => number;
}

interface Session {
  transport: WebStandardStreamableHTTPServerTransport;
  principalId: string;
  /** The principal's id, profiles and repositories at initialization. */
  fingerprint: string;
  lastUsed: number;
}

const json = (status: number, message: string, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

export const fingerprintOf = (p: Principal) =>
  JSON.stringify([
    p.id,
    [...p.profiles].sort(),
    p.repositories === "*" ? "*" : [...p.repositories].sort(),
  ]);

export interface HttpHandler {
  handle(request: Request): Promise<Response>;
  /** Live sessions (for tests and health reporting). */
  sessions(): number;
  close(): Promise<void>;
}

export function createHttpHandler(options: HttpOptions): HttpHandler {
  if (options.allowedHosts.length === 0) throw new Error("allowedHosts must name the served host");
  if (options.isolation) assertIsolation(options.isolation);
  if ((options.remoteRepositories?.length ?? 0) > 0 && !options.remote)
    throw new Error("remoteRepositories need a remote host: { trustedConfig, credentials }");
  const limits = { ...DEFAULT_HTTP_LIMITS, ...options.limits };
  const now = options.now ?? Date.now;
  const sessions = new Map<string, Session>();
  const windows = new Map<string, { start: number; count: number }>();
  const inflight = new Map<string, number>();

  const sweep = () => {
    for (const [id, s] of sessions)
      if (now() - s.lastUsed > limits.sessionIdleMs) {
        sessions.delete(id);
        void s.transport.close();
      }
  };

  const rateLimited = (principalId: string) => {
    const w = windows.get(principalId);
    if (!w || now() - w.start >= 60_000) {
      windows.set(principalId, { start: now(), count: 1 });
      return false;
    }
    w.count += 1;
    return w.count > limits.requestsPerMinute;
  };

  async function handle(request: Request): Promise<Response> {
    const host = request.headers.get("host");
    if (!host || !options.allowedHosts.includes(host)) return json(421, "host not served");
    const origin = request.headers.get("origin");
    if (origin !== null && !options.allowedOrigins.includes(origin))
      return json(403, "origin not allowed");
    if (!["POST", "GET", "DELETE"].includes(request.method))
      return json(405, "method not allowed", { allow: "POST, GET, DELETE" });
    const declared = Number(request.headers.get("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > limits.maxBodyBytes)
      return json(413, "request too large");

    // An authenticator that throws is an ambiguous identity: refused, never guessed.
    let raw: Principal | null;
    try {
      raw = await options.authenticate(request);
    } catch {
      raw = null;
    }
    const parsed = raw ? PrincipalSchema.safeParse(raw) : null;
    if (!parsed?.success)
      return json(
        401,
        "authentication required",
        options.challenge ? { "www-authenticate": options.challenge } : {},
      );
    const principal = parsed.data as Principal;
    if (rateLimited(principal.id)) return json(429, "rate limit", { "retry-after": "60" });
    if ((inflight.get(principal.id) ?? 0) >= limits.maxConcurrentPerPrincipal)
      return json(429, "too many concurrent requests", { "retry-after": "1" });

    sweep();
    inflight.set(principal.id, (inflight.get(principal.id) ?? 0) + 1);
    try {
      const sessionId = request.headers.get("mcp-session-id");
      if (sessionId) {
        const session = sessions.get(sessionId);
        if (!session) return json(404, "unknown or expired session");
        // Session binding: the id alone never authorizes; it must be presented by its principal.
        if (session.principalId !== principal.id)
          return json(403, "session belongs to another principal");
        // A changed or revoked role ends the session: its tools were registered for the old one.
        if (session.fingerprint !== fingerprintOf(principal)) {
          sessions.delete(sessionId);
          void session.transport.close();
          return json(403, "the principal's profiles or repositories changed; start a new session");
        }
        session.lastUsed = now();
        const response = await session.transport.handleRequest(request);
        if (request.method === "DELETE") sessions.delete(sessionId);
        return response;
      }
      if (request.method !== "POST") return json(400, "a session id is required");
      // A new session starts only with `initialize`; the transport refuses anything else.
      if (sessions.size >= limits.maxSessions)
        return json(503, "session limit reached", { "retry-after": "60" });
      let created: string | null = null;
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        enableJsonResponse: true,
        maxRequestBodySize: limits.maxBodyBytes,
        onsessioninitialized: (id) => {
          created = id;
          sessions.set(id, {
            transport,
            principalId: principal.id,
            fingerprint: fingerprintOf(principal),
            lastUsed: now(),
          });
        },
        onsessionclosed: (id) => {
          sessions.delete(id);
        },
      });
      const server = createComforgeMcpServer({
        repositories: options.repositories,
        host: options.host,
        principal,
        transport: "http",
        ...(options.remoteRepositories ? { remoteRepositories: options.remoteRepositories } : {}),
        ...(options.remote ? { remote: options.remote } : {}),
        ...(options.isolation ? { isolation: options.isolation } : {}),
        ...(options.compactDiscovery ? { compactDiscovery: true } : {}),
        ...(options.textContent ? { textContent: options.textContent } : {}),
      });
      await server.connect(transport);
      const response = await transport.handleRequest(request);
      if (!created) await transport.close();
      return response;
    } finally {
      inflight.set(principal.id, (inflight.get(principal.id) ?? 1) - 1);
    }
  }

  return {
    handle,
    sessions: () => sessions.size,
    async close() {
      for (const s of sessions.values()) await s.transport.close();
      sessions.clear();
    },
  };
}
