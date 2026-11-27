// Types for npm-release.mjs, for the portfolio's TypeScript callers and tests. The .mjs is
// shipped to the Comforge release branch as plain JavaScript; this file is not.

export type FetchLike = (url: string) => Promise<Response>;

export type ReleaseRecord = {
  schema: string;
  package: string;
  version: string;
  tag: string;
  source?: Record<string, string>;
  files: Record<string, string>;
};

export type NpmPlan = {
  schema: string;
  package: string;
  version: string;
  tarball: { file: string; integrity: string; sha256: string; files: number };
  manifest: { transforms: string[]; sha256: string };
  gitRelease: {
    repository: string;
    commit: string | null;
    tag: string;
    releaseRecordSha256: string;
    source?: Record<string, string>;
  };
  registry: { bootstrapRequired: boolean; existingVersions: string[] };
  files: Record<string, string>;
};

/** A plan without a packed tarball: what a release's npm version must contain. */
export type NpmExpectation = Omit<NpmPlan, "tarball" | "registry"> & {
  tarball: { file: null; integrity: null; sha256: null; files: number };
  registry: null;
};

export type ReadbackResult = {
  package: string;
  version: string;
  pass: boolean;
  checks: Array<{ check: string; pass: boolean; detail: string }>;
};

export declare const REGISTRY: string;
export declare const PLAN_SCHEMA: string;
export declare const RELEASE_SCHEMA: string;
export declare const WORKFLOW_PATH: string;
export declare const PACKAGES: Readonly<Record<string, Readonly<{ tagPrefix: string; workflow: string }>>>;
export declare const SLSA_PROVENANCE: string;
export declare const LIFECYCLE_SCRIPTS: string[];

export declare class NpmReleaseRefusal extends Error {
  constructor(code: string, message: string);
  code: string;
}

export declare function parseVersion(version: string): [number, number, number] | null;
export declare function compareVersions(a: string, b: string): number;
export declare function verifyRelease(options: {
  releaseDir: string;
  commit?: string;
  tag?: string;
  packageName?: string;
}): { record: ReleaseRecord; manifest: Record<string, unknown> };
export declare function verifyOnReleaseBranch(options: {
  releaseDir: string;
  commit: string;
  branchRef: string;
}): void;
export declare function releaseExpectation(options: {
  releaseDir: string;
  commit?: string;
  tag?: string;
  repository: string;
  packageName?: string;
}): {
  record: ReleaseRecord;
  manifest: Record<string, unknown>;
  expected: string[];
  expectation: NpmExpectation;
};
export declare function npmManifest(
  releaseManifest: Record<string, unknown>,
  repository: string,
): { manifest: Record<string, unknown>; transforms: string[] };
export declare function expectedPackFiles(
  record: ReleaseRecord,
  manifest: Record<string, unknown>,
): string[];
export declare function verifyTarball(options: {
  tarball: string;
  record: ReleaseRecord;
  manifest: Record<string, unknown>;
  expectedFiles: string[];
}): number;
export declare function registryState(options: {
  name: string;
  version: string;
  fetchImpl?: FetchLike;
  registry?: string;
}): Promise<{ exists: boolean; versions: string[]; bootstrapRequired: boolean }>;
export declare function plan(options: {
  releaseDir: string;
  commit?: string;
  tag?: string;
  repository: string;
  outDir: string;
  fetchImpl?: FetchLike;
  registry?: string;
  packageName?: string;
}): Promise<NpmPlan>;
export declare function verifyPlannedTarball(options: {
  planFile: string;
  tarball: string;
  fetchImpl?: FetchLike;
  registry?: string;
}): Promise<NpmPlan>;
export declare function provenanceStatement(attestations: unknown): Record<string, unknown> | null;
export declare function checkProvenance(
  statement: unknown,
  expected: {
    name: string;
    version: string;
    integrity: string;
    repository: string;
    tag: string;
    commit: string;
  },
): string[];
export declare function readback(options: {
  planFile?: string;
  plan?: NpmPlan | NpmExpectation;
  expectProvenance?: boolean;
  fetchImpl?: FetchLike;
  registry?: string;
}): Promise<ReadbackResult>;
