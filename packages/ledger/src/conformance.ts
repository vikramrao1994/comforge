/**
 * The behaviour every `Ledger` adapter must show, as runner-agnostic cases: run each case's
 * `run()` from any test framework (or a plain script) against fresh, empty ledgers.
 *
 * These cases run in one process. Contention between independent processes, crashes and
 * filesystem faults need real processes and are adapter-specific; the package's own tests
 * cover them for the file and SQLite adapters.
 */
import { INITIAL_VERSION, type Ledger, LedgerError, type LedgerRecord } from "./contract.ts";

export interface ConformanceRecord extends LedgerRecord {
  readonly state: string;
  readonly payload: { readonly items: readonly number[]; readonly note: string | null };
}

export interface ConformanceCase {
  readonly name: string;
  run(): Promise<void>;
}

/** Opens a fresh, empty ledger in `namespace`; two calls with the same namespace share storage. */
export type OpenLedger = (
  namespace: string,
) => Ledger<ConformanceRecord> | Promise<Ledger<ConformanceRecord>>;

export class ConformanceFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConformanceFailure";
  }
}

const check = (ok: boolean, message: string) => {
  if (!ok) throw new ConformanceFailure(message);
};

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

async function refusal(promise: Promise<unknown>): Promise<LedgerError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof LedgerError) return error;
    throw new ConformanceFailure(`expected a LedgerError, got ${String(error)}`);
  }
  throw new ConformanceFailure("expected a LedgerError, got success");
}

export function record(
  operationId: string,
  version = INITIAL_VERSION,
  state = "reserved",
): ConformanceRecord {
  return { operationId, version, state, payload: { items: [version, 2, 3], note: `v${version}` } };
}

/**
 * The cases. `namespaces` must give each call a namespace that no other run uses, so cases
 * never share records (for example a counter or random suffix).
 */
