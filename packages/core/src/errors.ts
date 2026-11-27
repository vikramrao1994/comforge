/**
 * The one error the kernel throws for a refused grant or receipt. `code` is
 * `unauthorized` (a grant does not authorize the action) or `validation_failed`
 * (a receipt does not prove a passing validation of the expected commit); the
 * message names the first binding that failed. Consumers translate it into their
 * own error type at their boundary.
 */
export type FactoryCoreErrorCode = "unauthorized" | "validation_failed";

export class FactoryCoreError extends Error {
  readonly code: FactoryCoreErrorCode;
  readonly detail: Record<string, unknown> | undefined;

  constructor(code: FactoryCoreErrorCode, message: string, detail?: Record<string, unknown>) {
    super(message);
    this.name = "FactoryCoreError";
    this.code = code;
    this.detail = detail;
  }
}
