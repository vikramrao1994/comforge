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
    validation?: {
        name: string;
        run: string[];
    }[];
}
export interface ResolvedHost {
    checkoutParent: string | null;
    /** Whether the embedder supplied `prepareCheckout` (the default does nothing). */
    prepares: boolean;
    prepareCheckout: (dir: string) => void;
    remove: (dir: string) => void;
    validation: {
        name: string;
        run: string[];
    }[] | null;
}
export declare function resolveHost(policy: HostPolicy | undefined, primaryRoot: string): ResolvedHost;
