import { type ConfigInput } from "../config.ts";
import { type Runtime } from "../runtime.ts";
import type { CommandResult } from "./lifecycle.ts";
/**
 * `comforge init`: detects a repository's conventions and proposes the smallest
 * configuration that works. It previews by default; `--write` writes one file,
 * `comforge.config.json`, and only when it does not exist (or, with `--force`, the owner's
 * explicit consent to replace it). It never writes a credential, a permission, a hook or a
 * GitHub setting, and it changes nothing on a rerun with the same inputs.
 *
 * Anything it cannot detect is written so that it fails closed: an unknown test command
 * becomes a validation command that fails with an instruction, so nothing is published
 * unvalidated until someone configures it.
 */
interface Detection {
    repository: {
        owner: string;
        name: string;
    } | null;
    baseBranch: string;
    remote: string;
    validation: {
        name: string;
        run: string[];
    }[];
    provision: string[][];
    reportDir: string;
    notes: string[];
}
export declare function proposedConfig(d: Detection): ConfigInput;
export declare function init(rt: Runtime, options: {
    write: boolean;
    force: boolean;
}): CommandResult;
export {};
