import { z } from "zod";
import type { ComforgeConfig } from "../config.ts";
import type { CommandContext } from "../context.ts";
import type { CommandResult } from "./lifecycle.ts";
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
export declare const LEGACY_FORMAT = "agent-lifecycle/v1";
export declare const SENTINEL = ".migrated";
/** The `agent-lifecycle/v1` record schema (strict), for consumers that check their own writer. */
export declare const LegacyRecordSchema: z.ZodObject<{
    schemaVersion: z.ZodLiteral<1>;
    ticket: z.ZodString;
    branch: z.ZodString;
    baseSha: z.ZodString;
    specification: z.ZodNullable<z.ZodObject<{
        issueNumber: z.ZodNumber;
        digest: z.ZodString;
        digestVerified: z.ZodBoolean;
    }, z.core.$strict>>;
    checkout: z.ZodNullable<z.ZodString>;
    createdAt: z.ZodString;
    validations: z.ZodArray<z.ZodObject<{
        commit: z.ZodString;
        tree: z.ZodString;
        status: z.ZodEnum<{
            FAIL: "FAIL";
            PASS: "PASS";
            UNAVAILABLE: "UNAVAILABLE";
        }>;
        command: z.ZodString;
        startedAt: z.ZodString;
        durationMs: z.ZodNumber;
        provisioning: z.ZodArray<z.ZodString>;
        summary: z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, z.core.$strict>>;
    publications: z.ZodArray<z.ZodObject<{
        commit: z.ZodString;
        prNumber: z.ZodNumber;
        action: z.ZodEnum<{
            adopted: "adopted";
            created: "created";
            updated: "updated";
        }>;
        at: z.ZodString;
    }, z.core.$strict>>;
    cleanup: z.ZodNullable<z.ZodObject<{
        prNumber: z.ZodNumber;
        mergeCommit: z.ZodString;
        headRefOid: z.ZodString;
        steps: z.ZodRecord<z.ZodString, z.ZodObject<{
            status: z.ZodEnum<{
                done: "done";
                refused: "refused";
                skipped: "skipped";
            }>;
            at: z.ZodString;
            note: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>>;
        completedAt: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>>;
    closed: z.ZodOptional<z.ZodNullable<z.ZodObject<{
        at: z.ZodString;
        reason: z.ZodEnum<{
            "audit-completed": "audit-completed";
            "execution-cancelled": "execution-cancelled";
        }>;
        executionId: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>>>;
    deliveryPolicy: z.ZodOptional<z.ZodLiteral<"automatic">>;
    completions: z.ZodOptional<z.ZodArray<z.ZodObject<{
        commit: z.ZodString;
        issueNumber: z.ZodNumber;
        commentId: z.ZodNumber;
        completionDigest: z.ZodString;
        outcome: z.ZodString;
        prNumber: z.ZodNullable<z.ZodNumber>;
        at: z.ZodString;
    }, z.core.$strict>>>;
    deliveries: z.ZodOptional<z.ZodArray<z.ZodObject<{
        commit: z.ZodString;
        prNumber: z.ZodNullable<z.ZodNumber>;
        issueNumber: z.ZodNumber;
        outcome: z.ZodString;
        state: z.ZodEnum<{
            complete: "complete";
            incomplete: "incomplete";
        }>;
        failedStage: z.ZodNullable<z.ZodEnum<{
            completion: "completion";
            publish: "publish";
            pull_request: "pull_request";
            read_back: "read_back";
        }>>;
        commentId: z.ZodNullable<z.ZodNumber>;
        detail: z.ZodNullable<z.ZodString>;
        at: z.ZodString;
    }, z.core.$strict>>>;
}, z.core.$strict>;
export interface MigrationPlanEntry {
    id: string;
    action: "import" | "already-imported";
    sha256: string;
    operations: string[];
}
/** Whether `id` is a legacy initiative that has not been imported (start and revise refuse it). */
export declare function legacyUnmigrated(ctx: CommandContext, config: ComforgeConfig, id: string): Promise<boolean>;
export declare function migrate(ctx: CommandContext, options: {
    execute: boolean;
    rollback?: boolean;
    waitSeconds?: number;
}): Promise<CommandResult>;
