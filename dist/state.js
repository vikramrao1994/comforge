import path from "node:path";
import { isLedgerError, LedgerError } from "@comforge/ledger";
import { createFileLedger } from "@comforge/ledger/file";
import { CliError, fail } from "./errors.js";
/**
 * Local state, outside every committed artifact: `<git common dir>/comforge/`. Each
 * initiative is one versioned record in the `initiatives` namespace of a @comforge/ledger
 * file ledger, so concurrent commands on one machine update it by compare-and-swap and a
 * crash leaves the last complete version. The GitHub write ledger lives beside it, in the
 * namespace the trusted configuration names. Nothing here is a credential.
 */
export const INITIATIVE_SCHEMA = "comforge-initiative/v1";
const INDEX_ID = "comforge-initiative-index";
export const stateDir = (commonDir) => path.join(commonDir, "comforge");
function wrap(run) {
    return run().catch((error) => {
        if (error instanceof CliError)
            throw error;
        if (isLedgerError(error))
            throw new CliError("ledger", `local state is unusable: ${error.message}`, {
                code: error.code,
                ...error.detail,
            });
        throw error;
    });
}
export function openState(commonDir) {
    const ledger = createFileLedger({
        directory: stateDir(commonDir),
        namespace: "initiatives",
        validate: (record) => {
            if (record.schema !== INITIATIVE_SCHEMA && record.schema !== "comforge-initiative-index/v1")
                throw new LedgerError("foreign", "not a comforge initiative record");
        },
    });
    const getInitiative = async (id) => {
        const record = await ledger.get(id);
        if (record && record.schema !== INITIATIVE_SCHEMA)
            fail("ledger", `${id} is not an initiative record`);
        return record;
    };
    const addToIndex = async (id) => {
        for (let attempt = 0; attempt < 16; attempt++) {
            const index = (await ledger.get(INDEX_ID));
            if (!index) {
                const created = {
                    schema: "comforge-initiative-index/v1",
                    operationId: INDEX_ID,
                    version: 1,
                    ids: [id],
                };
                if (await ledger.create(created))
                    return;
                continue;
            }
            if (index.ids.includes(id))
                return;
            const next = {
                ...index,
                version: index.version + 1,
                ids: [...index.ids, id].sort(),
            };
            if (await ledger.replace(INDEX_ID, index.version, next))
                return;
        }
        fail("ledger", "the initiative index is changing too fast; rerun");
    };
    return {
        get: (id) => wrap(() => getInitiative(id)),
        create: (fields, id) => wrap(async () => {
            const record = {
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
        update: (id, change) => wrap(async () => {
            for (let attempt = 0; attempt < 16; attempt++) {
                const current = await getInitiative(id);
                if (!current)
                    fail("not-found", `${id} has no local state; run comforge start`);
                const next = structuredClone(current);
                change(next);
                next.version = current.version + 1;
                next.operationId = id;
                next.schema = INITIATIVE_SCHEMA;
                if (await ledger.replace(id, current.version, next))
                    return next;
            }
            return fail("ledger", `${id} is changing too fast; rerun`);
        }),
        list: () => wrap(async () => {
            const index = (await ledger.get(INDEX_ID));
            const records = await Promise.all((index?.ids ?? []).map((id) => getInitiative(id)));
            return records.filter((r) => r !== null);
        }),
    };
}
export const nowIso = (now) => new Date(now).toISOString();
