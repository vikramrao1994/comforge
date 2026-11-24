/**
 * The authorization vocabulary of the engineering lifecycle: what a signed grant may
 * authorize. Merge, release and deploy are deliberately not modes: no grant can name
 * them, so no verified grant can authorize them.
 */
export declare const GRANT_MODES: readonly ["audit", "implementation", "validation", "publication", "revision"];
export type GrantMode = (typeof GRANT_MODES)[number];
export declare const PROHIBITED_MODES: readonly ["merge", "release", "deploy"];
/** The actions a trusted supervisor performs; each checks a grant at its own boundary. */
export declare const ACTIONS: readonly ["claim", "launch-session", "resume-session", "commit", "validate", "publish"];
export type RuntimeAction = (typeof ACTIONS)[number];
/** Which grant modes authorize which action. Publication is never implied. */
export declare const ACTION_MODES: Readonly<Record<RuntimeAction, readonly GrantMode[]>>;
/**
 * Capabilities a grant may add. An absent capability is refused at the boundary that
 * needs it: a candidate that changes a workflow, or its own validation definitions,
 * needs the owner to have granted that explicitly.
 */
export declare const CAPABILITIES: readonly ["edit-repository", "run-e2e", "modify-workflows", "accept-validation-changes"];
export type Capability = (typeof CAPABILITIES)[number];
