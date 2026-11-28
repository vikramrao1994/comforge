/**
 * Tool handlers: each one calls the published @comforge/cli lifecycle services or the
 * published @comforge/github evidence reads, and shapes the answer summary-first.
 *
 * No handler reimplements governance, persistence or lifecycle logic, shells out to the
 * `comforge` executable or parses its output. Authorization of writes stays inside
 * @comforge/cli (trusted configuration, owner grants or operator mode); a handler cannot
 * pass `authorized`, a path, a URL or a credential through.
 */
import {
  artifactReadable,
  PACKAGE_VERSION as CLI_VERSION,
  type ComforgeConfig,
  type CredentialProvider,
  capabilities as cliCapabilities,
  context as cliContext,
  createLifecycleServices,
  createRemoteGovernance,
  type LifecycleServices,
  type RemoteGovernance,
  type Runtime,
  reviewProtocol,
  type ServiceResult,
  specificationProtocol,
  toServiceError,
} from "@comforge/cli";
import {
  type AdvisoryReview,
  type FileAtCommitEvidence,
  GitHubAdapterError,
  type GitHubEvidence,
  type IssueCommentEvidence,
  type PullRequestSummary,
  readSpecificationIssue,
} from "@comforge/github";
import type { z } from "zod";
import {
  CAPABILITIES_SCHEMA,
  DETAIL_PROFILES,
  type INPUTS,
  LIMITS,
  type Principal,
  TOOLS,
  type ToolName,
} from "./contracts.ts";
import { withGrantFile } from "./grants.ts";
import {
  checkSnapshot,
  type HostServices,
  type RemoteGovernanceCommand,
  type RemoteHost,
  type RemoteRepositoryBinding,
  type RepositoryBinding,
  repositoryOf,
  trustedConfig,
} from "./host.ts";
import { createEngineeringHost, type EngineeringHost, fetchTransport } from "./hostServices.ts";
import {
  bound,
  excerpt,
  fromServiceError,
  incompleteDelivery,
  type McpError,
  paginate,
  success,
  ToolRefusal,
  type ToolSuccess,
} from "./results.ts";

export const SERVER_NAME = "comforge-mcp";
/**
 * Reported as `serverInfo.version`. A literal on purpose: a bundler cannot resolve a runtime
 * read of package.json. test/version.test.ts fails when it differs from package.json.
 */
export const SERVER_VERSION = "0.5.0";

export interface CallContext {
  principal: Principal;
  binding: RepositoryBinding | null;
  /** A checkout-free repository (0.2.0); `binding` and `rt` are null for it. */
  remote?: RemoteRepositoryBinding | null;
  remoteHost?: RemoteHost | null;
  /** The runtime for this call: the host's, or the isolation provider's for execution. */
  rt: Runtime | null;
  host: HostServices;
  signal: AbortSignal;
  transport: "stdio" | "http";
  /** Every credential value seen during the call, for redaction. */
  secrets: string[];
  /** Static facts capabilities reports. */
  server: {
    bindings: readonly RepositoryBinding[];
    /** 0.2.0; absent means none. */
    remoteBindings?: readonly RemoteRepositoryBinding[];
    executionAvailable: boolean;
    isolation: string | null;
    tools: readonly ToolName[];
  };
}

export type HandlerOutcome = ToolSuccess | McpError;
type Input<N extends ToolName> = z.infer<(typeof INPUTS)[N]>;

/** The host's credential provider, wrapped so every value it hands out is redacted later. */
function credentialsFor(c: CallContext): CredentialProvider | undefined {
  const provider = c.binding ? c.host.credentials?.(c.binding, c.principal) : undefined;
  if (!provider) return undefined;
  return (config) => {
    const token = provider(config);
    if (token) c.secrets.push(token);
    return token;
  };
}

/** One services instance per call: its cancellation signal is the call's. */
function services(c: CallContext): LifecycleServices {
  const binding = c.binding as RepositoryBinding;
  return createLifecycleServices({
    runtime: c.rt as Runtime,
    repository: repositoryOf(binding),
    credentials: credentialsFor(c),
    state: c.host.state?.(binding),
    signal: c.signal,
    ...(c.host.hostPolicy ? { host: c.host.hostPolicy(binding) } : {}),
  });
}

