/**
 * `@comforge/mcp/host`: the engineering services an embedding host runs in its own process.
 *
 * The MCP server of this package and an embedded host (an application that serves its own
 * tools, sessions and storage) use the same services: exact-commit evidence reads, advisory
 * reviews, the trusted configuration at a base revision, governed writes and their durable
 * operation records. Nothing here opens a socket for a caller or starts a process.
 *
 * What the host owns and injects, and a caller never supplies:
 * - the repository (one `owner/name`; every request stays inside it);
 * - the read transport, with its credential, limits and error mapping;
 * - for writes: the credential, the capabilities, the authorization decision for each exact
 *   descriptor, and the operation store. Without `writes` the host is read-only and every
 *   write is refused before a request exists.
 *
 * Two profiles follow from that. An embedded trusted host may be given `writes`. A
 * checkout-free network profile (the server's remote repositories) is built without them.
 */
import { createHash } from "node:crypto";
import { createFetchTransport, createGitHubEvidence, createGitHubWriter, GitHubAdapterError, listAdvisoryReviews, } from "@comforge/github";
import { createSQLiteLedger, statementDriver, } from "@comforge/ledger/sqlite";
export const HOST_SERVICES_SCHEMA = "comforge-host-services/v1";
/**
 * Every refusal of these services: `code` is stable, `detail` carries no credential or body.
 * One class for reads, writes and stores, so a host maps it once.
 */
export const HostServiceError = GitHubAdapterError;
/** A transport over `fetch` with a server-owned token; GitHub's API origin unless overridden. */
export function fetchTransport(options) {
    return createFetchTransport(options);
}
const CONFIG_FILE = "comforge.config.json";
const DEFAULT_CONFIG_MAX_BYTES = 64 * 1024;
const NAME = /^[A-Za-z0-9_.-]{1,100}$/;
const BRANCH = /^(?!\/)(?!.*\/\/)(?!.*\.\.)[A-Za-z0-9._/-]{1,200}(?<!\/)$/;
const SHA40 = /^[0-9a-f]{40}$/;
function readOnly() {
    throw new GitHubAdapterError("capability-denied", "this host is read-only");
}
export function createEngineeringHost(options) {
    const { owner, name } = options.repository ?? {};
    if (!NAME.test(owner ?? "") || !NAME.test(name ?? ""))
        throw new TypeError("@comforge/mcp/host: repository owner and name must be GitHub names");
    if (typeof options.transport?.get !== "function")
        throw new TypeError("@comforge/mcp/host: a read transport is required");
    const root = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
    const evidence = createGitHubEvidence({
        transport: options.transport,
        repository: { owner, name },
        ...(options.evidenceLimits ? { limits: options.evidenceLimits } : {}),
    });
    const w = options.writes;
    let writer = null;
    const governed = () => {
        if (!w)
            return readOnly();
        writer ??= createGitHubWriter({
            repository: { owner, name },
            token: w.token,
            capabilities: w.capabilities,
            authorize: w.authorize,
            ledger: w.operations,
            clock: w.clock,
            ...(w.markers !== undefined ? { markers: w.markers } : {}),
            ...(w.expectedAuthor !== undefined ? { expectedAuthor: w.expectedAuthor } : {}),
            ...(w.fetchImpl ? { fetchImpl: w.fetchImpl } : {}),
            ...(w.apiOrigin !== undefined ? { apiOrigin: w.apiOrigin } : {}),
            ...(w.timeoutMs !== undefined ? { timeoutMs: w.timeoutMs } : {}),
            ...(w.maxBodyBytes !== undefined ? { maxBodyBytes: w.maxBodyBytes } : {}),
            ...(w.userAgent !== undefined ? { userAgent: w.userAgent } : {}),
        });
        return writer;
    };
    const host = {
        schema: HOST_SERVICES_SCHEMA,
        repository: `${owner}/${name}`,
        profile: w ? "governed-writes" : "read-only",
        evidence,
        advisoryReviews: (protocol, pullRequest, reviewOptions) => listAdvisoryReviews(evidence, protocol, pullRequest, {
            trustedAuthors: reviewOptions.trustedAuthors,
        }),
        async trustedConfig({ branch, now = Date.now, maxBytes = DEFAULT_CONFIG_MAX_BYTES }) {
            if (!BRANCH.test(branch))
                throw new GitHubAdapterError("invalid-input", "the base branch name is malformed");
            const ref = (await options.transport.get(`${root}/git/ref/heads/${branch}`));
            const revision = ref?.object?.sha;
            if (typeof revision !== "string" || !SHA40.test(revision))
                throw new GitHubAdapterError("malformed-response", "GitHub returned no commit for the branch");
            const observedAt = now();
            const file = await evidence.getFileBytesAtCommit(revision, CONFIG_FILE, { maxBytes });
            if (file.kind !== "bytes")
                throw new GitHubAdapterError("too-large", "the trusted configuration is too large");
            let text;
            try {
                text = new TextDecoder("utf-8", { fatal: true }).decode(file.bytes);
            }
            catch {
                throw new GitHubAdapterError("malformed-response", "the trusted configuration is not UTF-8");
            }
            return { revision, text, observedAt };
        },
        async confirmTrustedConfig(snapshot) {
            let committed;
            try {
                committed = await evidence.getFileBytesAtCommit(snapshot.revision, CONFIG_FILE);
            }
            catch (error) {
                if (error instanceof GitHubAdapterError &&
                    (error.code === "not-found" || error.code === "wrong-target"))
                    return "absent";
                throw error;
            }
            return committed.kind === "bytes" &&
                Buffer.compare(Buffer.from(committed.bytes), Buffer.from(snapshot.text, "utf8")) === 0
                ? "match"
                : "mismatch";
        },
        writes: Object.freeze({
            prepare: async (operation) => governed().prepare(operation),
            execute: async (operation) => governed().execute(operation),
            reconcile: async (operationId) => governed().reconcile(operationId),
            abandon: async (operationId, reason) => governed().abandon(operationId, reason),
        }),
    };
    return Object.freeze(host);
}
// --- durable operation records -----------------------------------------------------------------
/** An operation that can never be sent again: succeeded, abandoned, or failed without retry. */
export function isFinished(record) {
    return (record.state === "succeeded" ||
        record.state === "abandoned" ||
        (record.state === "failed" && record.failure?.retryable !== true));
}
/**
 * The stored form of a record: a finished one keeps a digest of its body instead of the body.
 * Identity, version, fingerprint, descriptor digest, outcome and failure are untouched.
 */
