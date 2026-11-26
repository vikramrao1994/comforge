/**
 * Local state, outside every committed artifact: `<git common dir>/comforge/`. Each
 * initiative is one versioned record in the `initiatives` namespace of a @comforge/ledger
 * file ledger, so concurrent commands on one machine update it by compare-and-swap and a
 * crash leaves the last complete version. The GitHub write ledger lives beside it, in the
 * namespace the trusted configuration names. Nothing here is a credential.
 */
export declare const INITIATIVE_SCHEMA = "comforge-initiative/v1";
export interface Validation {
    commit: string;
    tree: string;
    status: "PASS" | "FAIL";
    at: string;
    commands: {
        name: string;
        exitStatus: number | null;
        timedOut: boolean;
        durationMs: number;
    }[];
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
    base: {
        remote: string;
        branch: string;
        sha: string;
    };
    /** SHA-256 of the trusted configuration sections at `base.sha`. */
    trustedConfig: string;
    specification: {
        issueNumber: number;
        digest: string;
    } | null;
    validations: Validation[];
    revisions: {
        prNumber: number;
        reviewedHead: string;
        at: string;
    }[];
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
export declare const stateDir: (commonDir: string) => string;
export interface StateStore {
    get(id: string): Promise<InitiativeRecord | null>;
    create(record: Omit<InitiativeRecord, "version" | "schema" | "operationId">, id: string): Promise<InitiativeRecord>;
    /** Applies `change` by compare-and-swap, retrying on a concurrent update. */
    update(id: string, change: (record: InitiativeRecord) => void): Promise<InitiativeRecord>;
    list(): Promise<InitiativeRecord[]>;
}
export declare function openState(commonDir: string): StateStore;
export declare const nowIso: (now: number) => string;