/** A checkout-free read as a service result: GitHub refusals keep their codes, others propagate. */
async function remoteRead(
  c: CallContext,
  read: (
    reads: GitHubEvidence,
    config: ComforgeConfig,
    host: EngineeringHost,
  ) => Promise<Record<string, unknown>>,
): Promise<ServiceResult<Record<string, unknown>>> {
  const { config, reads, services: host } = await evidence(c);
  try {
    return { ok: true, value: await read(reads, config, host), exit: 0 } as ServiceResult<
      Record<string, unknown>
    >;
  } catch (error) {
    if (error instanceof ToolRefusal) throw error;
    return githubRefusal(error);
  }
}

function settle<T>(
  r: ServiceResult<T>,
  shape: (value: T, exit: number) => ToolSuccess,
): HandlerOutcome {
  return r.ok ? shape(r.value, r.exit) : fromServiceError(r.error);
}

/** A read credential exactly as @comforge/cli resolves one, from the server's own sources. */
function readToken(c: CallContext, config: ComforgeConfig): string {
  const provider = credentialsFor(c);
  const rt = c.rt as Runtime;
  let token: string | undefined;
  if (provider) token = provider(config);
  else if (config.security.credentials.source === "env")
    token = rt.env[config.security.credentials.variable];
  else {
    const r = rt.run("gh", ["auth", "token"], { cwd: rt.cwd, timeoutMs: 15_000 });
    token = r.status === 0 ? r.stdout.trim() : undefined;
  }
  if (!token)
    throw new ToolRefusal(
      "credential-missing",
      "the server has no GitHub credential for this repository",
    );
  c.secrets.push(token);
  return token;
}

/**
 * The tools a checkout-free repository serves: GitHub evidence reads under a host-supplied
 * trusted configuration. Nothing that runs commands, reads lifecycle state or writes.
 */
export const REMOTE_READ_TOOLS: readonly ToolName[] = [
  "comforge_capabilities",
  "comforge_issue",
  "comforge_pr",
  "comforge_prs",
  "comforge_comments",
  "comforge_reviews",
  "comforge_artifact",
];

/**
 * The governed publications a checkout-free repository serves when its host supplies governance
 * (0.4.0): no command runs, no lifecycle state is read; every write is authorized, reconciled and
 * read back exactly as with a checkout.
 */
export const REMOTE_GOVERNANCE_TOOLS: readonly ToolName[] = [
  "comforge_publish_specification",
  "comforge_publish_review",
  "comforge_publish_comment",
];

const GOVERNANCE_COMMAND: Partial<Record<ToolName, RemoteGovernanceCommand>> = {
  comforge_publish_specification: "publish-specification",
  comforge_publish_review: "publish-review",
  comforge_publish_comment: "publish-comment",
};

const DEFAULT_CONFIG_MAX_AGE_MS = 10 * 60_000;

/** One repository's trusted configuration and the read-only host services over it. */
interface Evidence {
  config: ComforgeConfig;
  reads: GitHubEvidence;
  services: EngineeringHost;
}

/**
 * Evidence for a checkout-free repository. The host's snapshot is checked (revision, age, pin,
 * repository) and then against GitHub itself: the configuration must be byte-for-byte what the
 * repository holds at that revision, read with the server's own credential.
 */
async function remoteEvidence(c: CallContext): Promise<Evidence> {
  const binding = c.remote as RemoteRepositoryBinding;
  const host = c.remoteHost as RemoteHost;
  const now = host.now?.() ?? Date.now();
  let snapshot: Awaited<ReturnType<RemoteHost["trustedConfig"]>>;
  try {
    snapshot = await host.trustedConfig(binding);
  } catch {
    throw new ToolRefusal(
      "config-missing",
      "the host could not supply a trusted configuration",
      3,
      {
        repository: binding.id,
      },
    );
  }
  const config = checkSnapshot(
    binding,
    snapshot,
    now,
    host.configMaxAgeMs ?? DEFAULT_CONFIG_MAX_AGE_MS,
  );
  const token = host.credentials(binding, c.principal);
  if (!token)
    throw new ToolRefusal(
      "credential-missing",
      "the server has no GitHub credential for this repository",
    );
  c.secrets.push(token);
  // The same read-only host services an embedding application uses (`@comforge/mcp/host`).
  const services = createEngineeringHost({
    repository: { owner: binding.owner, name: binding.name },
    transport: fetchTransport({
      token: () => token,
      ...(host.fetchImpl ? { fetchImpl: host.fetchImpl } : {}),
    }),
  });
  let confirmed: Awaited<ReturnType<EngineeringHost["confirmTrustedConfig"]>>;
  try {
    confirmed = await services.confirmTrustedConfig(snapshot);
  } catch (error) {
    return githubRefusal(error);
  }
  if (confirmed === "absent")
    throw new ToolRefusal(
      "config-mismatch",
      "GitHub has no comforge.config.json at the trusted revision",
      2,
      {
        repository: binding.id,
      },
    );
  if (confirmed !== "match")
    throw new ToolRefusal(
      "config-mismatch",
      "the trusted configuration is not what GitHub holds at its revision",
      2,
      { repository: binding.id },
    );
  return { config, reads: services.evidence, services };
}

