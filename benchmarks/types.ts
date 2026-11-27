/**
 * The benchmark's shared vocabulary: the tasks and fixture repositories this library defines,
 * the data boundary every approval must state, and the arm-adapter interface an experiment
 * implements. Which arms an experiment compares, their version pins and its repetitions are
 * the experiment's own protocol, never defined here.
 */
import type { Fixture } from "./fixtures.ts";
import type { ChildEnv } from "./redact.ts";
import type { SyntheticGitHub } from "./syntheticGitHub.ts";

export const TASK_IDS = ["T1", "T2", "T3", "T4", "T5", "T6"] as const;
export type TaskId = (typeof TASK_IDS)[number];
export const REPO_IDS = ["ts-service", "py-library"] as const;
export type RepoId = (typeof REPO_IDS)[number];
/** An arm is named by the experiment that defines it. */
export type ArmId = string;
export const DATA_BOUNDARY = "synthetic fixtures only";

/** Task ids that must see zero GitHub writes. */
export const ZERO_WRITE_TASKS: readonly TaskId[] = ["T5"];

export type Json = Record<string, unknown>;

/** Every record states whether its numbers are real measurements. */
export interface Labeled<T> {
  synthetic: boolean;
  value: T;
}

/** A version pin. `version: null` is a required input that must be supplied before a live run. */
export interface VersionPin {
  tool: string;
  version: string | null;
  status: string;
  /** argv that prints the installed version; null when unknown. */
  probe: string[] | null;
}

/** Operator-supplied inputs for arms that cannot be installed here. */
export interface ArmInputs {
  pins?: Partial<Record<ArmId, string>>;
  /** Published quickstart text, verbatim, per arm. */
  quickstarts?: Partial<Record<ArmId, string>>;
  /** The tool's own initialization command (argv), per arm. */
  setup?: Partial<Record<ArmId, string[]>>;
}

export interface ArmContext {
  task: TaskId;
  fixture: Fixture;
  workspace: string;
  remoteDir: string;
  /** Per-run directory holding bin/ wrappers and the tool log. */
  runDir: string;
  github: SyntheticGitHub;
  env: ChildEnv;
  inputs: ArmInputs;
}

export interface ArmPrepared {
  armId: ArmId;
  status: "ready" | "needs-input";
  missing: string[];
  instructions: string;
  setupCommands: string[][];
  mcpConfig: Json | null;
  versionPin: { tool: string; pinned: string | null; status: string };
  quickstart: { source: string; sha256: string } | null;
  pathPrepend: string[];
  extraEnv: Record<string, string>;
  allowedTools: string[];
  trackingIssue: number;
  completionPattern: string;
}

export interface ArmAdapter {
  id: ArmId;
  pin: VersionPin;
  prepare(ctx: ArmContext): ArmPrepared;
}
