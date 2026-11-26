import path from "node:path";
import { isLedgerError, LedgerError } from "@comforge/ledger";
import { createFileLedger, type FileLedger } from "@comforge/ledger/file";
import { CliError, fail } from "./errors.ts";

/**
 * Local state, outside every committed artifact: `<git common dir>/comforge/`. Each
 * initiative is one versioned record in the `initiatives` namespace of a @comforge/ledger
 * file ledger, so concurrent commands on one machine update it by compare-and-swap and a
 * crash leaves the last complete version. The GitHub write ledger lives beside it, in the
 * namespace the trusted configuration names. Nothing here is a credential.
 */

export const INITIATIVE_SCHEMA = "comforge-initiative/v1";
const INDEX_ID = "comforge-initiative-index";

export interface Validation {
  commit: string;
  tree: string;
  status: "PASS" | "FAIL";
  at: string;
  commands: { name: string; exitStatus: number | null; timedOut: boolean; durationMs: number }[];
}
export interface Publication {
  commit: string;
  prNumber: number;
  url: string;
  at: string;
}
export interface Completion {
  commit: string;
  issueNumber: number;
  commentId: number;
  completionDigest: string;
  outcome: string;
  prNumber: number | null;
  at: string;
}

export interface InitiativeRecord {
  schema: typeof INITIATIVE_SCHEMA;
  operationId: string;
  version: number;
  ticket: string;
  phase: string | null;
  branch: string;
  checkout: string;
  primary: string;
  base: { remote: string; branch: string; sha: string };
  /** SHA-256 of the trusted configuration sections at `base.sha`. */
  trustedConfig: string;
  specification: { issueNumber: number; digest: string } | null;
  validations: Validation[];
  revisions: { prNumber: number; reviewedHead: string; at: string }[];
  publications: Publication[];
  completions: Completion[];
  /** Ids of GitHub write operations made for this initiative (see `recover`). */
  operations: string[];
  /** Owner grants this initiative used: an attempt each, at most the grant's maxAttempts. */
  grantUses?: {
    grantId: string;
    envelopeDigest: string;
    head: string;
    command: string;
    at: string;
  }[];
  cleanedAt: string | null;
}

interface IndexRecord {
  schema: "comforge-initiative-index/v1";
  operationId: typeof INDEX_ID;
  version: number;
  ids: string[];
}

type StoredRecord = InitiativeRecord | IndexRecord;

export const stateDir = (commonDir: string) => path.join(commonDir, "comforge");

function wrap<T>(run: () => Promise<T>): Promise<T> {
  return run().catch((error: unknown) => {
    if (error instanceof CliError) throw error;
    if (isLedgerError(error))
      throw new CliError("ledger", `local state is unusable: ${error.message}`, {
        code: (error as LedgerError).code,
        ...(error as LedgerError).detail,
      });
    throw error;
  });
}

export interface StateStore {
  get(id: string): Promise<InitiativeRecord | null>;
  create(
    record: Omit<InitiativeRecord, "version" | "schema" | "operationId">,
    id: string,
  ): Promise<InitiativeRecord>;
  /** Applies `change` by compare-and-swap, retrying on a concurrent update. */
  update(id: string, change: (record: InitiativeRecord) => void): Promise<InitiativeRecord>;
  list(): Promise<InitiativeRecord[]>;
}

export function openState(commonDir: string): StateStore {
  const ledger: FileLedger<StoredRecord> = createFileLedger<StoredRecord>({
    directory: stateDir(commonDir),
    namespace: "initiatives",
    validate: (record) => {
      if (record.schema !== INITIATIVE_SCHEMA && record.schema !== "comforge-initiative-index/v1")
        throw new LedgerError("foreign", "not a comforge initiative record");
    },
  });
  const getInitiative = async (id: string): Promise<InitiativeRecord | null> => {
    const record = await ledger.get(id);
    if (record && record.schema !== INITIATIVE_SCHEMA)
      fail("ledger", `${id} is not an initiative record`);
    return record as InitiativeRecord | null;
  };
  const addToIndex = async (id: string) => {
    for (let attempt = 0; attempt < 16; attempt++) {
      const index = (await ledger.get(INDEX_ID)) as IndexRecord | null;
      if (!index) {
        const created: IndexRecord = {
          schema: "comforge-initiative-index/v1",
          operationId: INDEX_ID,
          version: 1,
          ids: [id],
        };
        if (await ledger.create(created)) return;
        continue;
      }
      if (index.ids.includes(id)) return;
      const next: IndexRecord = {
        ...index,
        version: index.version + 1,
        ids: [...index.ids, id].sort(),
      };
      if (await ledger.replace(INDEX_ID, index.version, next)) return;
    }
    fail("ledger", "the initiative index is changing too fast; rerun");
  };
  return {
    get: (id) => wrap(() => getInitiative(id)),
    create: (fields, id) =>
      wrap(async () => {
        const record: InitiativeRecord = {
          ...fields,
          schema: INITIATIVE_SCHEMA,
          operationId: id,
          version: 1,
        };
        if (!(await ledger.create(record)))
          fail("conflict", `${id} already has local state`, { initiative: id });
        await addToIndex(id);
        return record;
      }),
    update: (id, change) =>
      wrap(async () => {
        for (let attempt = 0; attempt < 16; attempt++) {
          const current = await getInitiative(id);
          if (!current) fail("not-found", `${id} has no local state; run comforge start`);
          const next = structuredClone(current as InitiativeRecord);
          change(next);
          next.version = (current as InitiativeRecord).version + 1;
          next.operationId = id;
          next.schema = INITIATIVE_SCHEMA;
          if (await ledger.replace(id, (current as InitiativeRecord).version, next)) return next;
        }
        return fail("ledger", `${id} is changing too fast; rerun`);
      }),
    list: () =>
      wrap(async () => {
        const index = (await ledger.get(INDEX_ID)) as IndexRecord | null;
        const records = await Promise.all((index?.ids ?? []).map((id) => getInitiative(id)));
        return records.filter((r): r is InitiativeRecord => r !== null);
      }),
  };
}

export const nowIso = (now: number) => new Date(now).toISOString();
