#!/usr/bin/env node
import { type CommandResult } from "./commands/lifecycle.ts";
import { type Runtime } from "./runtime.ts";
/**
 * `comforge <command> [arguments] [--json]`. Output: a result on stdout (human text, or
 * deterministic JSON with `--json`), an error on stderr as `{ error, message, detail }` JSON.
 * Exit statuses are `EXIT` in errors.ts and never change meaning within a major version.
 */
interface Parsed {
    command: string;
    positional: string[];
    flags: Map<string, string | true>;
}
export declare function parseArgs(argv: readonly string[]): Parsed;
export declare function runCommand(p: Parsed, rt: Runtime): Promise<CommandResult>;
/** Human rendering: the result's scalar fields, one per line; nested values as compact JSON. */
export declare function renderHuman(command: string, result: Record<string, unknown>): string;
export interface Io {
    out(text: string): void;
    err(text: string): void;
}
/** Runs one invocation; returns the exit status. Never throws. */
export declare function main(argv: readonly string[], rt?: Runtime, io?: Io): Promise<number>;
export {};
