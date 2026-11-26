import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import { LedgerError } from "@comforge/ledger";
import { createFileLedger } from "@comforge/ledger/file";
import { z } from "zod";
import { fail } from "../errors.js";
import { canonical } from "../json.js";
import { checkoutDir, fetchBase, parseInitiative, trustedConfigAt } from "../repository.js";
import { nowIso, stateDir } from "../state.js";
/**
 * R1: `comforge migrate` imports an earlier lifecycle's local state (`state.legacy` in the
 * trusted configuration) into comforge initiative records.
 *
 * Safety properties, each tested:
 * - Dry run by default; `--execute` changes local state only (no GitHub request).
 * - Exclusive ownership: before importing, `--execute` writes a `.migrated` sentinel into the
 *   legacy directory. The earlier lifecycle refuses to write once it exists, and comforge
 *   refuses a legacy ticket until it is imported, so the two never write one initiative.
 * - Write identities: the GitHub write ledger is not copied. The trusted configuration must
 *   share the legacy write ledger (`state.writeLedgerDirectory`), so every unresolved write is
 *   reconciled by `comforge recover` under its original identity. Each write is attached to
 *   the initiatives it concerns (by pull request, issue or branch); an unresolved write that
 *   cannot be attached refuses the migration. Until an initiative's writes are resolved,
 *   comforge sends no new write for it, so a differently derived identity cannot repeat one.
 * - Journal and restart: a `migrations` record says `importing` until every record is in;
 *   a rerun skips records already imported from the same bytes and refuses any other conflict.
 * - Backup: the legacy records are copied, byte for byte, under `comforge/migration-backup/`;
 *   the legacy files themselves are never modified.
 * - Rollback (`--rollback --execute`) only while nothing changed since the import: no imported
 *   record has a newer version or new operations, and no initiative was started in comforge.
 *   It retires the imported records and removes the sentinel. Anything else is refused.
 */
export const LEGACY_FORMAT = "agent-lifecycle/v1";
export const SENTINEL = ".migrated";
const JOURNAL_SCHEMA = "comforge-migration/v1";
const SHA40 = z.string().regex(/^[0-9a-f]{40}$/);
const ISO = z.string().min(10).max(40);
/** The earlier lifecycle's record, strictly: an unknown field is data this import would lose. */
const LegacyRecord = z
    .object({
    schemaVersion: z.literal(1),
    ticket: z.string().min(1).max(120),
    branch: z.string().min(1).max(200),
    baseSha: SHA40,
    specification: z
        .object({
        issueNumber: z.number().int().positive(),
        digest: z.string().regex(/^[0-9a-f]{64}$/),
        digestVerified: z.boolean(),
    })
        .strict()
        .nullable(),
    checkout: z.string().max(1000).nullable(),
    createdAt: ISO,
    validations: z.array(z
        .object({
        commit: SHA40,
        tree: SHA40,
        status: z.enum(["PASS", "FAIL", "UNAVAILABLE"]),
        command: z.string().max(4000),
        startedAt: ISO,
        durationMs: z.number().nonnegative(),
        provisioning: z.array(z.string().max(4000)).max(50),
        summary: z.record(z.string(), z.unknown()).nullable(),
    })
        .strict()),
    publications: z.array(z
        .object({
        commit: SHA40,
        prNumber: z.number().int().positive(),
        action: z.enum(["created", "updated", "adopted"]),
        at: ISO,
    })
        .strict()),
    cleanup: z
        .object({
        prNumber: z.number().int().positive(),
        mergeCommit: SHA40,
        headRefOid: SHA40,
        steps: z.record(z.string(), z
            .object({
            status: z.enum(["done", "skipped", "refused"]),
            at: ISO,
            note: z.string().max(2000).optional(),
        })
            .strict()),
        completedAt: ISO.nullable(),
    })
        .strict()
        .nullable(),
    closed: z
        .object({
        at: ISO,
        reason: z.enum(["audit-completed", "execution-cancelled"]),
        executionId: z.string().max(200).nullable(),
    })
        .strict()
        .nullable()
        .optional(),
    deliveryPolicy: z.literal("automatic").optional(),
    completions: z
        .array(z
        .object({
        commit: SHA40,
        issueNumber: z.number().int().positive(),
        commentId: z.number().int().positive(),
        completionDigest: z.string().max(200),
        outcome: z.string().max(40),
        prNumber: z.number().int().positive().nullable(),
        at: ISO,
    })
        .strict())
        .optional(),
    deliveries: z
        .array(z
        .object({
        commit: SHA40,
        prNumber: z.number().int().positive().nullable(),
        issueNumber: z.number().int().positive(),
        outcome: z.string().max(40),
        state: z.enum(["complete", "incomplete"]),
        failedStage: z.enum(["publish", "pull_request", "completion", "read_back"]).nullable(),
        commentId: z.number().int().positive().nullable(),
        detail: z.string().max(4000).nullable(),
        at: ISO,
    })
        .strict())
        .optional(),
})
    .strict();
