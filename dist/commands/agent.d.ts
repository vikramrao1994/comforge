import { type Runtime } from "../runtime.ts";
import type { CommandResult } from "./lifecycle.ts";
export declare const PACKAGE_VERSION: string;
/** What each command does, for `--help`, `capabilities` and documentation. One table, one truth. */
export declare const COMMANDS: readonly [{
    readonly name: "init";
    readonly usage: "init [--write] [--force]";
    readonly summary: "Detect conventions and preview (or write) comforge.config.json.";
    readonly writes: "repository file, only with --write";
    readonly dryRunByDefault: true;
}, {
    readonly name: "doctor";
    readonly usage: "doctor";
    readonly summary: "Read-only environment, configuration and credential checks.";
    readonly writes: "none";
    readonly dryRunByDefault: false;
}, {
    readonly name: "capabilities";
    readonly usage: "capabilities";
    readonly summary: "This table, exit codes, error codes and what the CLI never does.";
    readonly writes: "none";
    readonly dryRunByDefault: false;
}, {
    readonly name: "context";
    readonly usage: "context [--task TEXT] | context check";
    readonly summary: "The one routing category a task matches, with its files and validation.";
    readonly writes: "none";
    readonly dryRunByDefault: false;
}, {
    readonly name: "schema";
    readonly usage: "schema <config|capabilities>";
    readonly summary: "A versioned JSON Schema.";
    readonly writes: "none";
    readonly dryRunByDefault: false;
}, {
    readonly name: "start";
    readonly usage: "start <TICKET[.phase]> [--issue N] [--expect-digest HEX] [--no-provision]";
    readonly summary: "Verify the specification and create an isolated checkout from the fetched base.";
    readonly writes: "local checkout and state";
    readonly dryRunByDefault: false;
}, {
    readonly name: "revise";
    readonly usage: "revise <PR> [--reviewed-head SHA]";
    readonly summary: "Resume an initiative for a revision of its open pull request.";
    readonly writes: "local state";
    readonly dryRunByDefault: false;
}, {
    readonly name: "status";
    readonly usage: "status [TICKET[.phase]]";
    readonly summary: "Local state of one or every initiative.";
    readonly writes: "none";
    readonly dryRunByDefault: false;
}, {
    readonly name: "verify";
    readonly usage: "verify <TICKET[.phase]> [--commit SHA]";
    readonly summary: "Run the trusted validation commands on the exact committed head; record PASS/FAIL.";
    readonly writes: "local state";
    readonly dryRunByDefault: false;
}, {
    readonly name: "publish";
    readonly usage: "publish <TICKET[.phase]> --title TEXT [--draft] [--grant FILE] [--execute]";
    readonly summary: "Push the validated head and create or update its pull request.";
    readonly writes: "git push, GitHub pull request";
    readonly dryRunByDefault: true;
}, {
    readonly name: "complete";
    readonly usage: "complete --result FILE [--grant FILE] [--execute]";
    readonly summary: "Validate a completion result and publish it as one issue comment, linked from the PR.";
    readonly writes: "GitHub issue comment, PR body";
    readonly dryRunByDefault: true;
}, {
    readonly name: "deliver";
    readonly usage: "deliver <TICKET[.phase]> --title TEXT --result FILE [--no-pr] [--draft] [--grant FILE] [--execute]";
    readonly summary: "publish, then complete; an interrupted delivery exits 4 and is rerun.";
    readonly writes: "as publish and complete";
    readonly dryRunByDefault: true;
}, {
    readonly name: "grant";
    readonly usage: "grant template <ID> [--hours N] | grant sign <ID> --grant FILE --key FILE";
    readonly summary: "Owner grants: an unsigned grant for the current head, or sign one (on the owner's machine).";
    readonly writes: "none";
    readonly dryRunByDefault: false;
}, {
    readonly name: "recover";
    readonly usage: "recover <TICKET[.phase]> [--abandon] [--grant FILE] [--execute]";
    readonly summary: "Reconcile this initiative's unresolved GitHub writes; --abandon gives up one a complete search did not find.";
    readonly writes: "write ledger";
    readonly dryRunByDefault: true;
}, {
    readonly name: "cleanup";
    readonly usage: "cleanup <PR|TICKET[.phase]> [--allow-missing-completion] [--execute]";
    readonly summary: "After a merge: remove the checkout and close the local record.";
    readonly writes: "local checkout and state";
    readonly dryRunByDefault: true;
}];
export declare function capabilities(): CommandResult;
export declare function context(rt: Runtime, options: {
    task?: string;
    check?: boolean;
}): CommandResult;
export declare function doctor(rt: Runtime): Promise<CommandResult>;
