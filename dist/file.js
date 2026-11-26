/**
 * A ledger as immutable files: each operation is a directory and each version of its record a
 * file `<version>.json`. The record is the highest version present.
 *
 * - **Atomic and exclusive.** A version is written in full to a private temp file, flushed
 *   (`fsync`), then hard-linked into place. `link` fails when the name exists, so a reader never
 *   sees a partial record and of any number of writers, in any number of processes, only one
 *   creates a given version.
 * - **Compare-and-swap without locks.** `create` is the exclusive creation of version 1;
 *   `replace(id, n, next)` the exclusive creation of version n + 1, attempted only while n is
 *   the highest. A writer that read an older version, or stalled for any time, can only fail
 *   to create a version that already exists. Nothing is held that another writer must wait for
 *   or take over, so there is no timed lock takeover.
 * - **Versions are never deleted.** Deleting version n + 1 would let a writer that stalled after
 *   seeing n "win" a version nobody reads. `compactHistory` therefore rewrites superseded
 *   versions in place (their names stay), and no operation is ever removed: an identity, once
 *   used, is never reopened.
 * - **Durability.** The version file and its directory are `fsync`ed, which makes a completed
 *   write survive a process crash. Across power loss it is only as durable as the platform's
 *   `fsync` (macOS does not flush the drive cache without `F_FULLFSYNC`): the last version can be
 *   lost, and the caller then sees the version before it.
 * - **Private.** The namespace and operation directories are created 0700 and refused when they
 *   are symbolic links, not directories, owned by another user or open to other users. Version
 *   files are opened without following links. An operation id never becomes a path: its
 *   directory is the id's SHA-256.
 *
 * Needs a local POSIX filesystem with hard links (APFS, ext4, xfs, btrfs, tmpfs). Refused:
 * Windows (`unsupported`), filesystems without hard links (`unsupported`, from `probe()` or the
 * first write). Not supported, even when `probe()` passes: network filesystems and directories
 * shared by several machines. Call `probe()` when configuring a directory.
 */
