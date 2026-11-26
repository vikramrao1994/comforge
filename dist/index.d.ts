/**
 * @comforge/cli as a library: the same commands the `comforge` executable runs, with an
 * injectable runtime (working directory, environment, clock, fetch, child processes).
 */
export { main, parseArgs, renderHuman, runCommand } from "./cli.ts";
export { COMMANDS, capabilities, context, doctor, PACKAGE_VERSION } from "./commands/agent.ts";
export { complete, deliver, publish, recover, withCompletionLink } from "./commands/delivery.ts";
export { init } from "./commands/init.ts";
export { type CommandResult, cleanup, revise, start, status, verify, } from "./commands/lifecycle.ts";
export { CLI_CAPABILITIES, CONFIG_FILE, CONFIG_SCHEMA, type ComforgeConfig, ConfigSchema, configJsonSchema, parseConfig, TRUSTED_SECTIONS, trustedChanges, } from "./config.ts";
export { type CommandContext, openContext } from "./context.ts";
export { CliError, ERROR_CODES, type ErrorCode, EXIT, type ExitStatus } from "./errors.ts";
export { stableJson } from "./json.ts";
export { completionProtocol, currentResults, detectSecrets, specificationProtocol, TRUSTED_ASSOCIATIONS, } from "./protocols.ts";
export { checkManifest, routeTask } from "./routing.ts";
export { defaultRuntime, type RunOptions, type RunResult, type Runtime, spawnRun, } from "./runtime.ts";
export { INITIATIVE_SCHEMA, type InitiativeRecord } from "./state.ts";
