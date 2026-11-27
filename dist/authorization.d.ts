/**
 * The authorization vocabulary of the engineering lifecycle: what a signed grant may
 * authorize. Merge, release and deploy are deliberately not modes: no grant can name
 * them, so no verified grant can authorize them.
 */
export declare const GRANT_MODES: readonly ["audit", "implementation", "validation", "publication", "revision", "command"];
export type GrantMode = (typeof GRANT_MODES)[number];
export declare const PROHIBITED_MODES: readonly ["merge", "release", "deploy"];
/** The actions a trusted supervisor performs; each checks a grant at its own boundary. */
export declare const ACTIONS: readonly ["claim", "launch-session", "resume-session", "commit", "validate", "publish"];
export type RuntimeAction = (typeof ACTIONS)[number];
/** Which grant modes authorize which action. Publication is never implied. */
export declare const ACTION_MODES: Readonly<Record<RuntimeAction, readonly GrantMode[]>>;
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
export declare const COMMAND_SCOPE_VERSION: 1;
export declare const PUBLICATION_COMMANDS: readonly ["publish", "complete", "deliver", "recover"];
export declare const SCOPED_ONLY_COMMANDS: readonly ["cleanup", "publish-specification", "publish-review"];
export declare const COMMANDS: readonly ["publish", "complete", "deliver", "recover", "cleanup", "publish-specification", "publish-review"];
export type Command = (typeof COMMANDS)[number];
export type PublicationCommand = (typeof PUBLICATION_COMMANDS)[number];
export type ScopedOnlyCommand = (typeof SCOPED_ONLY_COMMANDS)[number];
/** Commands whose remote effect cannot be undone by a later write. */
export declare const DESTRUCTIVE_COMMANDS: readonly Command[];
/**
 * Capabilities a grant may add. An absent capability is refused at the boundary that
 * needs it: a candidate that changes a workflow, or its own validation definitions,
 * needs the owner to have granted that explicitly.
 */
export declare const CAPABILITIES: readonly ["edit-repository", "run-e2e", "modify-workflows", "accept-validation-changes"];
export type Capability = (typeof CAPABILITIES)[number];
