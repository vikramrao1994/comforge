import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { record } from "../src/conformance.ts";
import { LedgerError } from "../src/contract.ts";
import { createFileLedger, type FileLedgerOptions } from "../src/file.ts";

// The file adapter's faults and boundaries: unsafe paths, corruption, failed flushes and
// links, orphaned temp files, stalled writers and history compaction.

type R = ReturnType<typeof record>;
let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(tmpdir(), "ledger-file-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const open = (extra: Partial<FileLedgerOptions<R>> = {}) =>
  createFileLedger<R>({ directory: dir, namespace: "ns", ...extra });
const opDir = (id: string) => path.join(dir, "ns", createHash("sha256").update(id).digest("hex"));
const files = (id: string) => fs.readdirSync(opDir(id)).sort();

async function refusal(p: Promise<unknown>): Promise<LedgerError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof LedgerError) return e;
    throw e;
  }
  throw new Error("expected a LedgerError");
}

describe("layout and compatibility", () => {
  test("records are <directory>/<namespace>/<sha256(id)>/<version>.json, one JSON line each", async () => {
    const ledger = open();
    await ledger.create(record("op"));
    await ledger.replace("op", 1, record("op", 2));
    expect(files("op")).toEqual(["1.json", "2.json"]);
    expect(fs.readFileSync(path.join(opDir("op"), "2.json"), "utf8")).toBe(
      `${JSON.stringify(record("op", 2))}\n`,
    );
    expect(fs.statSync(path.join(dir, "ns")).mode & 0o777).toBe(0o700);
    expect(fs.statSync(opDir("op")).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(opDir("op"), "1.json")).mode & 0o777).toBe(0o600);
  });

  test("a namespace is a plain name, never a path", () => {
    for (const ns of ["", "..", "../x", "a/b", "A", ".hidden", "x".repeat(65)])
      expect(() => createFileLedger({ directory: dir, namespace: ns })).toThrow(LedgerError);
  });
});

describe("unsafe paths are refused before anything is read or written", () => {
  test("a symbolic link as the directory, the namespace, an operation or a version", async () => {
    const real = fs.mkdtempSync(path.join(tmpdir(), "ledger-real-"));
    try {
      const link = path.join(dir, "link");
      fs.symlinkSync(real, link);
      expect(
        (
          await refusal(
            createFileLedger<R>({ directory: link, namespace: "ns" }).create(record("op")),
          )
        ).code,
      ).toBe("unsafe-path");

      fs.mkdirSync(path.join(real, "ns"), { mode: 0o700 });
      fs.symlinkSync(path.join(real, "ns"), path.join(dir, "ns"));
      expect((await refusal(open().get("op"))).code).toBe("unsafe-path");
      fs.unlinkSync(path.join(dir, "ns"));

      const ledger = open();
      await ledger.create(record("a"));
      fs.mkdirSync(path.join(real, "b"), { mode: 0o700 });
      fs.symlinkSync(path.join(real, "b"), opDir("b"));
      expect((await refusal(ledger.create(record("b")))).code).toBe("unsafe-path");

      fs.writeFileSync(path.join(real, "x.json"), JSON.stringify(record("a", 2)));
      fs.symlinkSync(path.join(real, "x.json"), path.join(opDir("a"), "2.json"));
      expect((await refusal(ledger.get("a"))).code).toBe("unsafe-path");
    } finally {
      fs.rmSync(real, { recursive: true, force: true });
    }
  });

  test("a namespace open to other users, or a directory writable by them", async () => {
    await open().create(record("op"));
    fs.chmodSync(path.join(dir, "ns"), 0o750);
    expect((await refusal(open().get("op"))).code).toBe("unsafe-path");
    fs.chmodSync(path.join(dir, "ns"), 0o700);
    fs.chmodSync(opDir("op"), 0o704);
    expect((await refusal(open().get("op"))).code).toBe("unsafe-path");
    fs.chmodSync(opDir("op"), 0o700);
    fs.chmodSync(dir, 0o777);
    expect((await refusal(open().get("op"))).code).toBe("unsafe-path");
    fs.chmodSync(dir, 0o755);
    expect((await open().get("op"))?.version).toBe(1);
  });

  test("a regular file where a directory belongs", async () => {
    fs.writeFileSync(path.join(dir, "ns"), "x");
    expect((await refusal(open().create(record("op")))).code).toBe("unsafe-path");
  });
});