/** The `agent-lifecycle/v1` record schema (strict), for consumers that check their own writer. */
export const LegacyRecordSchema = LegacyRecord;
const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const UNRESOLVED = new Set(["reserved", "sending", "indeterminate"]);
/** Reads every legacy record; any record that is not exactly the known format refuses all. */
function readLegacy(dir) {
    if (!existsSync(dir))
        return [];
    const files = readdirSync(dir)
        .filter((f) => f.endsWith(".json"))
        .sort();
    return files.map((f) => {
        const file = path.join(dir, f);
        const bytes = readFileSync(file);
        let raw;
        try {
            raw = JSON.parse(bytes.toString("utf8"));
        }
        catch {
            return fail("conflict", `${f} is not JSON; the legacy state is not importable`, { file: f });
        }
        const parsed = LegacyRecord.safeParse(raw);
        if (!parsed.success)
            return fail("conflict", `${f} is not an ${LEGACY_FORMAT} record`, {
                file: f,
                issues: parsed.error.issues
                    .slice(0, 10)
                    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
            });
        const record = parsed.data;
        if (`${record.ticket}.json` !== f)
            fail("conflict", `${f} holds ${record.ticket}; refusing an ambiguous record`, { file: f });
        return { id: record.ticket, file: f, sha256: sha256(bytes), record };
    });
}
/** Every write in the shared ledger, by id. Discovery lists directories; each record is read through the ledger. */
async function readWrites(dir, namespace) {
    const ledger = createFileLedger({ directory: dir, namespace });
    const nsDir = path.join(dir, namespace);
    if (!existsSync(nsDir))
        return { ledger, records: [] };
    const records = [];
    for (const entry of readdirSync(nsDir).sort()) {
        const opDir = path.join(nsDir, entry);
        if (!statSync(opDir).isDirectory())
            continue;
        const versions = readdirSync(opDir)
            .filter((v) => /^\d+\.json$/.test(v))
            .sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10));
        const latest = versions.at(-1);
        if (!latest)
            continue;
        let id;
        try {
            id = JSON.parse(readFileSync(path.join(opDir, latest), "utf8"))
                .operationId;
        }
        catch {
            id = undefined;
        }
        if (typeof id !== "string")
            fail("conflict", "a write in the legacy ledger is unreadable; migration refused", {
                directory: entry,
            });
        const record = await ledger.get(id).catch((error) => {
            if (error instanceof LedgerError)
                fail("conflict", `the legacy write ${String(id)} is unreadable`, { code: error.code });
            throw error;
        });
        if (record)
            records.push(record);
    }
    return { ledger, records };
}
/** Which initiatives a write concerns: its pull request, its issue, or the branch it created. */
function owners(op, legacy) {
    const target = op.descriptor.target;
    const payload = op.descriptor.payload;
    return legacy
        .filter(({ record }) => {
        if (op.kind === "pull.create")
            return payload?.head === record.branch;
        if (target?.type === "pull")
            return record.publications.some((p) => p.prNumber === target.number);
        if (target?.type === "issue")
            return (record.specification?.issueNumber === target.number ||
                (record.completions ?? []).some((c) => c.issueNumber === target.number));
        return false;
    })
        .map((l) => l.id);
}
function convert(l, trusted, root, revision, digest, operations, directory, at) {
    const r = l.record;
    const initiative = parseInitiative(r.ticket, trusted);
    if (initiative.branch !== r.branch)
        fail("conflict", `${r.ticket} uses branch ${r.branch}, not ${initiative.branch}`, {
            initiative: r.ticket,
        });
    if (r.specification && !r.specification.digestVerified)
        fail("conflict", `${r.ticket} records an unverified specification; not importable`, {
            initiative: r.ticket,
        });
    const { owner, name, webOrigin, remote, baseBranch } = trusted.repository;
    return {
        ticket: initiative.ticket,
        phase: initiative.phase,
        branch: r.branch,
        checkout: r.checkout ?? checkoutDir(trusted, root, initiative),
        primary: root,
        base: { remote, branch: baseBranch, sha: r.baseSha },
        trustedConfig: digest,
        trustedConfigRevision: revision,
        specification: r.specification
            ? { issueNumber: r.specification.issueNumber, digest: r.specification.digest }
            : null,
        validations: r.validations.map((v) => ({
            commit: v.commit,
            tree: v.tree,
            status: v.status,
            at: v.startedAt,
            commands: [
                {
                    name: v.command,
                    exitStatus: v.status === "PASS" ? 0 : null,
                    timedOut: false,
                    durationMs: v.durationMs,
                },
            ],
            snapshot: true,
            summary: v.summary
                ? {
                    path: "(legacy summary)",
                    sha256: sha256(canonical(v.summary)),
                    bytes: canonical(v.summary).length,
                    content: v.summary,
                }
                : null,
        })),
        revisions: [],
        publications: r.publications.map((p) => ({
            commit: p.commit,
            prNumber: p.prNumber,
            url: `${webOrigin}/${owner}/${name}/pull/${p.prNumber}`,
            at: p.at,
        })),
        completions: (r.completions ?? []).map((c) => ({ ...c })),
        operations,
        cleanedAt: r.cleanup?.completedAt ?? r.closed?.at ?? null,
        ...(r.cleanup
            ? {
                cleanup: {
                    prNumber: r.cleanup.prNumber,
                    mergeCommit: r.cleanup.mergeCommit,
                    steps: Object.fromEntries(Object.entries(r.cleanup.steps).map(([k, s]) => [
                        k,
                        { at: s.at, detail: `${s.status}${s.note ? `: ${s.note}` : ""}` },
                    ])),
                    completedAt: r.cleanup.completedAt,
                },
            }
            : {}),
        deliveries: (r.deliveries ?? []).map((d, i) => ({
            attempt: i + 1,
            head: d.commit,
            startedAt: d.at,
            finishedAt: d.at,
            outcome: d.state,
            stages: [],
            failedStage: d.failedStage,
        })),
        migratedFrom: {
            format: LEGACY_FORMAT,
            directory,
            file: l.file,
            sha256: l.sha256,
            importedAt: at,
        },
    };
}
function journalLedger(commonDir) {
    return createFileLedger({
        directory: stateDir(commonDir),
        namespace: "migrations",
        validate: (r) => {
            if (r.schema !== JOURNAL_SCHEMA)
                throw new LedgerError("foreign", "not a migration journal");
        },
    });
}
/** Whether `id` is a legacy initiative that has not been imported (start and revise refuse it). */
export async function legacyUnmigrated(ctx, config, id) {
    const legacy = config.state.legacy;
    if (!legacy)
        return false;
    if (!existsSync(path.join(ctx.repo.commonDir, legacy.directory, `${id}.json`)))
        return false;
    const record = await ctx.state.get(id);
    return !record?.migratedFrom;
}
export async function migrate(ctx, options) {
    const { rt, repo } = ctx;
    const baseSha = fetchBase(rt, repo.root, ctx.working());
    const { config: trusted, digest } = trustedConfigAt(rt, repo.root, baseSha);
    const legacy = trusted.state.legacy;
    if (!legacy)
        return fail("config-invalid", "state.legacy is not set in the trusted configuration; nothing to migrate");
    const dir = path.join(repo.commonDir, legacy.directory);
    const journals = journalLedger(repo.commonDir);
    const journalId = `migration-${legacy.directory}`;
    const journal = await journals.get(journalId);
    if (options.rollback)
        return rollback(ctx, journals, journal, dir, options.execute);
    if (journal?.state === "cut-over")
        return {
            result: {
                executed: false,
                state: "cut-over",
                directory: legacy.directory,
                imported: journal.imported.length,
            },
        };
    const take = () => inventory(ctx, trusted, { dir, legacy, baseSha, digest, at: nowIso(rt.now()) });
    if (!options.execute) {
        const first = await take();
        return { result: { executed: false, ...first.summary } };
    }
    // A dry run's refusals come before anything is locked.
    await take();
    ctx.checkpoint();
    // 1. Exclusive ownership. The sentinel first: an earlier-lifecycle writer that starts from
    //    now on sees it and stops. Then every writer that registered before it must end: the
    //    inventory is taken only once no earlier-lifecycle process can still write.
    const at = nowIso(rt.now());
    let createdSentinel = false;
    try {
        writeFileSync(path.join(dir, SENTINEL), `${JSON.stringify({ migratedTo: "comforge", journal: journalId, at })}\n`, { flag: "wx" });
        createdSentinel = true;
    }
    catch (error) {
        // Already present: an earlier or concurrent run of this migration holds the lock.
        if (error.code !== "EEXIST")
            throw error;
    }
    const writers = await quiesce(ctx, dir, options.waitSeconds ?? 30);
    if (writers.live.length > 0) {
        // Fail closed. A sentinel this run created before any import is withdrawn, so the earlier
        // lifecycle keeps working; nothing was imported.
        if (createdSentinel && !(await journals.get(journalId)))
            rmSync(path.join(dir, SENTINEL), { force: true });
        return fail("conflict", "earlier-lifecycle writers are still running; rerun when they have finished", {
            live: writers.live,
        });
    }
    ctx.checkpoint();
    // 2. The inventory, now that nothing else writes, then the backup and the journal.
    const { files, inventorySha256, plan, summary } = await take();
    if (journal && journal.state === "importing" && journal.inventorySha256 !== inventorySha256)
        fail("conflict", "the legacy state changed since the interrupted migration started; inspect it", {
            started: journal.inventorySha256,
            now: inventorySha256,
        });
    const backup = path.join(stateDir(repo.commonDir), "migration-backup", legacy.directory);
    mkdirSync(backup, { recursive: true });
    for (const f of files) {
        const target = path.join(backup, f.file);
        if (!existsSync(target))
            copyFileSync(path.join(dir, f.file), target);
        else if (sha256(readFileSync(target)) !== f.sha256)
            fail("conflict", `the backup of ${f.file} differs from the record; inspect ${backup}`);
    }
    ctx.checkpoint();
    let current = journal && journal.state === "importing"
        ? journal
        : {
            schema: JOURNAL_SCHEMA,
            operationId: journalId,
            version: 1,
            state: "importing",
            directory: legacy.directory,
            trustedConfigRevision: baseSha,
            inventorySha256,
            backup,
            startedAt: at,
            completedAt: null,
            imported: [],
        };
    if (!journal) {
        if (!(await journals.create(current)))
            fail("conflict", "another migration started; rerun");
    }
    else if (journal.state === "rolled-back") {
        const next = { ...current, version: journal.version + 1 };
        if (!(await journals.replace(journalId, journal.version, next)))
            fail("conflict", "the journal changed; rerun");
        current = next;
    }
    // 3. Import, one record at a time (each is atomic; a crash resumes here).
    for (const entry of plan) {
        ctx.checkpoint();
        if (entry.action === "already-imported")
            continue;
        const f = files.find((x) => x.id === entry.id);
        const fields = convert(f, trusted, repo.root, baseSha, digest, entry.operations, legacy.directory, at);
        const retired = await ctx.state.get(f.id);
        if (retired?.migratedFrom?.retiredAt) {
            // Only a record retired by a rollback is replaced, by compare-and-swap.
            await ctx.state.update(f.id, (r) => {
                Object.assign(r, fields);
            });
        }
        else
            await ctx.state.create(fields, f.id);
    }
    ctx.checkpoint();
    // 4. Cutover.
    const imported = await Promise.all(files.map(async (f) => ({
        id: f.id,
        sha256: f.sha256,
        version: (await ctx.state.get(f.id))?.version ?? 0,
    })));
    const done = {
        ...current,
        version: current.version + 1,
        state: "cut-over",
        completedAt: nowIso(rt.now()),
        imported,
    };
    if (!(await journals.replace(journalId, current.version, done)))
        fail("conflict", "the journal changed; rerun");
    return {
        result: { executed: true, state: "cut-over", backup, staleWriters: writers.stale, ...summary },
    };
}
/** The legacy records and writes, mapped and planned; refuses what it cannot import exactly. */
async function inventory(ctx, trusted, facts) {
    const { dir, legacy, baseSha, digest, at } = facts;
    const files = readLegacy(dir);
    const inventorySha256 = sha256(canonical(files.map((f) => [f.file, f.sha256])));
    // The shared write ledger keeps every identity; a separate one would lose replay protection.
    const { records: writes } = await readWrites(dir, "writes");
    if (writes.length > 0 &&
        (trusted.state.writeLedgerDirectory !== legacy.directory ||
            trusted.security.ledgerNamespace !== "writes"))
        fail("conflict", "the legacy writes must stay in their ledger: set state.writeLedgerDirectory to the legacy directory and security.ledgerNamespace to writes", { writes: writes.length });
    const unassigned = [];
    const opsById = new Map();
    for (const op of writes) {
        const ids = owners(op, files);
        if (ids.length === 0) {
            if (UNRESOLVED.has(op.state))
                fail("conflict", `the unresolved write ${op.operationId} belongs to no legacy initiative; resolve it first`, {
                    operationId: op.operationId,
                    state: op.state,
                });
            unassigned.push(op.operationId);
        }
        for (const id of ids)
            opsById.set(id, [...(opsById.get(id) ?? []), op.operationId]);
    }
    const plan = [];
    for (const f of files) {
        const existing = await ctx.state.get(f.id);
        if (existing) {
            if (existing.migratedFrom?.sha256 === f.sha256 && !existing.migratedFrom.retiredAt) {
                plan.push({
                    id: f.id,
                    action: "already-imported",
                    sha256: f.sha256,
                    operations: existing.operations,
                });
                continue;
            }
            // Only a record this migration imported and a rollback retired may be imported again.
            if (!existing.migratedFrom?.retiredAt)
                fail("conflict", `${f.id} already has comforge state that is not this legacy record`, {
                    initiative: f.id,
                });
        }
        // Converted now so a dry run refuses exactly what --execute would.
        convert(f, trusted, ctx.repo.root, baseSha, digest, opsById.get(f.id) ?? [], legacy.directory, at);
        plan.push({
            id: f.id,
            action: "import",
            sha256: f.sha256,
            operations: (opsById.get(f.id) ?? []).sort(),
        });
    }
    const unresolved = writes.filter((w) => UNRESOLVED.has(w.state)).map((w) => w.operationId);
    return {
        files,
        inventorySha256,
        plan,
        summary: {
            directory: legacy.directory,
            format: legacy.format,
            trustedConfigRevision: baseSha,
            inventorySha256,
            records: files.length,
            writes: writes.length,
            unresolvedWrites: unresolved,
            unassignedFinishedWrites: unassigned.length,
            plan,
        },
    };
}
/** Writer registrations of the earlier lifecycle (`<legacy>/.writers/`), alive or not. */
const WRITERS = ".writers";
/**
 * Waits until no registered earlier-lifecycle writer is alive, for at most `seconds`.
 * Liveness is checked through the runtime (`kill -0` on this host); a registration from
 * another host counts as alive (fail closed). Dead registrations are reported, not removed:
 * their unresolved writes, if any, are in the inventory taken next.
 */