async function evidence(c: CallContext): Promise<Evidence> {
  if (c.remote) return remoteEvidence(c);
  const binding = c.binding as RepositoryBinding;
  const config = trustedConfig(c.rt as Runtime, binding);
  const token = readToken(c, config);
  const services = createEngineeringHost({
    repository: { owner: binding.owner, name: binding.name },
    transport: fetchTransport({
      token: () => token,
      ...(c.rt?.fetchImpl ? { fetchImpl: c.rt.fetchImpl } : {}),
    }),
  });
  return { config, reads: services.evidence, services };
}

/**
 * The governance services of a checkout-free repository for one publication tool: the trusted
 * configuration is verified against GitHub first (as for every remote read), then the host's
 * own write credential for that command, ledger and policy are bound to it.
 */
async function remoteGovernance(c: CallContext, tool: ToolName): Promise<RemoteGovernance> {
  const binding = c.remote as RemoteRepositoryBinding;
  const host = c.remoteHost as RemoteHost;
  const command = GOVERNANCE_COMMAND[tool] as RemoteGovernanceCommand;
  const governance = host.governance?.(binding, c.principal);
  if (!governance)
    throw new ToolRefusal(
      "checkout-required",
      `${tool} needs a repository checkout or host governance; ${binding.id} is served for reads only`,
      1,
      { repository: binding.id },
    );
  const { config } = await evidence(c);
  const token = governance.credentials(command);
  if (!token)
    throw new ToolRefusal(
      "credential-missing",
      `the server has no write credential for ${command} in this repository`,
    );
  c.secrets.push(token);
  return createRemoteGovernance({
    config,
    principal: c.principal.id,
    token: () => token,
    ledger: governance.operations,
    authorize: (request) => governance.authorize(request),
    ...(host.now ? { now: host.now } : {}),
    ...(host.fetchImpl ? { fetchImpl: host.fetchImpl } : {}),
    signal: c.signal,
    ...(governance.markerNamespace ? { markerNamespace: governance.markerNamespace } : {}),
    ...((identity) => (identity !== undefined ? { identity } : {}))(governance.identity?.(command)),
  });
}

/** A checkout-free publication takes no grant: the host authorizes it (owner-grant repositories refuse). */
function noRemoteGrant(c: CallContext, grant: unknown): void {
  if (c.remote && grant !== undefined)
    throw new ToolRefusal(
      "usage",
      "a grant is accepted only by a checkout-backed server; this repository is served without one",
    );
}

/** GitHub adapter refusals as the CLI's codes; anything else is rethrown as internal. */
function githubRefusal(error: unknown): never {
  if (error instanceof GitHubAdapterError) {
    const code =
      error.code === "not-found"
        ? "not-found"
        : error.code === "unauthorized" || error.code === "forbidden"
          ? "unauthorized"
          : error.code === "stale"
            ? "stale"
            : "github-failed";
    throw new ToolRefusal(code, error.message.slice(0, 300), code === "github-failed" ? 3 : 1, {
      github: error.code,
      ...(typeof error.detail.status === "number" ? { status: error.detail.status } : {}),
    });
  }
  throw error;
}

const untrusted = (t: { text: string; truncated: boolean }, detail: boolean) => {
  const e = excerpt(t.text, detail);
  return { text: e.text, truncated: e.truncated || t.truncated, trust: "untrusted" as const };
};