describe("corruption fails closed", () => {
  test("a truncated or unparseable current version is corrupt, never skipped to an older one", async () => {
    const ledger = open();
    await ledger.create(record("op"));
    fs.writeFileSync(path.join(opDir("op"), "2.json"), '{"operationId":"op","vers');
    expect((await refusal(ledger.get("op"))).code).toBe("corrupt");
    expect(await ledger.replace("op", 1, record("op", 2))).toBe(false);
  });

  test("a version that names another operation or version is corrupt", async () => {
    const ledger = open();
    await ledger.create(record("op"));
    fs.writeFileSync(path.join(opDir("op"), "2.json"), JSON.stringify(record("other", 2)));
    expect((await refusal(ledger.get("op"))).code).toBe("corrupt");
    fs.writeFileSync(path.join(opDir("op"), "2.json"), JSON.stringify(record("op", 3)));
    expect((await refusal(ledger.get("op"))).code).toBe("corrupt");
  });

  test("the caller's validator refuses what it does not accept, on write and on read", async () => {
    const strict = open({
      validate: (r) => {
        if (r.state === "bad") throw new Error("bad state");
      },
    });
    expect((await refusal(strict.create(record("op", 1, "bad")))).code).toBe("invalid-record");
    await open().create(record("op", 1, "bad"));
    expect((await refusal(strict.get("op"))).code).toBe("corrupt");
  });

  test("names that are not versions are ignored (no leading zeros, no temp files)", async () => {
    const ledger = open();
    await ledger.create(record("op"));
    fs.writeFileSync(path.join(opDir("op"), "02.json"), "garbage");
    fs.writeFileSync(path.join(opDir("op"), "notes.txt"), "garbage");
    expect((await ledger.get("op"))?.version).toBe(1);
  });
});

describe("faults while writing publish nothing", () => {
  test("a failed fsync of the version: io, no version, no temp file", async () => {
    const temps = new Set<number>();
    const ledger = open({
      fs: {
        openSync: ((file: fs.PathLike, flags?: fs.OpenMode, mode?: fs.Mode) => {
          const fd = fs.openSync(file, flags ?? "r", mode);
          if (String(file).endsWith(".tmp")) temps.add(fd);
          return fd;
        }) as typeof fs.openSync,
        fsyncSync: (fd: number) => {
          if (temps.has(fd)) throw Object.assign(new Error("EIO"), { code: "EIO" });
          return fs.fsyncSync(fd);
        },
      },
    });
    expect((await refusal(ledger.create(record("op")))).code).toBe("io");
    expect(files("op")).toEqual([]);
    expect(await open().get("op")).toBeNull();
  });

  test("a failed write (disk full): io, no version, no temp file", async () => {
    const ledger = open({
      fs: {
        writeSync: () => {
          throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" });
        },
      },
    });
    expect((await refusal(ledger.create(record("op")))).code).toBe("io");
    expect(files("op")).toEqual([]);
  });

  test("a filesystem without hard links: unsupported, nothing recorded", async () => {
    const ledger = open({
      fs: {
        linkSync: () => {
          throw Object.assign(new Error("EPERM"), { code: "EPERM" });
        },
      },
    });
    expect((await refusal(ledger.create(record("op")))).code).toBe("unsupported");
    expect((await refusal(ledger.probe())).code).toBe("unsupported");
    expect(files("op")).toEqual([]);
  });

  test("a failed flush of the directory after the link: io marked published; the version exists", async () => {
    let calls = 0;
    const ledger = open({
      fs: {
        fsyncSync: (fd: number) => {
          // The first fsync is the temp file's; the later ones are directories'.
          calls += 1;
          if (calls >= 4) throw Object.assign(new Error("EIO"), { code: "EIO" });
          return fs.fsyncSync(fd);
        },
      },
    });
    const error = await refusal(ledger.create(record("op")));
    expect(error.code).toBe("io");
    expect(error.detail.published).toBe(true);
    expect((await open().get("op"))?.version).toBe(1);
    expect(await open().create(record("op"))).toBe(false);
  });

  test("a temp file removed before its link (a sweep racing a stalled writer): io, nothing published", async () => {
    const ledger = open({
      fs: {
        linkSync: (from: fs.PathLike, to: fs.PathLike) => {
          fs.unlinkSync(from);
          return fs.linkSync(from, to);
        },
      },
    });
    expect((await refusal(ledger.create(record("op")))).code).toBe("io");
    expect(await open().get("op")).toBeNull();
  });
});

