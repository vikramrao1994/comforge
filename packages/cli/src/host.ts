import { existsSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";
import { fail } from "./errors.ts";

/**
 * Trusted host policy (M9): what an embedding supervisor decides about where and how the
 * lifecycle touches the filesystem and what validation runs. It is code the embedder writes —
 * never a CLI flag, never configuration a candidate can edit, never a tool input. The `comforge`
 * executable sets none of it, and `createLifecycleServices` takes it once at construction.
 *
 * - `checkoutParent`: an absolute directory isolated checkouts are created in, instead of the
 *   trusted configuration's `checkout.parent` (a supervisor's own clone area). Recorded on the
 *   initiative; cleanup removes such a checkout only under the same host policy.
 * - `prepareCheckout(dir)`: runs after a clone exists and before provisioning — on each isolated
 *   checkout and on each verification snapshot — e.g. to hand it to an isolated worker user (an
 *   ACL or group). When it is set, a snapshot's private scratch parent is made traversable
 *   (0711, not listable) so the worker can reach the snapshot; nothing else in it is opened.
 * - `remove(dir)`: removes a directory the lifecycle created and prepared (a checkout, a
 *   verification snapshot) — e.g. through the worker user that owns files the candidate wrote.
 *   It receives exactly the directories `prepareCheckout` received; the CLI removes its own
 *   private scratch around a snapshot itself.
 * - `validation`: the validation commands for `verify`, replacing the trusted configuration's
 *   (a runtime with its own validation policy). Recorded on each validation as `policy: "host"`.
 */
export interface HostPolicy {
  checkoutParent?: string;
  prepareCheckout?: (dir: string) => void;
  remove?: (dir: string) => void;
  validation?: { name: string; run: string[] }[];
}

export interface ResolvedHost {
  checkoutParent: string | null;
  /** Whether the embedder supplied `prepareCheckout` (the default does nothing). */
  prepares: boolean;
  prepareCheckout: (dir: string) => void;
  remove: (dir: string) => void;
  validation: { name: string; run: string[] }[] | null;
}

/** Real path of `p`, through its nearest existing ancestor when it does not exist yet. */
function canonical(p: string): string {
  const abs = path.resolve(p);
  if (existsSync(abs)) return realpathSync(abs);
  const parent = path.dirname(abs);
  return parent === abs ? abs : path.join(canonical(parent), path.basename(abs));
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const safeArg = (a: unknown): a is string =>
  typeof a === "string" && a.length > 0 && a.length <= 4096 && !a.includes("\0");

export function resolveHost(policy: HostPolicy | undefined, primaryRoot: string): ResolvedHost {
  const p = policy ?? {};
  let parent: string | null = null;
  if (p.checkoutParent !== undefined) {
    const raw = p.checkoutParent;
    if (typeof raw !== "string" || !path.isAbsolute(raw) || raw.includes("\0"))
      fail("config-invalid", "host checkoutParent must be an absolute path");
    // Canonical, as Git reports checkouts (a symlinked temporary directory, for example).
    parent = canonical(raw);
    const root = canonical(primaryRoot);
    // A checkout inside the primary (or the primary inside the parent's own clone) would let
    // one repository's files reach the other's.
    if (
      parent === root ||
      parent.startsWith(`${root}${path.sep}`) ||
      parent === path.parse(parent).root
    )
      fail(
        "config-invalid",
        "host checkoutParent must be outside the primary checkout and not a filesystem root",
        {
          checkoutParent: parent,
        },
      );
  }
  for (const [name, fn] of [
    ["prepareCheckout", p.prepareCheckout],
    ["remove", p.remove],
  ] as const)
    if (fn !== undefined && typeof fn !== "function")
      fail("config-invalid", `host ${name} must be a function`);
  let validation: ResolvedHost["validation"] = null;
  if (p.validation !== undefined) {
    if (!Array.isArray(p.validation) || p.validation.length === 0 || p.validation.length > 32)
      fail("config-invalid", "host validation must list 1–32 commands");
    validation = p.validation.map((c) => {
      if (!c || typeof c.name !== "string" || !NAME.test(c.name))
        return fail("config-invalid", "a host validation command needs a simple name");
      if (!Array.isArray(c.run) || c.run.length === 0 || c.run.length > 64 || !c.run.every(safeArg))
        return fail("config-invalid", `host validation ${c.name} must be an argv array`);
      // argv, never a shell string: no word splitting, no interpolation of candidate text.
      return { name: c.name, run: [...c.run] };
    });
    if (new Set(validation.map((c) => c.name)).size !== validation.length)
      fail("config-invalid", "host validation command names must be unique");
  }
  return {
    checkoutParent: parent,
    prepares: p.prepareCheckout !== undefined,
    prepareCheckout: p.prepareCheckout ?? (() => {}),
    remove: p.remove ?? ((dir) => rmSync(dir, { recursive: true, force: true })),
    validation,
  };
}
