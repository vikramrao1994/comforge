/**
 * @comforge/cli as a library: the same commands the `comforge` executable runs, with an
 * injectable runtime (working directory, environment, clock, fetch, child processes).
 */
export { main, parseArgs, renderHuman, runCommand } from "./cli.ts";
export { COMMANDS, capabilities, context, doctor, PACKAGE_VERSION } from "./commands/agent.ts";
export { assertCompletionLinkUnambiguous, complete, completionLinkBlock, deliver, publish, recover, withCompletionLink, } from "./commands/delivery.ts";
export { advisoryReviews, artifact, artifactReadable, type GovernanceContext, governanceCommands, issueComments, publishComment, publishReview, publishSpecification, pullRequests, } from "./commands/governance.ts";
export { init } from "./commands/init.ts";
export { type CommandResult, cleanup, revise, start, status, verify, } from "./commands/lifecycle.ts";
export { LEGACY_FORMAT, migrate } from "./commands/migrate.ts";
export { CLI_CAPABILITIES, CONFIG_FILE, CONFIG_SCHEMA, type ComforgeConfig, ConfigSchema, configJsonSchema, HOST_CAPABILITIES, parseConfig, SECTION_DEFAULTS, TRUSTED_SECTIONS, trustedChanges, } from "./config.ts";
export { type CommandContext, type ContextOptions, type CredentialProvider, openContext, } from "./context.ts";
export { CliError, ERROR_CODES, type ErrorCode, EXIT, type ExitStatus } from "./errors.ts";
export { type HostPolicy, type ResolvedHost, resolveHost } from "./host.ts";
export { stableJson } from "./json.ts";
export { completionProtocol, currentResults, DISCUSSION_LIMITS, DISCUSSION_NOTICE, type DiscussionProtocol, detectSecrets, discussionProtocol, REVIEW_LIMITS, reviewProtocol, specificationProtocol, TRUSTED_ASSOCIATIONS, } from "./protocols.ts";
export { PROVISION_RESULT_SCHEMA } from "./provision.ts";
export { createRemoteGovernance, type RemoteAuthorizationDecision, type RemoteAuthorizationRequest, type RemoteGovernance, type RemoteGovernanceOptions, } from "./remoteGovernance.ts";
export type { Repository } from "./repository.ts";
export { checkManifest, routeTask } from "./routing.ts";
export { defaultRuntime, type RunOptions, type RunResult, type Runtime, spawnRun, } from "./runtime.ts";
export { createLifecycleServices, type DeliverResult, type EvidenceResult, type LifecycleServices, type LifecycleServicesOptions, type ReviseResult, type ServiceError, type ServiceResult, type StartResult, toServiceError, type VerifyResult, } from "./services.ts";
export { type DeliveryAttempt, INITIATIVE_SCHEMA, type InitiativeRecord, type ProvisionStep, type StateLedger, type StateStore, type StoredRecord, stateStoreOn, } from "./state.ts";