export function ledgerConformance(
  open: OpenLedger,
  options: { namespaces?: () => [string, string] } = {},
): ConformanceCase[] {
  let n = 0;
  const pair =
    options.namespaces ??
    (() => {
      n += 1;
      return [`conformance-a${n}`, `conformance-b${n}`] as [string, string];
    });
  const fresh = async () => open(pair()[0]);
  const cases: ConformanceCase[] = [
    {
      name: "get of an unknown operation is null",
      async run() {
        check((await (await fresh()).get("unknown")) === null, "expected null");
      },
    },
    {
      name: "create stores the record; get returns an equal copy",
      async run() {
        const ledger = await fresh();
        const r = record("op");
        check((await ledger.create(r)) === true, "create should succeed");
        const got = await ledger.get("op");
        check(same(got, r), "get should return the stored record");
        check(got !== r, "get should return a copy");
      },
    },
    {
      name: "the store is isolated from the caller's objects",
      async run() {
        const ledger = await fresh();
        const r = { ...record("op"), payload: { items: [1], note: "a" } };
        await ledger.create(r);
        (r.payload.items as number[]).push(9);
        const got = (await ledger.get("op")) as ConformanceRecord;
        (got.payload.items as number[]).push(8);
        check(same((await ledger.get("op"))?.payload.items, [1]), "mutation leaked into the store");
      },
    },
    {
      name: "create is exclusive: a second create returns false and changes nothing",
      async run() {
        const ledger = await fresh();
        await ledger.create(record("op", 1, "first"));
        check(
          (await ledger.create(record("op", 1, "second"))) === false,
          "second create should be false",
        );
        check((await ledger.get("op"))?.state === "first", "the first record should stay");
      },
    },
    {
      name: "create refuses a first record that is not version 1",
      async run() {
        const ledger = await fresh();
        check(
          (await refusal(ledger.create(record("op", 2)))).code === "invalid-record",
          "expected invalid-record",
        );
        check((await ledger.get("op")) === null, "nothing should be stored");
      },
    },
    {
      name: "create and get refuse an empty operation id",
      async run() {
        const ledger = await fresh();
        check(
          (await refusal(ledger.create(record("")))).code === "invalid-record",
          "create: expected invalid-record",
        );
        check(
          (await refusal(ledger.get(""))).code === "invalid-record",
          "get: expected invalid-record",
        );
      },
    },
    {
      name: "replace stores the next version when the current version is expected",
      async run() {
        const ledger = await fresh();
        await ledger.create(record("op"));
        check(
          (await ledger.replace("op", 1, record("op", 2, "sending"))) === true,
          "replace should succeed",
        );
        const got = await ledger.get("op");
        check(got?.version === 2 && got.state === "sending", "get should return version 2");
      },
    },
    {
      name: "replace from a stale version returns false and changes nothing",
      async run() {
        const ledger = await fresh();
        await ledger.create(record("op"));
        await ledger.replace("op", 1, record("op", 2, "b"));
        check(
          (await ledger.replace("op", 1, record("op", 2, "c"))) === false,
          "stale replace should be false",
        );
        check((await ledger.get("op"))?.state === "b", "the newer record should stay");
      },
    },
    {
      name: "replace of an unknown operation returns false",
      async run() {
        check(
          (await (await fresh()).replace("missing", 1, record("missing", 2))) === false,
          "expected false",
        );
      },
    },
    {
      name: "replace refuses a skipped version or another operation's record",
      async run() {
        const ledger = await fresh();
        await ledger.create(record("op"));
        check(
          (await refusal(ledger.replace("op", 1, record("op", 3)))).code === "invalid-record",
          "skip: expected invalid-record",
        );
        check(
          (await refusal(ledger.replace("op", 1, record("other", 2)))).code === "invalid-record",
          "identity: expected invalid-record",
        );
        check((await ledger.get("op"))?.version === 1, "nothing should change");
      },
    },
    {
      name: "of concurrent creates of one operation exactly one succeeds",
      async run() {
        const ledger = await fresh();
        const results = await Promise.all(
          Array.from({ length: 16 }, (_, i) => ledger.create(record("op", 1, `w${i}`))),
        );
        check(
          results.filter(Boolean).length === 1,
          `expected one winner, got ${results.filter(Boolean).length}`,
        );
        const winner = results.indexOf(true);
        check(
          (await ledger.get("op"))?.state === `w${winner}`,
          "the winner's record should be stored",
        );
      },
    },
    {
      name: "of concurrent replaces from one version exactly one succeeds",
      async run() {
        const ledger = await fresh();
        await ledger.create(record("op"));
        const results = await Promise.all(
          Array.from({ length: 16 }, (_, i) => ledger.replace("op", 1, record("op", 2, `w${i}`))),
        );
        check(
          results.filter(Boolean).length === 1,
          `expected one winner, got ${results.filter(Boolean).length}`,
        );
      },
    },
    {
      name: "a long chain of versions stays readable and ordered",
      async run() {
        const ledger = await fresh();
        await ledger.create(record("op"));
        for (let v = 1; v < 40; v++)
          check(await ledger.replace("op", v, record("op", v + 1)), `replace ${v}`);
        check((await ledger.get("op"))?.version === 40, "expected version 40");
      },
    },
    {
      name: "another namespace never reads or changes this namespace's records",
      async run() {
        const [a, b] = pair();
        const la = await open(a);
        const lb = await open(b);
        await la.create(record("shared-id", 1, "a"));
        const read = await lb.get("shared-id").catch((e: unknown) => e);
        check(
          read === null || (read instanceof LedgerError && read.code === "foreign"),
          "b must not read a's record",
        );
        await lb.create(record("shared-id", 1, "b")).catch(() => false);
        await lb.replace("shared-id", 1, record("shared-id", 2, "b")).catch(() => false);
        const kept = await la.get("shared-id");
        check(kept?.state === "a" && kept.version === 1, "a's record must be unchanged");
      },
    },
  ];
  return cases;
}