async function quiesce(ctx, dir, seconds) {
    // Bounded by polls, not the runtime clock: an injected clock may stand still.
    const polls = Math.max(1, Math.ceil((seconds * 1000) / 200));
    const here = hostname();
    for (let poll = 1;; poll++) {
        const live = [];
        let stale = 0;
        const wdir = path.join(dir, WRITERS);
        for (const name of existsSync(wdir) ? readdirSync(wdir) : []) {
            let entry = {};
            try {
                entry = JSON.parse(readFileSync(path.join(wdir, name), "utf8"));
            }
            catch {
                // A registration being written right now: count it as alive and look again.
                live.push({ pid: -1, host: here, label: name });
                continue;
            }
            const pid = typeof entry.pid === "number" ? entry.pid : -1;
            const host = typeof entry.host === "string" ? entry.host : "";
            const alive = host !== here ||
                (pid > 0 && ctx.rt.run("kill", ["-0", String(pid)], { cwd: dir, env: {} }).status === 0);
            if (alive)
                live.push({ pid, host, label: String(entry.label ?? "") });
            else
                stale++;
        }
        if (live.length === 0 || poll >= polls)
            return { live, stale };
        await new Promise((resolve) => setTimeout(resolve, 200));
    }
}
async function rollback(ctx, journals, journal, dir, execute) {
    if (!journal || journal.state === "rolled-back")
        return fail("not-found", "there is no migration to roll back");
    const problems = [];
    const all = await ctx.state.list();
    const importedIds = new Set(journal.imported.map((i) => i.id));
    for (const r of all) {
        if (!importedIds.has(r.operationId)) {
            if (!r.migratedFrom)
                problems.push(`${r.operationId} was started in comforge after the migration`);
            continue;
        }
        // Every change (validation, publication, completion, operation, grant use) bumps the version.
        const entry = journal.imported.find((i) => i.id === r.operationId);
        if (!entry || r.version !== entry.version)
            problems.push(`${r.operationId} changed after the import (version ${r.version})`);
    }
    // A rollback must not restore stale state over newer mutations: refuse instead.
    if (problems.length > 0)
        fail("conflict", "rollback would discard changes made after the migration; refused", {
            problems,
        });
    const plan = {
        retire: journal.imported.map((i) => i.id),
        removeSentinel: path.join(dir, SENTINEL),
    };
    if (!execute)
        return { result: { executed: false, rollback: plan } };
    const at = nowIso(ctx.rt.now());
    for (const entry of journal.imported)
        await ctx.state.update(entry.id, (r) => {
            // Retired: loadInitiative refuses it; a later migration may replace it.
            r.cleanedAt = r.cleanedAt ?? at;
            if (r.migratedFrom)
                r.migratedFrom = { ...r.migratedFrom, retiredAt: at };
        });
    const next = {
        ...journal,
        version: journal.version + 1,
        state: "rolled-back",
        completedAt: at,
    };
    if (!(await journals.replace(journal.operationId, journal.version, next)))
        fail("conflict", "the journal changed; rerun");
    const sentinel = path.join(dir, SENTINEL);
    if (existsSync(sentinel))
        rmSync(sentinel);
    return { result: { executed: true, rollback: plan } };
}
