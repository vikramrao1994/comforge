import path from "node:path";
import {
  createFetchTransport,
  createGitHubEvidence,
  createGitHubWriter,
  GitHubAdapterError,
  type GitHubEvidence,
  type GitHubTransport,
  type OperationRecord,
  type WriteOperation,
  type WriteOutcome,
} from "@comforge/github";
import type { Ledger } from "@comforge/ledger";
import { createFileLedger } from "@comforge/ledger/file";
import { CLI_CAPABILITIES, type ComforgeConfig, GOVERNANCE_CAPABILITIES } from "./config.ts";
import { CliError, type ErrorCode, fail } from "./errors.ts";
import { childEnv, type Runtime } from "./runtime.ts";
import { stateDir } from "./state.ts";

/**
 * GitHub access for one command.
 *
 * - Credential: from where the trusted configuration says (an environment variable or the
 *   `gh` login), read on first use, held in memory only, never written, logged or passed to a
 *   child process.
 * - Reads: the @comforge/github evidence client and its transport.
 * - Writes: a @comforge/github writer with the configured capabilities, the
 *   @comforge/ledger file ledger and an authorization bound to the one descriptor the
 *   command prepared. Each write is idempotent per operation id across runs and processes.
 * - Host adapter (audited, the only non-SDK GitHub call): assigning a pull request, which the
 *   SDK does not offer, through `gh pr edit --add-assignee`. It uses gh's own login.
 */

export interface GitHubAccess {
  readonly repository: string;
  evidence: GitHubEvidence;
  transport: GitHubTransport;
  /** The login the credential acts as. */
  login(): Promise<string>;
  /** Sends exactly `operation`; nothing else can be authorized with this call. */
  write(operation: WriteOperation): Promise<WriteOutcome>;
  reconcile(operationId: string): Promise<WriteOutcome>;
  abandon(operationId: string, reason: string): Promise<void>;
  /** The write ledger (read-only use by `recover`, `status` and the write guards). */
  ledger: Ledger<OperationRecord>;
}

function credential(
  rt: Runtime,
  config: ComforgeConfig,
  provider?: (config: ComforgeConfig) => string,
): () => string {
  let token: string | null = null;
  return () => {
    if (token) return token;
    if (provider) {
      const value = provider(config);
      if (!value) fail("credential-missing", "the credential provider returned no token");
      token = value;
      return token;
    }
    const source = config.security.credentials;
    if (source.source === "env") {
      const value = rt.env[source.variable];
      if (!value)
        fail("credential-missing", `${source.variable} is not set`, { variable: source.variable });
      token = value as string;
    } else {
      const r = rt.run("gh", ["auth", "token"], { cwd: rt.cwd, env: childEnv(rt.env) });
      if (r.status !== 0 || !r.stdout.trim())
        fail("credential-missing", "gh has no login (gh auth login)", {});
      token = r.stdout.trim();
    }
    return token;
  };
}

export function githubError(error: unknown): never {
  if (error instanceof CliError) throw error;
  if (error instanceof GitHubAdapterError) {
    const mapped: Record<string, ErrorCode> = {
      unauthorized: "unauthorized",
      forbidden: "unauthorized",
      "not-found": "not-found",
      stale: "stale",
      "wrong-target": "stale",
      conflict: "conflict",
      "invalid-input": "policy-denied",
      "capability-denied": "policy-denied",
      "authorization-denied": "policy-denied",
      "unapproved-origin": "policy-denied",
      "ledger-failure": "ledger",
    };
    throw new CliError(mapped[error.code] ?? "github-failed", `GitHub: ${error.message}`, {
      githubCode: error.code,
      ...(error.detail.status !== undefined ? { status: error.detail.status } : {}),
    });
  }
  throw error;
}

export function openGitHub(
  rt: Runtime,
  config: ComforgeConfig,
  commonDir: string,
  provider?: (config: ComforgeConfig) => string,
  ledgerFactory?: (config: ComforgeConfig) => Ledger<OperationRecord>,
): GitHubAccess {
  const ledger: Ledger<OperationRecord> =
    ledgerFactory?.(config) ??
    createFileLedger<OperationRecord>({
      directory: writeLedgerDir(commonDir, config),
      namespace: config.security.ledgerNamespace,
      validate: (record) => {
        if (record.schema !== "comforge-github-operation/v1")
          fail("ledger", "the write ledger holds a record of another kind");
      },
    });
  return createGitHubAccess({
    config,
    token: credential(rt, config, provider),
    ledger,
    now: rt.now,
    ...(rt.fetchImpl ? { fetchImpl: rt.fetchImpl } : {}),
  });
}