describe("orphaned temp files", () => {
  const orphan = (id: string, pid: number, ageMs: number) => {
    const file = path.join(opDir(id), `.${pid}.${"a".repeat(12)}.tmp`);
    fs.writeFileSync(file, "partial");
    const t = (Date.now() - ageMs) / 1000;
    fs.utimesSync(file, t, t);
    return file;
  };

  test("only old temp files of processes that no longer run are removed", async () => {
    const ledger = open();
    await ledger.create(record("op"));
    const dead = orphan("op", 2_147_483_646, 3_600_000);
    const live = orphan("op", process.pid, 3_600_000);
    const young = path.join(opDir("op"), `.2147483645.${"b".repeat(12)}.tmp`);
    fs.writeFileSync(young, "partial");
    expect((await ledger.inspect()).orphanTempFiles).toBe(3);
    expect(await ledger.sweepOrphans({ olderThanMs: 60_000 })).toEqual({ removed: 1, kept: 2 });
    expect(fs.existsSync(dead)).toBe(false);
    expect(fs.existsSync(live)).toBe(true);
    expect(fs.existsSync(young)).toBe(true);
    expect((await ledger.get("op"))?.version).toBe(1);
  });
});

describe("stalled writers and compaction", () => {
  test("a writer that stalled at an old version can never publish, even after compaction", async () => {
    const ledger = open();
    await ledger.create(record("op"));
    const stalledSaw = (await ledger.get("op"))?.version as number;
    await ledger.replace("op", 1, record("op", 2, "b"));
    await ledger.replace("op", 2, record("op", 3, "c"));
    expect(await ledger.compactHistory("op")).toBe(2);
    expect(await ledger.compactHistory("op")).toBe(0);
    expect(await ledger.replace("op", stalledSaw, record("op", stalledSaw + 1, "stale"))).toBe(
      false,
    );
    expect(await ledger.get("op")).toEqual(record("op", 3, "c"));
    expect(files("op")).toEqual(["1.json", "2.json", "3.json"]);
    const stub = JSON.parse(fs.readFileSync(path.join(opDir("op"), "1.json"), "utf8"));
    expect(stub).toEqual({ ledger: "comforge-ledger/superseded", operationId: "op", version: 1 });
    expect(JSON.stringify(stub)).not.toContain("payload");
  });

  test("compaction interrupted at its rename leaves the version as it was, and no temp file", async () => {
    const ledger = open();
    await ledger.create(record("op"));
    await ledger.replace("op", 1, record("op", 2));
    const failing = open({
      fs: {
        renameSync: () => {
          throw Object.assign(new Error("EIO"), { code: "EIO" });
        },
      },
    });
    expect((await refusal(failing.compactHistory("op"))).code).toBe("io");
    expect(JSON.parse(fs.readFileSync(path.join(opDir("op"), "1.json"), "utf8"))).toEqual(
      record("op"),
    );
    expect(files("op")).toEqual(["1.json", "2.json"]);
    expect(await open().compactHistory("op")).toBe(1);
  });

  test("compaction leaves an unreadable superseded version alone, and two compactors agree", async () => {
    const ledger = open();
    await ledger.create(record("op"));
    for (let v = 1; v < 5; v++) await ledger.replace("op", v, record("op", v + 1));
    fs.writeFileSync(path.join(opDir("op"), "2.json"), "{");
    const counts = await Promise.all([open().compactHistory("op"), open().compactHistory("op")]);
    expect(counts.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(3);
    expect(fs.readFileSync(path.join(opDir("op"), "2.json"), "utf8")).toBe("{");
    for (const v of [1, 3, 4])
      expect(JSON.parse(fs.readFileSync(path.join(opDir("op"), `${v}.json`), "utf8")).ledger).toBe(
        "comforge-ledger/superseded",
      );
    expect(await ledger.get("op")).toEqual(record("op", 5));
  });

  test("inspection is read-only and names unreadable operations by directory only", async () => {
    const ledger = open();
    await ledger.create(record("a", 1, "succeeded"));
    await ledger.create(record("b", 1, "reserved"));
    await ledger.create(record("c"));
    fs.writeFileSync(path.join(opDir("c"), "2.json"), "{");
    fs.mkdirSync(opDir("d"), { mode: 0o700 });
    const before = fs.readdirSync(path.join(dir, "ns")).sort();
    const report = await ledger.inspect({ classify: (r) => r.state });
    expect(report).toMatchObject({
      operations: 4,
      classes: { succeeded: 1, reserved: 1 },
      empty: 1,
      orphanTempFiles: 0,
    });
    expect(report.unreadable).toEqual([
      { directory: path.basename(opDir("c")), code: "corrupt", message: expect.any(String) },
    ]);
    expect(fs.readdirSync(path.join(dir, "ns")).sort()).toEqual(before);
  });

  test("probe passes on this filesystem", async () => {
    expect(await open().probe()).toEqual({ directorySync: expect.any(Boolean) });
  });
});
