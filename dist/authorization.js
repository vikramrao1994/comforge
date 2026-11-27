/**
 * The authorization vocabulary of the engineering lifecycle: what a signed grant may
 * authorize. Merge, release and deploy are deliberately not modes: no grant can name
 * them, so no verified grant can authorize them.
 */
export const GRANT_MODES = [
    "audit",
    "implementation",
    "validation",
    "publication",
    "revision",
    "command",
];
export const PROHIBITED_MODES = ["merge", "release", "deploy"];
/** The actions a trusted supervisor performs; each checks a grant at its own boundary. */
export const ACTIONS = [
    "claim",
    "launch-session",
    "resume-session",
    "commit",
    "validate",
    "publish",
];
/** Which grant modes authorize which action. Publication is never implied. */
export const ACTION_MODES = {
    claim: ["audit", "implementation", "revision"],
    "launch-session": ["audit", "implementation", "revision"],
    "resume-session": ["audit", "implementation", "revision"],
    commit: ["implementation", "revision"],
    validate: ["implementation", "revision", "validation"],
    publish: ["publication"],
};
/**
 * Commands a grant can scope (`scope.version` 1). A command is a remote effect of a lifecycle
 * tool, distinct from the supervisor actions above, and is authorized by `authorizeCommand`.
 *
 * - The publication commands are what a `publication` grant without a scope has always
 *   authorized (the 0.1 contract, kept for grants signed before scopes existed). A
 *   `publication` grant with a scope authorizes only the commands it lists.
 * - The scoped-only commands are authorized only by a `command` grant whose scope names
 *   exactly that one command. An absent scope never confers them: older grants cannot
 *   authorize a destructive or newly introduced write by omission.
 */
export const COMMAND_SCOPE_VERSION = 1;
export const PUBLICATION_COMMANDS = ["publish", "complete", "deliver", "recover"];
export const SCOPED_ONLY_COMMANDS = ["cleanup", "publish-specification", "publish-review"];
export const COMMANDS = [...PUBLICATION_COMMANDS, ...SCOPED_ONLY_COMMANDS];
/** Commands whose remote effect cannot be undone by a later write. */
export const DESTRUCTIVE_COMMANDS = ["cleanup"];
/**
 * Capabilities a grant may add. An absent capability is refused at the boundary that
 * needs it: a candidate that changes a workflow, or its own validation definitions,
 * needs the owner to have granted that explicitly.
 */
export const CAPABILITIES = [
    "edit-repository",
    "run-e2e",
    "modify-workflows",
    "accept-validation-changes",
];