export interface GitHubAccessOptions {
  /** The trusted configuration: repository, API origin, capabilities, marker namespace. */
  config: ComforgeConfig;
  /** Server-owned; held in memory only. */
  token: () => string;
  ledger: Ledger<OperationRecord>;
  now: () => number;
  fetchImpl?: typeof fetch;
  /** The writer's correlation-marker namespace; default `security.markerNamespace`. */
  markerNamespace?: string;
}

/**
 * GitHub access from a credential and a write ledger alone (0.6.0): what `openGitHub` builds for a
 * checkout, for a host that has no checkout and supplies both itself.
 */
export function createGitHubAccess(options: GitHubAccessOptions): GitHubAccess {
  const { config, token, ledger } = options;
  const rt = { now: options.now, fetchImpl: options.fetchImpl };
  const { owner, name, apiOrigin } = config.repository;
  // Resolved now: the SDK transport reports a failing token provider as a network error.
  token();
  const transport = createFetchTransport({
    token,
    fetchImpl: rt.fetchImpl,
    apiOrigin,
    userAgent: "comforge-cli",
  });
  const evidence = createGitHubEvidence({ transport, repository: { owner, name } });
  let viewer: string | null = null;
  const login = async () => {
    if (viewer) return viewer;
    const user = (await transport.get("/user").catch(githubError)) as { login?: unknown };
    if (typeof user?.login !== "string")
      fail("github-failed", "GitHub returned no login for the credential");
    viewer = user.login as string;
    return viewer;
  };
  const writer = (authorized: string | null) =>
    createGitHubWriter({
      repository: { owner, name },
      token,
      // Only SDK capabilities reach the writer; host capabilities are checked by their adapter.
      capabilities: config.security.capabilities.filter(
        (c): c is (typeof CLI_CAPABILITIES)[number] | (typeof GOVERNANCE_CAPABILITIES)[number] =>
          (CLI_CAPABILITIES as readonly string[]).includes(c) ||
          (GOVERNANCE_CAPABILITIES as readonly string[]).includes(c),
      ),
      authorize: (descriptor) =>
        authorized !== null && descriptor.digest === authorized
          ? { allow: true, descriptorDigest: descriptor.digest, expiresAt: rt.now() + 60_000 }
          : { allow: false, reason: "not the operation this command prepared" },
      ledger,
      clock: rt.now,
      markers: { namespace: options.markerNamespace ?? config.security.markerNamespace },
      expectedAuthor: viewer ?? undefined,
      fetchImpl: rt.fetchImpl,
      apiOrigin,
      userAgent: "comforge-cli",
    });
  return {
    repository: `${owner}/${name}`,
    evidence,
    transport,
    login,
    ledger,
    async write(operation) {
      await login();
      try {
        const descriptor = await writer(null).prepare(operation);
        return await writer(descriptor.digest).execute(operation);
      } catch (error) {
        return githubError(error);
      }
    },
    async reconcile(operationId) {
      await login();
      return writer(null).reconcile(operationId).catch(githubError);
    },
    async abandon(operationId, reason) {
      await login();
      return writer(null).abandon(operationId, reason).catch(githubError);
    },
  };
}

/** The audited host adapter: assignment through `gh`, which the SDK does not offer. */
export function assignWithGh(
  rt: Runtime,
  config: ComforgeConfig,
  prNumber: number,
  login: string,
): { assigned: boolean; detail: string } {
  // Bounded: only with the pulls:assign capability, only the configured login, only this PR.
  if (!config.security.capabilities.includes("pulls:assign"))
    return { assigned: false, detail: "skipped: pulls:assign is not a configured capability" };
  if (login !== config.security.delivery.assignee)
    return { assigned: false, detail: "skipped: not the configured assignee" };
  const slug = `${config.repository.owner}/${config.repository.name}`;
  const r = rt.run(
    "gh",
    ["pr", "edit", String(prNumber), "--repo", slug, "--add-assignee", login],
    {
      cwd: rt.cwd,
      env: childEnv(rt.env),
    },
  );
  return r.status === 0
    ? { assigned: true, detail: `assigned ${login} with gh` }
    : { assigned: false, detail: `gh pr edit failed: ${r.stderr.trim().slice(0, 200)}` };
}

/** The write ledger's directory: `comforge/`, or an earlier lifecycle's shared one (`state`). */
export const writeLedgerDir = (commonDir: string, config: ComforgeConfig) =>
  config.state.writeLedgerDirectory === "comforge"
    ? stateDir(commonDir)
    : path.join(commonDir, config.state.writeLedgerDirectory);

export const ledgerLocation = (commonDir: string, config: ComforgeConfig) =>
  path.join(writeLedgerDir(commonDir, config), config.security.ledgerNamespace);
