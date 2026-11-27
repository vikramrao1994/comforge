# @comforge/core

**Comforge — An open, verifiable software factory for coding agents.** `@comforge/core` is its governance kernel.

Deterministic governance contracts for an AI-assisted engineering lifecycle, as a pure TypeScript library:

- published specifications and their digests;
- owner-signed grants and validation receipts (verification only);
- advisory pull-request reviews and completion records (integrity only);
- lifecycle decisions (`allow` / `deny` / `insufficient_evidence`).

It performs **no I/O**. It does no network, forge, filesystem, environment or clock access, and it never creates keys or signs. You bring the observations and the trust; it decides consistently.

> **Version 0.2.0, pre-1.0.** Published to npm as `@comforge/core` (with provenance). Releases are also tagged `core/vX.Y.Z` on the `releases/core` branch of the public Comforge repository (`github.com/vikramrao1994/comforge`), each with a `RELEASE.json` naming its source commit and checksums. The wire formats below are stable, but the TypeScript API may still change before 1.0.

## What it can and cannot tell you

| It answers | It never answers |
|---|---|
| Is this specification unaltered since it was published under your digest scheme? | Who wrote it, or whether anyone approved it |
| Is this grant signed by a key **you** trust, unexpired, and bound to this ticket, specification, base, commit and action? | Whether a human should still want this. Revocation and attempt counts come from your own ledger |
| Is this receipt a signed PASS of exactly this commit and tree by **your** validation controller? | Whether the validation was meaningful, or whether the commit changed its own tests |
| Is this review or completion record unaltered, and does it match its PR, head, ticket and issue? | Whether its author is trusted. You pass the author your forge reports to `reviewProvenance` |
| Is a lifecycle step consistent with the evidence you supplied? | Whether it is **authorized**. An `allow` grants nothing; merge, release and deploy are never actions |

Each answer is only as trustworthy as the observation you pass in. Never pass issue or comment text, an agent's output, or a record's own claim as an observation.

## Install and runtimes

