import { type Grant, type GrantEnvelope, type GrantProtocol } from "@comforge/core";
import type { ComforgeConfig } from "./config.ts";
import type { CommandContext } from "./context.ts";
import { type InitiativeRecord } from "./state.ts";
/**
 * Who may cause a GitHub write. Holding the CLI and a credential is not authority by itself.
 *
 * - No `security.authorization` in the trusted configuration: every write is refused
 *   (`authorization-required`). That is the default.
 * - `operator`: an explicit owner choice, merged to the base, that whoever runs the CLI with the
 *   credential decides. It is policy, not enforcement, and is reported as such.
 * - `owner-grant`: each write needs an owner-signed grant verified by the @comforge/core grant
 *   protocol against keys in the trusted configuration. The grant is bound to this repository,
 *   the ticket, its issue and unedited specification digest, the base commit, the exact commit
 *   and branch being published, and expires (at most 7 days). Each command run spends one of its
 *   `maxAttempts`; reuse past that is refused as a replay.
 *
 * The trusted configuration comes from the base revision, so candidate text cannot add a key
 * or switch the mode. Whoever holds a trusted private key can sign: keeping that key out of an
 * agent's environment is external enforcement this CLI cannot provide.
 */
export type Authorized = {
    mode: "operator";
} | {
    mode: "owner-grant";
    grantId: string;
    keyId: string;
    expiresAt: string;
    envelopeDigest: string;
};
export declare function grantProtocol(config: ComforgeConfig, record: InitiativeRecord): GrantProtocol;
export declare function authorizeWrites(ctx: CommandContext, trusted: ComforgeConfig, record: InitiativeRecord | null, options: {
    head: string;
    grantFile?: string;
    command: string;
    /** False for a command with no remote write (recover): the grant is verified, no attempt is spent. */
    consume?: boolean;
}): Promise<Authorized>;
/**
 * Spends one attempt of a grant, atomically. The count is checked inside the compare-and-swap of
 * the initiative's state record (a @comforge/ledger version), so independent processes racing on
 * one grant can never spend more than `maxAttempts` between them: a loser re-reads the new
 * version and is refused once the attempts are gone.
 *
 * Accounting: an attempt is spent before any remote side effect of a command run (publish,
 * complete, deliver) and is not given back. A run that dies after spending it, before or after a
 * remote write, needs another attempt to run again; its write is then answered from the write
 * ledger (idempotent), never repeated. When the attempts are gone the owner issues a new grant.
 */
/** Commands whose remote effect is destructive; they never share a grant with any other. */
export declare const DESTRUCTIVE_COMMANDS: Set<string>;
export declare function reserveGrantAttempt(ctx: Pick<CommandContext, "state">, initiative: string, use: {
    grantId: string;
    maxAttempts: number;
    envelopeDigest: string;
    head: string;
    command: string;
    at: string;
}): Promise<number>;
/** An unsigned publication grant for the initiative's current head, for the owner to review and sign. */
export declare function grantTemplate(trusted: ComforgeConfig, record: InitiativeRecord, head: string, now: number, hours: number): Grant;
/**
 * Signs a grant with an Ed25519 private key. Meant for the owner's machine: the key must not be
 * readable by the agent the grant authorizes.
 */
export declare function signGrant(protocol: GrantProtocol, grant: unknown, privateKeyPem: string): GrantEnvelope;