export function minimizeFinished(record) {
    if (!isFinished(record))
        return record;
    const body = record.descriptor.payload.body;
    if (typeof body !== "string" || body.startsWith("[omitted; sha256:"))
        return record;
    const digest = `sha256:${createHash("sha256").update(body).digest("hex")}`;
    return {
        ...record,
        descriptor: {
            ...record.descriptor,
            payload: { ...record.descriptor.payload, body: `[omitted; ${digest}]` },
        },
    };
}
export function retentionClass(record) {
    if (!isFinished(record))
        return record.state === "failed" ? "retryable" : "unresolved";
    return minimizeFinished(record) === record ? "finished-compact" : "finished-compactable";
}
const STATES = ["reserved", "sending", "succeeded", "failed", "indeterminate", "abandoned"];
function wellFormed(record) {
    const r = record;
    const d = r.descriptor;
    return (r.schema === "comforge-github-operation/v1" &&
        typeof r.operationId === "string" &&
        typeof r.repository === "string" &&
        typeof r.kind === "string" &&
        typeof r.fingerprint === "string" &&
        Number.isInteger(r.version) &&
        r.version > 0 &&
        STATES.includes(r.state) &&
        typeof d === "object" &&
        d !== null &&
        typeof d.digest === "string" &&
        typeof d.payload === "object" &&
        d.payload !== null &&
        !Array.isArray(d.payload));
}
/** What each state must carry: an outcome once succeeded, a failure once failed, a send time once sent. */
function stateConsistent(record) {
    switch (record.state) {
        case "succeeded":
            return (record.outcome !== null && record.outcome.resource !== null && record.firstSentAt !== null);
        case "failed":
            return record.failure !== null;
        case "sending":
            return record.firstSentAt !== null && record.leaseUntil !== null;
        case "indeterminate":
            return record.firstSentAt !== null;
        case "reserved":
            return record.leaseUntil !== null;
        case "abandoned":
            return true;
        default:
            return false;
    }
}
/**
 * The operation store over the host's SQLite database. Atomic across processes and restarts
 * (insert-if-absent, version-checked replace). A record never holds a credential, a finished
 * one is stored minimized, and one that is malformed, of another repository or inconsistent
 * with its state is refused, so the writer reports a store failure and sends nothing.
 */
export function sqliteOperationStore(options) {
    const table = options.table ?? "comforge_ledger";
    const extra = options.kindAndStateColumns
        ? {
            columns: (record) => ({
                kind: record.kind,
                state: record.state,
            }),
            fixedColumns: ["kind"],
        }
        : {};
    const ledger = createSQLiteLedger({
        driver: statementDriver(options.database),
        namespace: options.repository,
        table,
        ...(options.repositoryColumn ? { namespaceColumn: options.repositoryColumn } : {}),
        ...extra,
        validate(record) {
            if (!wellFormed(record))
                throw new Error(`${table} record is malformed`);
            if (record.repository !== options.repository || !stateConsistent(record))
                throw new Error(`${table} record is inconsistent with its state`);
        },
        encode: minimizeFinished,
        ...(options.clock ? { clock: options.clock } : {}),
    });
    return {
        get: (operationId) => ledger.get(operationId),
        create: (record) => ledger.create(record),
        replace: (operationId, expectedVersion, next) => ledger.replace(operationId, expectedVersion, next),
        inspect: () => ledger.inspect({ classify: retentionClass }),
        compact: ({ before, limit }) => ledger.compact({
            updatedBefore: before,
            limit,
            select: isFinished,
            rewrite: minimizeFinished,
        }),
    };
}
