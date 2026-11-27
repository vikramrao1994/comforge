import { complete, deliver, publish, recover } from "./commands/delivery.ts";
import { advisoryReviews, artifact, issueComments, publishReview, publishSpecification, pullRequests } from "./commands/governance.ts";
import { cleanup, revise, start, status, verify } from "./commands/lifecycle.ts";
import { migrate } from "./commands/migrate.ts";
import { type ContextOptions } from "./context.ts";
import { type ErrorCode, type ExitStatus } from "./errors.ts";
import type { Repository } from "./repository.ts";
import type { Runtime } from "./runtime.ts";
import type { DeliveryAttempt, ProvisionStep, Validation } from "./state.ts";
/**
 * R10: the lifecycle as callable services, for embedders such as a future MCP server.
 *
 * Every dependency is injected: the runtime (environment, clock, `fetch`, child processes),
 * the repository, the credential provider, the initiative store and write ledger, and a
 * cancellation signal. A service never exits the process, never prints, never reads
 * `process.cwd()` or `process.env`, never changes the working directory or the environment,
 * and keeps no credential beyond the call. It returns a typed value or a structured error
 * with the same stable codes and exit classes the CLI uses; the CLI is a thin layer that
 * prints exactly these values (`runCommand`).
 *
 * Authorization is unchanged: writes still need the trusted configuration's authorization
 * (owner grants or operator mode). A service caller cannot authorize itself by calling.
 */
export interface LifecycleServicesOptions extends ContextOptions {
    runtime: Runtime;
    /** Required here (unlike the CLI): a service never discovers its repository from a cwd. */
    repository: Repository;
}
export type ServiceError = {
    code: ErrorCode | "internal";
    message: string;
    detail: Record<string, unknown>;
    exit: ExitStatus;
};
export type ServiceResult<T> = {
    ok: true;
    value: T;
    exit: ExitStatus;
} | {
    ok: false;
    error: ServiceError;
};
export interface StartResult {
    initiative: string;
    branch: string;
    checkout: string;
    base: {
        remote: string;
        branch: string;
        sha: string;
    };
    specification: {
        issueNumber: number;
        digest: string;
    } | null;
    provisioned: string[];
    provisioning: ProvisionStep[];
    primaryCheckout: {
        untouched: boolean;
        trackedChanges: number;
        untrackedFiles: number;
    };
    /** Present from attempt 2 on (`reopen`); a first attempt omits it. */
    attempt?: number;
}
export interface ReviseResult {
    initiative: string;
    checkout: string;
    pullRequest: number;
    reviewedHead: string;
    checkoutHead: string;
    checkoutCreated: boolean;
    relation: "in-sync" | "behind" | "ahead";
    fastForwarded: boolean;
    unpublishedCommits: number;
    baseDivergence: {
        base: string;
        commitsBehindBase: number;
    };
}
export type VerifyResult = Validation & {
    initiative: string;
    note?: string;
    kept?: string;
};
export interface DeliverResult {
    initiative: string;
    executed: boolean;
    delivery: "planned" | "complete" | "incomplete";
    attempt?: number;
    pullRequest?: number | null;
    failedStage?: string;
    stages: Record<string, unknown>;
    error?: {
        code?: string;
        message: string;
        detail?: unknown;
    };
}
/** Commands whose result shape is open-ended evidence (plans, GitHub read-backs). */
export type EvidenceResult = Record<string, unknown>;
/**
 * A service caller cannot hand in an authorization: it is always established from the trusted
 * configuration (and a grant file for owner grants) inside the call. The commands' internal
 * `authorized` option (deliver authorizing a whole delivery once) is not part of this API.
 */
export type NoSelfAuthorization<O> = Omit<O, "authorized">;
export interface LifecycleServices {
    start(options: Parameters<typeof start>[1]): Promise<ServiceResult<StartResult>>;
    revise(options: Parameters<typeof revise>[1]): Promise<ServiceResult<ReviseResult>>;
    status(options: Parameters<typeof status>[1]): Promise<ServiceResult<EvidenceResult>>;
    verify(options: Parameters<typeof verify>[1]): Promise<ServiceResult<VerifyResult>>;
    publish(options: NoSelfAuthorization<Parameters<typeof publish>[1]>): Promise<ServiceResult<EvidenceResult>>;
    complete(options: NoSelfAuthorization<Parameters<typeof complete>[1]>): Promise<ServiceResult<EvidenceResult>>;
    deliver(options: Parameters<typeof deliver>[1]): Promise<ServiceResult<DeliverResult>>;
    recover(options: Parameters<typeof recover>[1]): Promise<ServiceResult<EvidenceResult>>;
    cleanup(options: Parameters<typeof cleanup>[1]): Promise<ServiceResult<EvidenceResult>>;
    migrate(options: Parameters<typeof migrate>[1]): Promise<ServiceResult<EvidenceResult>>;
    /** Publishes (or replays) a specification issue; owner-grant needs a publish-specification grant. */
    publishSpecification(options: Parameters<typeof publishSpecification>[1]): Promise<ServiceResult<EvidenceResult>>;
    /** Publishes an advisory review comment bound to the reviewed head; never a native review. */
    publishReview(options: Parameters<typeof publishReview>[1]): Promise<ServiceResult<EvidenceResult>>;
    issueComments(options: Parameters<typeof issueComments>[1]): Promise<ServiceResult<EvidenceResult>>;
    pullRequests(options: Parameters<typeof pullRequests>[1]): Promise<ServiceResult<EvidenceResult>>;
    advisoryReviews(options: Parameters<typeof advisoryReviews>[1]): Promise<ServiceResult<EvidenceResult>>;
    artifact(options: Parameters<typeof artifact>[1]): Promise<ServiceResult<EvidenceResult>>;
}
export type { DeliveryAttempt };
/** A thrown command error as a value; anything that is not a CliError is `internal`. */
export declare function toServiceError(error: unknown): ServiceError;
export declare function createLifecycleServices(options: LifecycleServicesOptions): LifecycleServices;