import { Buffer } from "node:buffer";
import { createHash, randomBytes } from "node:crypto";
import * as nodeFs from "node:fs";
import path from "node:path";
import { assertOperationId, assertReplacement, assertStorable, assertStored, decodeRecord, encodeRecord, INITIAL_VERSION, LedgerError, } from "./contract.js";
const NAMESPACE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const VERSION_FILE = /^([1-9][0-9]{0,15})\.json$/;
const TEMP_FILE = /^\.([0-9]{1,10})\.[0-9a-f]{12}\.tmp$/;
const SUPERSEDED = "comforge-ledger/superseded";
const DEFAULT_ORPHAN_AGE_MS = 15 * 60_000;
/** A `fsync` of a directory that the platform does not support; the link itself is atomic. */
const DIRECTORY_SYNC_UNSUPPORTED = new Set(["EINVAL", "ENOTSUP", "EISDIR", "EBADF"]);
const LINK_UNSUPPORTED = new Set(["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EXDEV", "EMLINK"]);
const errno = (error) => error?.code;
function io(message, cause, detail = {}) {
    return cause instanceof LedgerError
        ? cause
        : new LedgerError("io", `${message}: ${errno(cause) ?? String(cause)}`, detail, { cause });
}
export function createFileLedger(options) {
    if (process.platform === "win32")
        throw new LedgerError("unsupported", "the file ledger is not supported on Windows");
    if (typeof options.namespace !== "string" || !NAMESPACE.test(options.namespace))
        throw new LedgerError("invalid-record", "a namespace matches [a-z0-9][a-z0-9._-]{0,63}");
    if (typeof options.directory !== "string" || options.directory.length === 0)
        throw new LedgerError("invalid-record", "the ledger needs a directory");
    const fs = { ...nodeFs, ...options.fs };
    const root = path.resolve(options.directory);
    const space = path.join(root, options.namespace);
    const clock = options.clock ?? Date.now;
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    const validate = options.validate;
    /** `missing`, or a safe directory; anything else is refused. */
    const checkDirectory = (dir, ownerOnly) => {
        let st;
        try {
            st = fs.lstatSync(dir);
        }
        catch (error) {
            if (errno(error) === "ENOENT")
                return "missing";
            throw io("cannot inspect a ledger directory", error, { path: dir });
        }
        const unsafe = (why) => new LedgerError("unsafe-path", `the ledger directory ${why}`, { path: dir });
        if (st.isSymbolicLink())
            throw unsafe("is a symbolic link");
        if (!st.isDirectory())
            throw unsafe("is not a directory");
        if (uid !== undefined && st.uid !== uid)
            throw unsafe("is owned by another user");
        if (st.mode & (ownerOnly ? 0o077 : 0o022))
            throw unsafe(ownerOnly ? "is open to other users" : "is writable by other users");
        return "ok";
    };
    const makeDirectory = (dir, recursive) => {
        try {
            fs.mkdirSync(dir, { recursive, mode: 0o700 });
            return true;
        }
        catch (error) {
            if (errno(error) === "EEXIST")
                return false;
            throw io("cannot create a ledger directory", error, { path: dir });
        }
    };
    const syncDirectory = (dir) => {
        let fd;
        try {
            fd = fs.openSync(dir, nodeFs.constants.O_RDONLY);
        }
        catch (error) {
            if (DIRECTORY_SYNC_UNSUPPORTED.has(errno(error) ?? ""))
                return false;
            throw io("cannot open a ledger directory to flush it", error, { path: dir });
        }
        try {
            fs.fsyncSync(fd);
            return true;
        }
        catch (error) {
            if (DIRECTORY_SYNC_UNSUPPORTED.has(errno(error) ?? ""))
                return false;
            throw io("flushing a ledger directory failed", error, { path: dir });
        }
        finally {
            fs.closeSync(fd);
        }
    };
    /** The namespace directory, created on first use; `null` when `create` is false and it is missing. */
    const namespaceDir = (create) => {
        if (checkDirectory(root, false) === "missing") {
            if (!create)
                return null;
            makeDirectory(root, true);
            checkDirectory(root, false);
        }
        if (checkDirectory(space, true) === "missing") {
            if (!create)
                return null;
            if (makeDirectory(space, false))
                syncDirectory(root);
            checkDirectory(space, true);
        }
        return space;
    };
    const operationDir = (operationId, create) => {
        assertOperationId(operationId);
        const ns = namespaceDir(create);
        if (ns === null)
            return null;
        const dir = path.join(ns, createHash("sha256").update(operationId).digest("hex"));
        if (checkDirectory(dir, true) === "missing") {
            if (!create)
                return null;
            if (makeDirectory(dir, false))
                syncDirectory(ns);
            checkDirectory(dir, true);
        }
        return dir;
    };
    const versionsOf = (dir) => {
        let names;
        try {
            names = fs.readdirSync(dir);
        }
        catch (error) {
            if (errno(error) === "ENOENT")
                return [];
            throw io("cannot list a ledger operation", error);
        }
        return names
            .map((name) => VERSION_FILE.exec(name)?.[1])
            .filter((v) => v !== undefined)
            .map(Number)
            .sort((a, b) => a - b);
    };
    const readFile = (file) => {
        let fd;
        try {
            fd = fs.openSync(file, nodeFs.constants.O_RDONLY | nodeFs.constants.O_NOFOLLOW);
        }
        catch (error) {
            if (errno(error) === "ELOOP")
                throw new LedgerError("unsafe-path", "a ledger version is a symbolic link", { path: file });
            throw io("cannot open a ledger version", error, { path: file });
        }
        try {
            return fs.readFileSync(fd, "utf8");
        }
        catch (error) {
            throw io("cannot read a ledger version", error, { path: file });
        }
        finally {
            fs.closeSync(fd);
        }
    };
    const isSuperseded = (value) => value?.ledger === SUPERSEDED;
    const current = (dir, operationId) => {
        // A version read while compaction rewrote it (it was superseded after it was listed) is
        // looked up again; the current version is never rewritten.
        for (let attempt = 0; attempt < 8; attempt++) {
            const latest = versionsOf(dir).at(-1);
            if (latest === undefined)
                return null;
            const value = decodeRecord(readFile(path.join(dir, `${latest}.json`)), operationId);
            if (isSuperseded(value))
                continue;
            return assertStored(value, operationId, latest, validate);
        }
        throw new LedgerError("io", "the ledger kept changing while it was read", { operationId });
    };
    const writeAll = (fd, text) => {
        const bytes = Buffer.from(text, "utf8");
        for (let offset = 0; offset < bytes.length;)
            offset += fs.writeSync(fd, bytes, offset, bytes.length - offset);
    };
    /** Writes `text` to a new, flushed temp file in `dir`; the caller links or renames it. */
    const stage = (dir, text) => {
        const temp = path.join(dir, `.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
        let fd;
        try {
            fd = fs.openSync(temp, "wx", 0o600);
        }
        catch (error) {
            throw io("cannot create a ledger temp file", error, { path: temp });
        }
        try {
            writeAll(fd, text);
            fs.fsyncSync(fd);
        }
        catch (error) {
            try {
                fs.closeSync(fd);
            }
            catch {
                // The write already failed; that is the error reported.
            }
            removeQuietly(temp);
            throw io("writing a ledger version failed; nothing was recorded", error);
        }
        fs.closeSync(fd);
        return temp;
    };
    const removeQuietly = (file) => {
        try {
            fs.unlinkSync(file);
        }
        catch {
            // Already gone, or left as an orphan for sweepOrphans; never a published version.
        }
    };
    /** Creates `<version>.json` exclusively; `false` when that version already exists. */
    const createVersion = (dir, record) => {
        const temp = stage(dir, `${encodeRecord(record)}\n`);
        let linked = false;
        try {
            fs.linkSync(temp, path.join(dir, `${record.version}.json`));
            linked = true;
        }
        catch (error) {
            const code = errno(error) ?? "";
            if (code !== "EEXIST")
                throw LINK_UNSUPPORTED.has(code)
                    ? new LedgerError("unsupported", `the filesystem refused a hard link (${code})`, {
                        path: dir,
                    })
                    : io("publishing a ledger version failed; nothing was recorded", error);
        }
        finally {
            removeQuietly(temp);
        }
        if (!linked)
            return false;
        try {
            syncDirectory(dir);
        }
        catch (error) {
            throw new LedgerError("io", "the version was published but flushing it failed; it may not survive power loss", { operationId: record.operationId, version: record.version, published: true }, { cause: error });
        }
        return true;
    };
    const listOperations = () => {
        const ns = namespaceDir(false);
        if (ns === null)
            return [];
        try {
            return fs
                .readdirSync(ns)
                .filter((name) => /^[0-9a-f]{64}$/.test(name))
                .map((name) => path.join(ns, name));
        }
        catch (error) {
            throw io("cannot list the ledger", error);
        }
    };
    const alive = (pid) => {
        if (pid === process.pid)
            return true;
        try {
            process.kill(pid, 0);
            return true;
        }
        catch (error) {
            return errno(error) === "EPERM";
        }
    };
    return {
        async get(operationId) {
            const dir = operationDir(operationId, false);
            return dir === null ? null : current(dir, operationId);
        },
        async create(record) {
            assertStorable(record, validate);
            if (record.version !== INITIAL_VERSION)
                throw new LedgerError("invalid-record", `a first record is version ${INITIAL_VERSION}`, {
                    operationId: record.operationId,
                });
            const dir = operationDir(record.operationId, true);
            if (versionsOf(dir).length > 0)
                return false;
            return createVersion(dir, record);
        },
        async replace(operationId, expectedVersion, next) {
            assertReplacement(operationId, expectedVersion, next, validate);
            const dir = operationDir(operationId, false);
            if (dir === null)
                return false;
            if (versionsOf(dir).at(-1) !== expectedVersion)
                return false;
            return createVersion(dir, next);
        },
        async inspect({ classify } = {}) {
            const out = {
                operations: 0,
                classes: {},
                empty: 0,
                unreadable: [],
                orphanTempFiles: 0,
            };
            for (const dir of listOperations()) {
                out.operations += 1;
                try {
                    checkDirectory(dir, true);
                    out.orphanTempFiles += fs.readdirSync(dir).filter((n) => TEMP_FILE.test(n)).length;
                    const latest = versionsOf(dir).at(-1);
                    if (latest === undefined) {
                        out.empty += 1;
                        continue;
                    }
                    const value = decodeRecord(readFile(path.join(dir, `${latest}.json`)), "");
                    const operationId = value?.operationId;
                    if (typeof operationId !== "string" ||
                        path.basename(dir) !== createHash("sha256").update(operationId).digest("hex"))
                        throw new LedgerError("corrupt", "the stored record is not this directory's operation");
                    const record = assertStored(value, operationId, latest, validate);
                    const name = classify ? classify(record) : "record";
                    out.classes[name] = (out.classes[name] ?? 0) + 1;
                }
                catch (error) {
                    const e = error instanceof LedgerError ? error : io("cannot read", error);
                    out.unreadable.push({ directory: path.basename(dir), code: e.code, message: e.message });
                }
            }
            return out;
        },
        async sweepOrphans({ olderThanMs = DEFAULT_ORPHAN_AGE_MS } = {}) {
            const cutoff = clock() - olderThanMs;
            let removed = 0;
            let kept = 0;
            for (const dir of listOperations()) {
                checkDirectory(dir, true);
                for (const name of fs.readdirSync(dir)) {
                    const match = TEMP_FILE.exec(name);
                    if (!match)
                        continue;
                    const file = path.join(dir, name);
                    let mtime;
                    try {
                        mtime = fs.lstatSync(file).mtimeMs;
                    }
                    catch {
                        continue;
                    }
                    if (mtime > cutoff || alive(Number(match[1]))) {
                        kept += 1;
                        continue;
                    }
                    try {
                        fs.unlinkSync(file);
                        removed += 1;
                    }
                    catch (error) {
                        if (errno(error) !== "ENOENT")
                            throw io("cannot remove an orphaned temp file", error);
                    }
                }
            }
            return { removed, kept };
        },
        async compactHistory(operationId) {
            const dir = operationDir(operationId, false);
            if (dir === null)
                return 0;
            const versions = versionsOf(dir);
            let rewritten = 0;
            // Only versions below the current one when listed: versions only grow, so the current
            // record is never rewritten, and a version a reader is about to open is replaced
            // atomically (the reader then finds the stub and looks again).
            for (const version of versions.slice(0, -1)) {
                const file = path.join(dir, `${version}.json`);
                let value;
                try {
                    value = decodeRecord(readFile(file), operationId);
                    if (isSuperseded(value))
                        continue;
                    assertStored(value, operationId, version);
                }
                catch (error) {
                    // A superseded version that is unreadable or not this operation's is left as found:
                    // compaction never overwrites what it cannot identify. Links are still refused.
                    if (error instanceof LedgerError && error.code === "corrupt")
                        continue;
                    throw error;
                }
                const temp = stage(dir, `${JSON.stringify({ ledger: SUPERSEDED, operationId, version })}\n`);
                try {
                    // rename replaces the file atomically and keeps its name taken throughout.
                    fs.renameSync(temp, file);
                }
                catch (error) {
                    removeQuietly(temp);
                    throw io("cannot compact a superseded version", error);
                }
                rewritten += 1;
            }
            if (rewritten > 0)
                syncDirectory(dir);
            return rewritten;
        },
        async probe() {
            const ns = namespaceDir(true);
            const temp = stage(ns, "probe\n");
            const target = `${temp}.link`;
            try {
                fs.linkSync(temp, target);
            }
            catch (error) {
                const code = errno(error) ?? "";
                throw LINK_UNSUPPORTED.has(code)
                    ? new LedgerError("unsupported", `the filesystem refused a hard link (${code})`, {
                        path: ns,
                    })
                    : io("the hard-link probe failed", error);
            }
            finally {
                removeQuietly(temp);
                removeQuietly(target);
            }
            return { directorySync: syncDirectory(ns) };
        },
    };
}
