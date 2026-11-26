/**
 * @comforge/cli as a library: the same commands the `comforge` executable runs, with an
 * injectable runtime (working directory, environment, clock, fetch, child processes).
 */
export { main, parseArgs, renderHuman, runCommand } from "./cli.js";
export { COMMANDS, capabilities, context, doctor, PACKAGE_VERSION } from "./commands/agent.js";
export { complete, deliver, publish, recover, withCompletionLink } from "./commands/delivery.js";
export { init } from "./commands/init.js";
export { cleanup, revise, start, status, verify, } from "./commands/lifecycle.js";
export { CLI_CAPABILITIES, CONFIG_FILE, CONFIG_SCHEMA, ConfigSchema, configJsonSchema, parseConfig, TRUSTED_SECTIONS, trustedChanges, } from "./config.js";
export { openContext } from "./context.js";
export { CliError, ERROR_CODES, EXIT } from "./errors.js";
export { stableJson } from "./json.js";
export { completionProtocol, currentResults, detectSecrets, specificationProtocol, TRUSTED_ASSOCIATIONS, } from "./protocols.js";
export { checkManifest, routeTask } from "./routing.js";
export { defaultRuntime, spawnRun, } from "./runtime.js";
export { INITIATIVE_SCHEMA } from "./state.js";
