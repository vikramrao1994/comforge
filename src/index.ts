export {
  GITHUB_ERROR_CODES,
  GitHubAdapterError,
  type GitHubErrorCode,
  type GitHubErrorDetail,
} from "./errors.ts";
export {
  type ChangedFile,
  type CheckEvidence,
  type CommitComparison,
  createGitHubEvidence,
  type EvidenceLimits,
  type GitHubEvidence,
  type IssueEvidence,
  type PatchLimits,
  type PatchStatus,
  type PullRequestEvidence,
  type PullRequestFilesEvidence,
  type RepositoryRef,
  type ReviewEvidence,
  type UntrustedText,
  type WorkflowRunEvidence,
} from "./evidence.ts";
export {
  type Reconciliation,
  readSpecificationIssue,
  reconcileSpecification,
  type SpecificationIssueEvidence,
} from "./specification.ts";
export {
  createFetchTransport,
  type FetchTransportOptions,
  type GitHubTransport,
} from "./transport.ts";
