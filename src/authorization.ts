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
] as const;
export type GrantMode = (typeof GRANT_MODES)[number];
export const PROHIBITED_MODES = ["merge", "release", "deploy"] as const;

/** The actions a trusted supervisor performs; each checks a grant at its own boundary. */
export const ACTIONS = [
  "claim",
  "launch-session",
  "resume-session",
  "commit",
  "validate",
  "publish",
] as const;
export type RuntimeAction = (typeof ACTIONS)[number];

/** Which grant modes authorize which action. Publication is never implied. */
export const ACTION_MODES: Readonly<Record<RuntimeAction, readonly GrantMode[]>> = {
  claim: ["audit", "implementation", "revision"],
  "launch-session": ["audit", "implementation", "revision"],
  "resume-session": ["audit", "implementation", "revision"],
  commit: ["implementation", "revision"],
  validate: ["implementation", "revision", "validation"],
  publish: ["publication"],
};

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
] as const;
export type Capability = (typeof CAPABILITIES)[number];