| Consumer | How | Status |
|---|---|---|
| Bun ≥ 1.4 | the npm package, a release (git dependency), the workspace package or the distribution tarball | tested (1.4.1) |
| Node ≥ 22 | the npm package, a release (git dependency) or **the distribution tarball** (`dist/*.js`) | tested (v26.3.0) |
| Node, workspace source | not supported: Node does not strip types under `node_modules` (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`) | — |
| TypeScript (`tsc`) | the npm package and the distribution tarball ship `.d.ts`. The source package needs `allowImportingTsExtensions` | tested (7.0.2) |

Install from npm at an exact version:

```sh
npm install --save-exact @comforge/core@0.2.0     # or: bun add --exact @comforge/core@0.2.0
```

The npm package is a verified Git release's `LICENSE`, `README.md`, `llms.txt`, `package.json` and `dist/`, byte for byte except the manifest (`private` removed, `repository` added). Versions published from the release workflow carry npm provenance naming the release tag and commit.

Or pin a Git release by its **commit** on the `releases/core` branch (the tag names it; a commit cannot be moved, a tag can). The repository is public, so no credential is needed:

```json
"dependencies": {
  "@comforge/core": "git+https://github.com/vikramrao1994/comforge.git#<release commit>"
}
```

npm and Bun both lock that commit. Each release's `RELEASE.json` lists the SHA-256 of every file, so you can check what was installed.

Or build the distribution tarball from the source repository, then install it offline wherever you need it:

```sh
bun run factory-core:pack --out ./artifacts       # → artifacts/comforge-core-0.2.0.tgz
npm install ./artifacts/comforge-core-0.2.0.tgz zod@^4.6.6
```

- **Requirements:** the only runtime dependency is `zod` 4. Type declarations reference `node:buffer` and `node:crypto`, so TypeScript consumers need `@types/node` (or Bun's types).
- **Module format:** ESM only.
- **Imports:** import by package name (`import { … } from "@comforge/core"`), or through a subpath: `@comforge/core/specification`, `/grant`, `/receipt`, `/review`, `/completion` or `/lifecycle`.

A complete, runnable consumer lives in [`examples/core-consumer`](../../examples/core-consumer). Every code block below is copied from it, and a test fails if they drift.

## Quick start

1. **Configure your identity once, in committed code.** Each protocol is created from trusted, explicit configuration, and there are no defaults for identity:

<!-- example: examples/core-consumer/src/identity.ts#identity -->
```ts
import {
  createCompletionProtocol,
  createGrantProtocol,
  createReceiptProtocol,
  createReviewProtocol,
  createSpecificationProtocol,
} from "@comforge/core";

// Your project's identity. These values are yours to choose, and they are trusted
// configuration: keep them in committed code, never read them from an issue, a
// comment, an agent's output or a grant. Each scheme is part of a digest or a signed
// payload, so changing one later makes earlier records unverifiable.
export const REPOSITORY = "acme/widgets";
export const TICKET_PATTERN = /^ACME-[0-9]+$/;
export const branchForTicket = (ticket: string) => `agent/${ticket.toLowerCase()}`;

export const specifications = createSpecificationProtocol({
  digestScheme: "acme-engineering-spec/v1",
  markerNamespace: "acme-factory",
  publisherName: "Acme Factory",
  publishToolName: "publish_specification",
});

export const grants = createGrantProtocol({
  grantScheme: "acme-engineering-grant/v1",
  repository: REPOSITORY,
  ticketPattern: TICKET_PATTERN,
  branchForTicket,
});

export const receipts = createReceiptProtocol({
  receiptScheme: "acme-engineering-receipt/v1",
  repository: REPOSITORY,
});

export const reviews = createReviewProtocol({
  reviewScheme: "acme-engineering-review/v1",
  repository: REPOSITORY,
  markerNamespace: "acme-factory",
  publisherName: "Acme Factory",
  publishToolName: "post_review",
  ticketPattern: TICKET_PATTERN,
  limits: {
    summaryMaxChars: 2000,
    findingsMax: 20,
    findingTitleMaxChars: 120,
    findingTextMaxChars: 2000,
    notesMax: 10,
    noteMaxChars: 500,
  },
});

export const completions = createCompletionProtocol({
  completionScheme: "acme-engineering-completion/v1",
  repository: REPOSITORY,
  markerNamespace: "acme-records",
  ticketPattern: TICKET_PATTERN,
  reservedMarkerPrefixes: ["acme-factory:", "acme-records:"],
  runner: { id: "acme-runner", label: "Acme Runner" },
  publishCommand: "make complete",
  links: {
    comment: (issue, id) => `https://forge.example.invalid/acme/widgets/issues/${issue}#c${id}`,
    blob: (commit, path) => `https://forge.example.invalid/acme/widgets/blob/${commit}/${path}`,
  },
  // Your secret detector. The kernel only sees its verdict, never the secret.
  redact: (value) =>
    /ACME_TOKEN=[A-Za-z0-9]{12,}/.test(value)
      ? { count: 1, kinds: ["acme-token"] }
      : { count: 0, kinds: [] },
});
```

   Configure only the protocols you use; they are independent.

   Invalid configuration throws a `TypeError` at construction, for example `factory-core: invalid grant protocol grantScheme`. The configuration rules:
   - schemes match `name/vN`;
   - repositories are `owner/name`;
   - marker namespaces are lowercase;
   - `reservedMarkerPrefixes` must include `<markerNamespace>:`.

2. **Verify a published specification** (`specificationDigest`, `composeIssueBody`, `verifyPublishedSpecification`):

<!-- example: examples/core-consumer/src/flows.ts#specification -->
```ts
const spec = {
  ticketId: TICKET,
  title: "Rate-limit the export endpoint",
  body: "## Objective\n\nReturn 429 after 10 requests per minute.\n",
};
const digest = specifications.specificationDigest(spec);
const issueBody = specifications.composeIssueBody({
  ticketId: spec.ticketId,
  body: spec.body,
  digest,
  keyDigest: idempotencyKeyDigest("acme-spec-key-0001"),
});
// Later, read the issue back from your forge and verify it.
const verified = specifications.verifyPublishedSpecification({
  title: spec.title,
  body: issueBody,
});
// verified: { ticketId: "ACME-101", digest, digestScheme, digestMatches: true }
const edited = specifications.verifyPublishedSpecification({
  title: spec.title,
  body: issueBody.replace("10 requests", "1000 requests"),
});
// edited?.digestMatches === false: the specification changed after publication.
```

   The marker's ticket grammar is fixed to `A-Z`, `0-9` and `-`. A valid digest proves the text is unaltered; it does not prove who published it.

## Tasks

### Authorize an action with a signed grant

<!-- example: examples/core-consumer/src/flows.ts#authorize -->
```ts
// Trusted keys come from your own configuration, never from the envelope.
const trustedKeys = [trusted(owner, "owner")];
const context = {
  ticket: TICKET,
  issue: ISSUE,
  specification: liveSpecification, // verified from the issue you just fetched
  revoked: false, // from your own revocation list
  attemptsUsed: 0, // from your own ledger
  baseSha: BASE,
};
const granted = grants.authorizeAction(
  implementation,
  trustedKeys,
  { ...context, action: "launch-session" },
  NOW,
);
// An implementation grant never authorizes publication; that needs its own grant.
const refused = refusal(() =>
  grants.authorizeAction(implementation, trustedKeys, { ...context, action: "publish", candidateSha: CANDIDATE, branch: "agent/acme-101" }, NOW),
);
// refused === "unauthorized: A implementation grant does not authorize publish"
```

- **Modes and actions** (`GRANT_MODES`, `ACTIONS`, `ACTION_MODES`): `audit`, `implementation`, `validation`, `publication`, `revision`. Only a `publication` grant authorizes the `publish` action. `merge`, `release` and `deploy` (`PROHIBITED_MODES`) are refused even when signed.
- **`verifyEnvelope`:** checks the signature, schema, trusted key, repository and validity window. It says nothing about any action.
- **`authorizeAction`:** checks the envelope, then the action, ticket, specification, attempts, base, candidate, branch and revision bindings.
- **`requireCapability`:** checks an extra capability, such as `modify-workflows`.
- **Time:** you pass `now`. The kernel reads no clock.

### Authorize a command (signed command scopes)

`authorizeCommand(envelope, trustedKeys, context, now)` decides one remote effect of a lifecycle tool. The vocabulary is `COMMANDS`, scope version `COMMAND_SCOPE_VERSION` (1):

| Command | Authorized by | Bound to |
|---|---|---|
| `publish`, `complete`, `deliver`, `recover` (`PUBLICATION_COMMANDS`) | a `publication` grant. Without a `scope` it authorizes all four, as in 0.1; with a `scope` only the listed ones | ticket, issue, unedited specification digest, base, candidate commit, branch |
| `cleanup` | a `command` grant scoping exactly `{ command: "cleanup", pullRequest, mergedHead }` | ticket, issue, specification, base, the merged PR and the head that merged, the ticket's branch |
| `publish-specification` | a `command` grant scoping `{ command: "publish-specification", target: { kind: "new" } \| { kind: "issue", number } }` | the ticket and digest of the specification being published, and its destination (a new issue has no `issue` field) |
| `publish-review` | a `command` grant scoping `{ command: "publish-review", pullRequest, reviewedHead, reviewDigest? }` | the reviewed ticket's specification, the open PR, its exact current head, the review's digest when named |

- **Never by omission.** A grant without a scope never authorizes `cleanup`, `publish-specification` or `publish-review` (`SCOPED_ONLY_COMMANDS`). A `command` grant scopes exactly one of them, so a destructive grant is never shared with another command (`DESTRUCTIVE_COMMANDS`).
- **No widening.** `authorizeAction` refuses a grant that carries a scope; only `authorizeCommand` reads it. A 0.1 verifier refuses a scoped grant at its schema (it cannot enforce the narrowing), and a scope-less 0.1 grant verifies unchanged: its signing bytes are the same.
- **The caller still owns state.** Revocation (`revoked`) and the attempts already spent (`attemptsUsed`) come from your ledger; spend an attempt atomically after an `allow`.

### Sign a grant (the owner's side, never the agent's)

The kernel verifies and never signs. Whoever holds the owner key signs the protocol's exact `signingBytes` with Ed25519 and base64url-encodes the signature:

<!-- example: examples/core-consumer/src/testSigner.ts#sign-grant -->
```ts
/** The owner's side: sign the protocol's exact signing bytes, base64url-encoded. */
export function signGrant(grant: Grant, key: TestKey) {
  return {
    grant,
    keyId: key.keyId,
    signature: sign(null, grants.signingBytes(grant), key.privateKey).toString("base64url"),
  };
}
```

- **Receipts:** a validation controller signs them the same way, over `receipts.signingBytes(receipt)`.
- **Key ids:** `keyIdFor(publicKeyPem)` is the key id both formats use.
- **Building a payload:** validate it with the protocol's `grantSchema` or `receiptSchema` first.
- **Key custody:** keep signing keys out of the agent's reach. A key the agent can read proves nothing.

### Verify a validation receipt

<!-- example: examples/core-consumer/src/flows.ts#verify-receipt -->
```ts
const expectation = {
  ticket: TICKET,
  specDigest,
  candidateSha: CANDIDATE, // the commit you are about to publish, from your Git
  tree: TREE,
  controllerRevision: BASE, // the validation controller revision you trust
  now: NOW,
};
const verifiedReceipt = receipts.verifyReceipt(receipt, controller.publicKeyPem, expectation);
// verifiedReceipt.outcome === "PASS"; any other commit, key or outcome throws.
```

`verifyReceipt` takes the controller's single public key, while grants take a list of trusted keys. A receipt is refused when it is:

- forged or altered;
- from another key or repository;
- for another ticket, specification, commit or tree;
- from another controller revision;
- older than `RECEIPT_MAX_AGE_MS`;
- anything but PASS, or a record of an integrity failure.

### Evaluate a lifecycle step

<!-- example: examples/core-consumer/src/flows.ts#lifecycle -->
```ts
const decision = evaluateLifecycleAction({
  action: "publish",
  evidence: {
    head: CANDIDATE,
    validations: [
      { commit: CANDIDATE, status: "FAIL" },
      { commit: CANDIDATE, status: "PASS" }, // the latest validation of this commit decides
    ],
  },
});
if (decision.decision === "allow") {
  // decision.scope says what this allow means, and that it does not authorize publication.
} else {
  // "deny": the evidence breaks a rule. "insufficient_evidence": something required is
  // missing. Never treat either as an allow.
  for (const reason of decision.reasons) console.error(reason.code, reason.message);
}
```

| Action (`LIFECYCLE_ACTIONS`) | Decides | Evidence you observe |
|---|---|---|
| `publish` | the latest validation of exactly `head` is PASS | `head`, `validations[]` (oldest first) |
| `publication-target` | a push would not force-push, and would not reopen or duplicate a pull request | `head`, `remoteSha`, `remoteIsAncestor` (when the remote exists), `pullRequests[]`, `baseBranch` |
| `pull-request-handoff` | the PR read back is open, at `head`, ready and assigned as requested | `head`, `pullRequest`, `requireReady`, `assignee` |
| `complete` | a completion record's PR was validated and published at its head | `issueType`, `outcome`, `head`, `ticketBranch`, `repository`, `pullRequest`, `ledger` |
| `deliver` | whether a result is delivered with a PR, and which revision it describes | `issueType`, `outcome`, `head`, `baseSha`, `sourceRevision?`, `withoutPullRequest` |

The lifecycle `publish` action is a consistency check. The grant `publish` action is an authorization. They are separate questions with the same name.

### Read a review and a completion record

<!-- example: examples/core-consumer/src/flows.ts#review -->
```ts
const marker = reviews.parseReviewMarker(commentBody); // null if the comment has none
const review = marker ? reviews.decodeReview(marker) : null;
// review.integrity: "verified" | "mismatch" | "unreadable". Verified means unaltered, not trusted.
const currentHead = MOVED_HEAD; // read from your forge now, never from the review
const stale = marker ? isReviewStale(marker.headSha, currentHead) : true;
// The author is the one your forge reports for the comment, checked against your own list.
const provenance = reviewProvenance("acme-reviewer", ["acme-reviewer"]);
```

<!-- example: examples/core-consumer/src/flows.ts#completion -->
```ts
const completionMarker = completions.parseCompletionMarker(completionBody);
const completion = completionMarker ? completions.decodeCompletion(completionMarker) : null;
// completion.integrity === "verified"; completion.payload holds the structured result.
```

- **Unkeyed markers:** markers are not signed, so anyone who can comment can write one. `verified` integrity means unaltered and self-consistent.
- **Choosing the current record:** which record is current (by author, by supersession) is your policy over your forge's data.
- **Model-written text:** `completions.contentProblems(input)` and `reviews.containsReservedMarker(input)` reject hidden content, forged markers, local paths, secrets and mentions before anything is published.

## Decisions and errors

The kernel reports refusals in three shapes, each matching what it checks:

| Shape | Where | Meaning |
|---|---|---|
| throws `FactoryCoreError` with `code: "unauthorized"` | `verifyEnvelope`, `authorizeAction`, `requireCapability` | the grant does not authorize this. `message` names the first failed binding; `detail` is structured |
| throws `FactoryCoreError` with `code: "validation_failed"` | `verifyReceipt` | the receipt does not prove a PASS of the expected commit |
| returns `{ decision, reasons[] }` | `evaluateLifecycleAction` | `deny` or `insufficient_evidence`, with stable `code`s (`LIFECYCLE_REASONS`). It never throws for bad input: missing evidence is `insufficient_evidence`, malformed evidence and unknown actions are `deny` |
| returns `integrity: "verified" \| "mismatch" \| "unreadable"` | `decodeReview`, `decodeCompletion`, `verifyPublishedSpecification` (`digestMatches`) | the record's own integrity under your scheme |
| throws `TypeError` | `create*Protocol` | your configuration is invalid (a programming error, not a refusal) |

## Stability

These are frozen by golden vectors in the source repository (the portfolio that develops this package; it is not public). A change to any of them is a new scheme version, never an edit:

- the digest schemes;
- the marker formats;
- the canonical JSON (`canonicalJson`);
- the signing bytes (`<scheme>\n` + canonical JSON);
- the key ids (`keyIdFor`).

## Export reference

- **Protocols:** `createSpecificationProtocol`, `createGrantProtocol`, `createReceiptProtocol`, `createReviewProtocol`, `createCompletionProtocol`.
- **Decisions and helpers:** `evaluateLifecycleAction`, `isReviewStale`, `reviewProvenance`, `requireCapability`, `deriveDisposition`, `idempotencyKeyDigest`, `canonicalJson`, `canonicalTitle`, `canonicalBody`, `keyIdFor`, `envelopeDigest`.
- **Errors and schemas:** `FactoryCoreError`, `EnvelopeSchema`.
- **Vocabularies and limits:**
  - authorization: `GRANT_MODES`, `PROHIBITED_MODES`, `ACTIONS`, `ACTION_MODES`, `CAPABILITIES`, `CLOCK_SKEW_MS`, `MAX_GRANT_LIFETIME_MS`, `RECEIPT_MAX_AGE_MS`;
  - command scopes: `COMMANDS`, `COMMAND_SCOPE_VERSION`, `PUBLICATION_COMMANDS`, `SCOPED_ONLY_COMMANDS`, `DESTRUCTIVE_COMMANDS`;
  - lifecycle: `LIFECYCLE_ACTIONS`, `LIFECYCLE_DECISIONS`, `LIFECYCLE_REASONS`;
  - reviews: `REVIEW_VERDICTS`, `FINDING_SEVERITIES`, `FINDING_ID_PATTERN`, `ADVISORY_REVIEW_NOTICE`;
  - completion records: `ISSUE_TYPES`, `ISSUE_TYPE_MATRIX`, `OUTCOMES`, `DISPOSITIONS`, `CONFIDENCES`, `GATE_STATUSES`, `SECTION_KEYS`, `COMPLETION_LIMITS`, `COMPLETION_NOTICE`.

All types (`Grant`, `Receipt`, `TrustedKey`, `LifecycleDecision`, `CompletionPayload` and the others) are exported alongside them.

## Not included, on purpose

- **Excluded by design:**
  - a forge client;
  - a signer or key generator;
  - a CLI;
  - a hosted service;
  - an agent runner;
  - any implicit authority.
- **Interactive validation records and interactive authorization are not closed by this library.** A record signed by a key the agent can read, or a check inside a command the agent can bypass, proves nothing. Closing them needs a separate trust domain (an account the agent cannot act as), not more code here.

## License

Licensed under the [Apache License, Version 2.0](LICENSE). The release ships the unmodified licence text; the only runtime dependency, `zod`, is installed from its own package under its own licence, not bundled.
