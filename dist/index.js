/**
 * @comforge/cli as a library: the same commands the `comforge` executable runs, with an
 * injectable runtime (working directory, environment, clock, fetch, child processes).
 */
export { main, parseArgs, renderHuman, runCommand } from "./cli.js";
export { COMMANDS, capabilities, context, doctor, PACKAGE_VERSION } from "./commands/agent.js";
export { assertCompletionLinkUnambiguous, complete, completionLinkBlock, deliver, publish, recover, withCompletionLink, } from "./commands/delivery.js";
export { advisoryReviews, artifact, artifactReadable, governanceCommands, issueComments, publishComment, publishReview, publishSpecification, pullRequests, } from "./commands/governance.js";
export { init } from "./commands/init.js";
export { cleanup, revise, start, status, verify, } from "./commands/lifecycle.js";
export { LEGACY_FORMAT, migrate } from "./commands/migrate.js";
export { CLI_CAPABILITIES, CONFIG_FILE, CONFIG_SCHEMA, ConfigSchema, configJsonSchema, HOST_CAPABILITIES, parseConfig, SECTION_DEFAULTS, TRUSTED_SECTIONS, trustedChanges, } from "./config.js";
export { openContext, } from "./context.js";
export { CliError, ERROR_CODES, EXIT } from "./errors.js";
export { resolveHost } from "./host.js";
export { stableJson } from "./json.js";
export { completionProtocol, currentResults, DISCUSSION_LIMITS, DISCUSSION_NOTICE, detectSecrets, discussionProtocol, REVIEW_LIMITS, reviewProtocol, specificationProtocol, TRUSTED_ASSOCIATIONS, } from "./protocols.js";
export { PROVISION_RESULT_SCHEMA } from "./provision.js";
export { createRemoteGovernance, } from "./remoteGovernance.js";
export { checkManifest, routeTask } from "./routing.js";
export { defaultRuntime, spawnRun, } from "./runtime.js";
export { createLifecycleServices, toServiceError, } from "./services.js";
export { INITIATIVE_SCHEMA, stateStoreOn, } from "./state.js";