const detailFor = (p: Principal) => p.profiles.some((x) => DETAIL_PROFILES.includes(x));

export const HANDLERS: {
  [N in ToolName]: (c: CallContext, input: Input<N>) => Promise<HandlerOutcome>;
} = {
  async comforge_capabilities(c) {
    const cli = cliCapabilities().result as Record<string, unknown>;
    const ids = [
      ...c.server.bindings.map((b) => b.id),
      ...(c.server.remoteBindings ?? []).map((b) => b.id),
    ];
    const allowed =
      c.principal.repositories === "*"
        ? ids
        : ids.filter((id) => (c.principal.repositories as readonly string[]).includes(id));
    return success(
      "comforge_capabilities",
      `${c.server.tools.length} tools for ${allowed.length} repositories (${c.principal.profiles.join(", ")})`,
      {
        schema: CAPABILITIES_SCHEMA,
        server: {
          name: SERVER_NAME,
          version: SERVER_VERSION,
          cli: CLI_VERSION,
          transport: c.transport,
        },
        principal: { id: c.principal.id, profiles: c.principal.profiles },
        repositories: allowed,
        ...((c.server.remoteBindings ?? []).length > 0
          ? {
              withoutCheckout: {
                repositories: (c.server.remoteBindings ?? [])
                  .map((b) => b.id)
                  .filter((id) => allowed.includes(id)),
                tools: REMOTE_READ_TOOLS,
                // 0.4.0: the governed publications this principal can reach without a checkout.
                governance: (c.server.remoteBindings ?? [])
                  .filter((b) => allowed.includes(b.id))
                  .map((b) => ({
                    repository: b.id,
                    tools: c.remoteHost?.governance?.(b, c.principal)
                      ? REMOTE_GOVERNANCE_TOOLS.filter((t) => c.server.tools.includes(t))
                      : [],
                  })),
              },
            }
          : {}),
        tools: c.server.tools.map((n) => ({
          name: n,
          executes: TOOLS[n].executes,
          writes: TOOLS[n].writes,
        })),
        execution: c.server.executionAvailable
          ? { available: true, isolation: c.server.isolation ?? "local process (stdio)" }
          : { available: false, reason: "no host-provided isolation on this transport" },
        cleanup: {
          plan: true,
          execute: true,
          authorization:
            "operator mode, or an owner command grant scoping cleanup of the merged pull request; a publication grant never authorizes it",
        },
        advisoryReviews: {
          available: true,
          note: "advisory reviews are marked comments, never native reviews or approvals; publishing one needs the reviewer profile",
        },
        never: [
          ...((cli.never as string[] | undefined) ?? []),
          "run an arbitrary shell command",
          "accept a caller-supplied path, URL, credential or runtime",
        ],
      },
    );
  },

  async comforge_context(c, input) {
    const rt = { ...(c.rt as Runtime), cwd: (c.binding as RepositoryBinding).root };
    try {
      const r = cliContext(rt, input.task ? { task: input.task } : {});
      const result = bound(r.result, 12_000) as Record<string, unknown>;
      return success(
        "comforge_context",
        r.exit && r.exit !== 0
          ? `manifest has ${((r.result as { issues?: unknown[] }).issues ?? []).length} issues`
          : input.task
            ? `routed: ${String((r.result as { match?: { id?: unknown } | null }).match?.id ?? "no match")}`
            : "categories",
        result,
      );
    } catch (error) {
      return fromServiceError(toServiceError(error));
    }
  },

  async comforge_status(c, input) {
    const r = await services(c).status(input.initiative ? { id: input.initiative } : {});
    return settle(r, (value) => {
      if (input.initiative) {
        const { validations, publications, completions, revisions, operations, ...head } =
          value as Record<string, unknown>;
        const count = (x: unknown) => (Array.isArray(x) ? x.length : 0);
        return success("comforge_status", `${input.initiative}: ${String(head.stage)}`, {
          ...head,
          counts: {
            validations: count(validations),
            publications: count(publications),
            completions: count(completions),
            revisions: count(revisions),
            operations: count(operations),
          },
        });
      }
      const all = ((value as { initiatives?: unknown[] }).initiatives ?? []) as Record<
        string,
        unknown
      >[];
      const compact = all.map((i) => ({
        initiative: i.initiative,
        stage: i.stage,
        branch: i.branch,
        lastValidation: (i.lastValidation as { status?: unknown; commit?: unknown } | null)
          ? {
              status: (i.lastValidation as { status?: unknown }).status,
              commit: (i.lastValidation as { commit?: unknown }).commit,
            }
          : null,
        cleanedAt: i.cleanedAt ?? null,
      }));
      const p = paginate(compact, input.cursor, input.pageSize);
      return success(
        "comforge_status",
        `${all.length} initiatives`,
        { initiatives: p.items },
        p.page,
      );
    });
  },

  async comforge_evidence(c, input) {
    const r = await services(c).status({ id: input.initiative });
    return settle(r, (value) => {
      const v = value as Record<string, unknown>;
      const raw = v[input.section] ?? [];
      const items = (Array.isArray(raw) ? [...raw].reverse() : []) as unknown[];
      const p = paginate(items, input.cursor, input.pageSize);
      return success(
        "comforge_evidence",
        `${input.initiative} ${input.section}: ${items.length} (newest first)`,
        { section: input.section, items: bound(p.items) as unknown[] },
        p.page,
      );
    });
  },

  async comforge_issue(c, input) {
    const { config, reads } = await evidence(c);
    try {
      if (input.number === undefined) {
        const state = input.state ?? "open";
        // Filtered on each issue's own state as well: the listing is evidence, not a promise.
        const all = (await reads.listIssues({ state }))
          .filter((i) => state === "all" || i.state === state)
          .sort((a, b) => b.number - a.number);
        const p = paginate(all, input.cursor, input.pageSize);
        return success(
          "comforge_issue",
          `${all.length} ${state} issues`,
          {
            issues: p.items.map((i) => ({
              number: i.number,
              title: untrusted(
                {
                  text: i.title.text.slice(0, 200),
                  truncated: i.title.truncated || i.title.text.length > 200,
                },
                false,
              ),
              state: i.state,
              labels: i.labels,
              updatedAt: i.updatedAt,
            })),
          },
          p.page,
        );
      }
      const protocol = specificationProtocol(config);
      const detail = Boolean(input.detail);
      if (protocol) {
        const s = await readSpecificationIssue(reads, protocol, input.number);
        return success(
          "comforge_issue",
          `#${input.number} ${s.issue.state}; specification ${s.verified ? "verified" : s.verification ? "modified" : "absent"}`,
          {
            issue: issueSummary(s.issue, detail),
            specification: s.verification
              ? {
                  ticketId: s.verification.ticketId,
                  digest: s.verification.digest,
                  digestMatches: s.verification.digestMatches,
                }
              : null,
            verified: s.verified,
          },
        );
      }
      const issue = await reads.getIssue(input.number);
      return success("comforge_issue", `#${input.number} ${issue.state}`, {
        issue: issueSummary(issue, detail),
        specification: null,
        verified: false,
      });
    } catch (error) {
      return githubRefusal(error);
    }
  },

  async comforge_pr(c, input) {
    const { reads } = await evidence(c);
    const detail = detailFor(c.principal);
    const include = new Set(input.include ?? []);
    try {
      const pr = await reads.getPullRequest(
        input.number,
        input.expectedHeadSha ? { expectedHeadSha: input.expectedHeadSha } : {},
      );
      const data: Record<string, unknown> = {
        pullRequest: {
          number: pr.number,
          title: untrusted(pr.title, false),
          state: pr.state,
          draft: pr.draft,
          merged: pr.merged,
          author: pr.author,
          url: pr.url,
          base: pr.base,
          head: { ref: pr.head.ref, sha: pr.head.sha },
        },
      };
      let page: ReturnType<typeof paginate>["page"] | undefined;
      if (include.has("checks")) {
        const checks = await reads.getChecks(pr.head.sha);
        data.checks = {
          ok: checks.ok,
          total: checks.checks.length,
          failing: checks.checks
            .filter(
              (x) => x.conclusion && !["success", "skipped", "neutral"].includes(x.conclusion),
            )
            .map((x) => x.name),
          pending: checks.checks.filter((x) => x.status !== "completed").map((x) => x.name),
        };
      }
      if (include.has("files")) {
        const files = await reads.listPullRequestFiles(
          pr.number,
          pr.head.sha,
          detail ? { patches: true } : {},
        );
        const p = paginate(files.files, input.cursor, input.pageSize);
        data.files = p.items.map((f) => ({
          path: f.path,
          status: f.status,
          additions: f.additions,
          deletions: f.deletions,
          ...(detail && f.patch ? { patch: untrusted(f.patch, true) } : {}),
        }));
        page = p.page;
      }
      if (include.has("reviews")) {
        const reviews = await reads.listReviews(pr.number);
        data.reviews = {
          // Native GitHub reviews only. An advisory review (a marked issue comment) is not
          // a GitHub review and is never presented as one.
          native: reviews.map((r) => ({
            id: r.id,
            author: r.author,
            state: r.state,
            commitSha: r.commitSha,
            current: r.commitSha === pr.head.sha,
            submittedAt: r.submittedAt,
            body: untrusted(r.body, detail),
          })),
          advisory: {
            available: false,
            reason: "advisory reviews are marked comments, read with comforge_reviews",
          },
        };
      }
      return success(
        "comforge_pr",
        `#${pr.number} ${pr.merged ? "merged" : pr.state} at ${pr.head.sha.slice(0, 12)}`,
        data,
        page,
      );
    } catch (error) {
      return githubRefusal(error);
    }
  },

  async comforge_start(c, input) {
    const r = await services(c).start({
      id: input.initiative,
      ...(input.issue ? { issue: input.issue } : {}),
      ...(input.expectDigest ? { expectDigest: input.expectDigest } : {}),
    });
    return settle(r, (v) =>
      success("comforge_start", `${v.initiative} on ${v.branch} from ${v.base.sha.slice(0, 12)}`, {
        ...v,
      }),
    );
  },

  async comforge_revise(c, input) {
    const r = await services(c).revise({
      pr: input.pr,
      ...(input.reviewedHead ? { reviewedHead: input.reviewedHead } : {}),
    });
    return settle(r, (v) =>
      success(
        "comforge_revise",
        `${v.initiative}: ${v.relation}${v.fastForwarded ? ", fast-forwarded" : ""}`,
        { ...v },
      ),
    );
  },

  async comforge_verify(c, input) {
    const r = await services(c).verify({
      id: input.initiative,
      ...(input.commit ? { commit: input.commit } : {}),
      ...(input.with ? { with: input.with } : {}),
    });
    return settle(r, (v, exit) =>
      success(
        "comforge_verify",
        `${v.initiative} ${v.status} at ${String(v.commit).slice(0, 12)}`,
        bound(v) as Record<string, unknown>,
        undefined,
        exit,
      ),
    );
  },

  async comforge_deliver(c, input) {
    if (JSON.stringify(input.result).length > 200_000)
      throw new ToolRefusal(
        "result-too-large",
        "the result document exceeds 200,000 characters",
        2,
      );
    return withGrantFile(input.grant, async (grantFile) => {
      const r = await services(c).deliver({
        id: input.initiative,
        title: input.title,
        raw: input.result,
        execute: input.execute,
        ...(input.closes ? { closes: input.closes } : {}),
        ...(input.draft ? { draft: true } : {}),
        ...(input.withoutPullRequest ? { withoutPullRequest: true } : {}),
        ...(grantFile ? { grantFile } : {}),
      });
      if (r.ok && r.value.delivery === "incomplete") return incompleteDelivery(r.value, r.exit);
      return settle(r, (v) =>
        success(
          "comforge_deliver",
          `${v.initiative}: ${v.delivery}`,
          bound(v) as Record<string, unknown>,
        ),
      );
    });
  },

  async comforge_recover(c, input) {
    return withGrantFile(input.grant, async (grantFile) => {
      const r = await services(c).recover({
        id: input.initiative,
        execute: input.execute,
        ...(input.abandon ? { abandon: true } : {}),
        ...(grantFile ? { grantFile } : {}),
      });
      return settle(r, (v, exit) =>
        success(
          "comforge_recover",
          `${input.initiative}: ${exit === 0 ? (input.execute ? "settled" : "planned") : "writes still open"}`,
          bound(v) as Record<string, unknown>,
          undefined,
          exit,
        ),
      );
    });
  },

  async comforge_cleanup(c, input) {
    // Executing is authorized by @comforge/cli: operator mode, or a command grant scoping
    // cleanup of the merged pull request (a publication grant never authorizes it).
    return withGrantFile(input.grant, async (grantFile) => {
      const r = await services(c).cleanup({
        target: input.target,
        execute: input.execute,
        ...(input.allowMissingCompletion ? { allowMissingCompletion: true } : {}),
        ...(grantFile ? { grantFile } : {}),
      });
      return settle(r, (v) =>
        success(
          "comforge_cleanup",
          `cleanup of ${input.target} ${input.execute ? "executed" : "planned"}`,
          bound(v) as Record<string, unknown>,
        ),
      );
    });
  },

  async comforge_prs(c, input) {
    const state = input.state ?? "open";
    const r: ServiceResult<Record<string, unknown>> = c.remote
      ? await remoteRead(c, async (reads) => ({
          pullRequests: await reads.listPullRequests({ state }),
        }))
      : await services(c).pullRequests({ state });
    return settle(r, (v) => {
      const all = (v.pullRequests as PullRequestSummary[]).sort((a, b) => b.number - a.number);
      const p = paginate(all, input.cursor, input.pageSize);
      return success(
        "comforge_prs",
        `${all.length} ${state} pull requests`,
        {
          pullRequests: p.items.map((pr) => ({
            number: pr.number,
            title: untrusted(
              {
                text: pr.title.text.slice(0, 200),
                truncated: pr.title.truncated || pr.title.text.length > 200,
              },
              false,
            ),
            state: pr.state,
            draft: pr.draft,
            merged: pr.merged,
            author: pr.author,
            head: { ref: pr.headRef, sha: pr.headSha },
            base: pr.baseRef,
            updatedAt: pr.updatedAt,
          })),
        },
        p.page,
      );
    });
  },

  async comforge_comments(c, input) {
    const r: ServiceResult<Record<string, unknown>> = c.remote
      ? await remoteRead(c, async (reads) => ({
          comments: await reads.listIssueComments(input.number),
        }))
      : await services(c).issueComments({ issue: input.number });
    const detail = Boolean(input.detail) && detailFor(c.principal);
    return settle(r, (v) => {
      const all = v.comments as IssueCommentEvidence[];
      const p = paginate(all, input.cursor, input.pageSize);
      return success(
        "comforge_comments",
        `#${input.number}: ${all.length} comments`,
        {
          comments: p.items.map((cm) => ({
            id: cm.id,
            author: cm.author,
            authorAssociation: cm.authorAssociation,
            createdAt: cm.createdAt,
            body: untrusted(cm.body, detail),
          })),
        },
        p.page,
      );
    });
  },

  async comforge_reviews(c, input) {
    const r: ServiceResult<Record<string, unknown>> = c.remote
      ? await remoteRead(c, async (reads, config, host) => {
          const rp = reviewProtocol(config);
          if (!rp)
            throw new ToolRefusal("config-invalid", "advisory reviews need a review section", 2);
          const pr = await reads.getPullRequest(input.pr);
          return {
            currentHead: pr.head.sha,
            reviews: await host.advisoryReviews(
              rp,
              { number: pr.number, headSha: pr.head.sha },
              { trustedAuthors: config.review?.trustedAuthors ?? [] },
            ),
          };
        })
      : await services(c).advisoryReviews({ pr: input.pr });
    const detail = detailFor(c.principal);
    return settle(r, (v) => {
      const all = v.reviews as AdvisoryReview[];
      const p = paginate(all, input.cursor, input.pageSize);
      return success(
        "comforge_reviews",
        `#${input.pr}: ${all.length} advisory reviews (${all.filter((x) => x.integrity === "verified" && !x.stale).length} verified and current)`,
        {
          // Advisory evidence: never a native review, an approval or authorization to act.
          kind: "advisory",
          currentHead: v.currentHead,
          reviews: p.items.map((rv) => ({
            commentId: rv.commentId,
            author: rv.author,
            // 0.2.0: present when the evidence carries them (published @comforge/github 0.6.0).
            ...("authorAssociation" in rv ? { authorAssociation: rv.authorAssociation } : {}),
            ...("commentUrl" in rv ? { commentUrl: rv.commentUrl } : {}),
            ...("updatedAt" in rv ? { updatedAt: rv.updatedAt } : {}),
            provenance: rv.provenance,
            integrity: rv.integrity,
            stale: rv.stale,
            reviewedHeadSha: rv.reviewedHeadSha,
            verdict: rv.verdict,
            reviewDigest: rv.reviewDigest,
            ticketId: rv.ticketId,
            createdAt: rv.createdAt,
            ...(rv.findingsBySeverity ? { findingsBySeverity: rv.findingsBySeverity } : {}),
            ...(detail && rv.review ? { review: bound(rv.review, LIMITS.detailChars) } : {}),
          })),
        },
        p.page,
      );
    });
  },

  async comforge_artifact(c, input) {
    const r: ServiceResult<Record<string, unknown>> = c.remote
      ? await remoteRead(c, async (reads, config) => {
          // The trusted configuration's artifact policy, exactly as @comforge/cli applies it.
          if (!artifactReadable(config, input.path))
            throw new ToolRefusal(
              "policy-denied",
              `${input.path} is outside the readable artifact paths`,
              1,
              {
                path: input.path,
              },
            );
          return { artifact: await reads.getFileAtCommit(input.commit, input.path) };
        })
      : await services(c).artifact({ commit: input.commit, path: input.path });
    const detail = detailFor(c.principal);
    return settle(r, (v) => {
      const a = v.artifact as FileAtCommitEvidence;
      return success("comforge_artifact", `${a.path} at ${a.commitSha.slice(0, 12)}: ${a.kind}`, {
        artifact: {
          commitSha: a.commitSha,
          path: a.path,
          blobSha: a.blobSha,
          size: a.size,
          kind: a.kind,
          ...(a.text ? { text: untrusted(a.text, detail) } : {}),
        },
      });
    });
  },

  async comforge_publish_review(c, input) {
    noRemoteGrant(c, input.grant);
    const publisher = c.remote ? await remoteGovernance(c, "comforge_publish_review") : services(c);
    return withGrantFile(input.grant, async (grantFile) => {
      const r = await publisher.publishReview({
        review: input.review,
        execute: input.execute,
        ...(grantFile ? { grantFile } : {}),
      });
      return settle(r, (v) =>
        success(
          "comforge_publish_review",
          `advisory review of #${String(v.pullRequest)}: ${String(v.action)}`,
          bound(v) as Record<string, unknown>,
        ),
      );
    });
  },

  async comforge_publish_specification(c, input) {
    noRemoteGrant(c, input.grant);
    const publisher = c.remote
      ? await remoteGovernance(c, "comforge_publish_specification")
      : services(c);
    return withGrantFile(input.grant, async (grantFile) => {
      const r = await publisher.publishSpecification({
        ticket: input.ticket,
        title: input.title,
        body: input.body,
        ...(input.issue ? { issue: input.issue } : {}),
        ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
        execute: input.execute,
        ...(grantFile ? { grantFile } : {}),
      });
      return settle(r, (v) =>
        success(
          "comforge_publish_specification",
          `${input.ticket}: ${String(v.action)}`,
          bound(v) as Record<string, unknown>,
        ),
      );
    });
  },

  async comforge_publish_comment(c, input) {
    const publisher = c.remote
      ? await remoteGovernance(c, "comforge_publish_comment")
      : services(c);
    const r = await publisher.publishComment({
      issue: input.issue,
      body: input.body,
      idempotencyKey: input.idempotencyKey,
      ...(input.relatedReview ? { relatedReview: input.relatedReview } : {}),
      execute: input.execute,
    });
    return settle(r, (v) =>
      success(
        "comforge_publish_comment",
        `discussion on #${String(input.issue)}: ${String(v.action)}`,
        bound(v) as Record<string, unknown>,
      ),
    );
  },
};

function issueSummary(
  issue: {
    number: number;
    title: { text: string; truncated: boolean };
    body: { text: string; truncated: boolean };
    state: string;
    author: string | null;
    labels: string[];
    url: string;
    updatedAt: string;
  },
  detail: boolean,
) {
  return {
    number: issue.number,
    title: untrusted(issue.title, false),
    state: issue.state,
    author: issue.author,
    labels: issue.labels,
    url: issue.url,
    updatedAt: issue.updatedAt,
    body: untrusted(issue.body, detail),
  };
}
