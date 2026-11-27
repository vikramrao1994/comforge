import { expect, test } from "bun:test";
import * as kernel from "../src/index.ts";

// The package's runtime export surface, frozen (ENGINEERING-FACTORY-DX-001). Removing or
// renaming an export breaks consumers; adding one is a deliberate change to this list and
// to the README's export reference.
const EXPORTS = [
  "ACTIONS",
  "ACTION_MODES",
  "ADVISORY_REVIEW_NOTICE",
  "CAPABILITIES",
  "CLOCK_SKEW_MS",
  "COMMANDS",
  "COMMAND_SCOPE_VERSION",
  "COMPLETION_LIMITS",
  "COMPLETION_NOTICE",
  "CONFIDENCES",
  "DESTRUCTIVE_COMMANDS",
  "DISPOSITIONS",
  "EnvelopeSchema",
  "FINDING_ID_PATTERN",
  "FINDING_SEVERITIES",
  "FactoryCoreError",
  "GATE_STATUSES",
  "GRANT_MODES",
  "ISSUE_TYPES",
  "ISSUE_TYPE_MATRIX",
  "LIFECYCLE_ACTIONS",
  "LIFECYCLE_DECISIONS",
  "LIFECYCLE_REASONS",
  "MAX_GRANT_LIFETIME_MS",
  "OUTCOMES",
  "PROHIBITED_MODES",
  "PUBLICATION_COMMANDS",
  "RECEIPT_MAX_AGE_MS",
  "REVIEW_VERDICTS",
  "SCOPED_ONLY_COMMANDS",
  "SECTION_KEYS",
  "canonicalBody",
  "canonicalJson",
  "canonicalTitle",
  "createCompletionProtocol",
  "createGrantProtocol",
  "createReceiptProtocol",
  "createReviewProtocol",
  "createSpecificationProtocol",
  "deriveDisposition",
  "envelopeDigest",
  "evaluateLifecycleAction",
  "idempotencyKeyDigest",
  "isReviewStale",
  "keyIdFor",
  "requireCapability",
  "reviewProvenance",
];

test("the runtime export surface is exactly the frozen list", () => {
  expect(Object.keys(kernel).sort()).toEqual([...EXPORTS].sort());
});

test("invalid configuration is refused at construction with a named field", () => {
  expect(() =>
    kernel.createGrantProtocol({
      grantScheme: "Bad Scheme",
      repository: "acme/widgets",
      ticketPattern: /x/,
      branchForTicket: (t) => t,
    }),
  ).toThrow("factory-core: invalid grant protocol grantScheme");
  expect(() =>
    kernel.createReceiptProtocol({ receiptScheme: "acme-receipt/v1", repository: "not a repo" }),
  ).toThrow("factory-core: invalid receipt protocol repository");
});
