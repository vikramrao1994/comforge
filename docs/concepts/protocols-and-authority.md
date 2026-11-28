# Protocols and runtime authority

Status: published (`@comforge/core` 0.2.0; `@comforge/cli/protocols` and `/authority`, 0.5.0).

| Record | Contract | Where |
|---|---|---|
| Published specification | digest over the normalized body, marker comment, verification | `core/specification`, `cli/protocols` |
| Grant | Ed25519-signed, bound to repository, ticket, issue, specification digest, base, expiry and attempts | `core/grant`, `cli/authority` |
| Validation receipt | signed result of validation for an exact commit | `core/receipt`, `cli/authority` |
| Lifecycle decision | allow / deny / insufficient for each lifecycle action | `core/lifecycle` |
| Advisory review | marker-bound PR comment for an exact head, never an approval | `core/review`, `cli/protocols` |
| Completion record | one issue comment with digest, outcome, gates, evidence links | `core/completion`, `cli/protocols` |

**Compatibility profiles** (`createProtocolServices`) choose identity only — schemes, marker
namespaces, names and links — so records published under an older identity keep verifying byte
for byte. A profile cannot remove reserved marker prefixes or the built-in credential detector.

**Runtime authority** (`createRuntimeAuthority`) signs and verifies execution grants and
receipts for a host that runs work itself. It is separate from lifecycle grants: it refuses
command grants and grants without a specification issue, and refuses to exist under a scheme
named in `separateFrom`. Verification takes public keys per call; signing goes through a `Signer`.

## What `@comforge/core` can and cannot tell you

`@comforge/core` performs no I/O: no network, forge, filesystem, environment or clock access, and
it never creates keys or signs. You bring the observations and the trust; it decides consistently.
Each answer is only as trustworthy as the observation you pass in. Never pass issue or comment
text, an agent's output, or a record's own claim as an observation.

| It answers | It never answers |
|---|---|
| Is this specification unaltered since it was published under your digest scheme? | Who wrote it, or whether anyone approved it |
| Is this grant signed by a key you trust, unexpired, and bound to this ticket, specification, base, commit and action? | Whether a human should still want this. Revocation and attempt counts come from your own ledger |
| Is this receipt a signed PASS of exactly this commit and tree by your validation controller? | Whether the validation was meaningful, or whether the commit changed its own tests |
| Is this review or completion record unaltered, and does it match its PR, head, ticket and issue? | Whether its author is trusted. You pass the author your forge reports to `reviewProvenance` |
| Is a lifecycle step consistent with the evidence you supplied? | Whether it is authorized. An `allow` grants nothing; merge, release and deploy are never actions |

## Configuring identity

Each protocol is created from trusted, explicit configuration, and there are no defaults for
identity. Keep the values in committed code, never read them from an issue, a comment, an agent's
output or a grant. Each scheme is part of a digest or a signed payload, so changing one later makes
earlier records unverifiable. Configure only the protocols you use; they are independent. Invalid
configuration throws a `TypeError` at construction. The rules: schemes match `name/vN`;
repositories are `owner/name`; marker namespaces are lowercase; `reservedMarkerPrefixes` must
include `<markerNamespace>:`. The marker's ticket grammar is fixed to `A-Z`, `0-9` and `-`. A valid
digest proves the text is unaltered; it does not prove who published it. A complete configuration
of all five protocols is in
[`examples/core-consumer/src/identity.ts`](../../examples/core-consumer/src/identity.ts).

## Grants and command scopes

- **Modes and actions** (`GRANT_MODES`, `ACTIONS`, `ACTION_MODES`): `audit`, `implementation`,
  `validation`, `publication`, `revision`. Only a `publication` grant authorizes the `publish`
  action. `merge`, `release` and `deploy` (`PROHIBITED_MODES`) are refused even when signed.
- **`verifyEnvelope`** checks the signature, schema, trusted key, repository and validity window.
  It says nothing about any action. **`authorizeAction`** checks the envelope, then the action,
  ticket, specification, attempts, base, candidate, branch and revision bindings.
  **`requireCapability`** checks an extra capability, such as `modify-workflows`. You pass `now`;
  the kernel reads no clock.
- **Signing** is the owner's side: sign the protocol's exact `signingBytes` with Ed25519 and
  base64url-encode the signature. A validation controller signs receipts the same way, over
  `receipts.signingBytes(receipt)`. `keyIdFor(publicKeyPem)` is the key id both formats use.
  Validate a payload with `grantSchema` or `receiptSchema` first. Keep signing keys out of the
  agent's reach: a key the agent can read proves nothing.
- **Receipts.** `verifyReceipt` takes the controller's single public key, while grants take a list
  of trusted keys. A receipt is refused when it is forged or altered, from another key or
  repository, for another ticket, specification, commit or tree, from another controller revision,
  older than `RECEIPT_MAX_AGE_MS`, or anything but PASS or a record of an integrity failure.

`authorizeCommand(envelope, trustedKeys, context, now)` decides one remote effect of a lifecycle
tool. The vocabulary is `COMMANDS`, scope version `COMMAND_SCOPE_VERSION` (1):

| Command | Authorized by | Bound to |
|---|---|---|
| `publish`, `complete`, `deliver`, `recover` (`PUBLICATION_COMMANDS`) | a `publication` grant. Without a `scope` it authorizes all four; with a `scope` only the listed ones | ticket, issue, unedited specification digest, base, candidate commit, branch |
| `cleanup` | a `command` grant scoping exactly `{ command: "cleanup", pullRequest, mergedHead }` | ticket, issue, specification, base, the merged PR and the head that merged, the ticket's branch |
| `publish-specification` | a `command` grant scoping `{ command: "publish-specification", target: { kind: "new" } \| { kind: "issue", number } }` | the ticket and digest of the specification being published, and its destination |
| `publish-review` | a `command` grant scoping `{ command: "publish-review", pullRequest, reviewedHead, reviewDigest? }` | the reviewed ticket's specification, the open PR, its exact current head, the review's digest when named |

- **Never by omission.** A grant without a scope never authorizes `cleanup`,
  `publish-specification` or `publish-review` (`SCOPED_ONLY_COMMANDS`). A `command` grant scopes
  exactly one of them, so a destructive grant is never shared with another command
  (`DESTRUCTIVE_COMMANDS`).
- **No widening.** `authorizeAction` refuses a grant that carries a scope; only `authorizeCommand`
  reads it. An earlier verifier refuses a scoped grant at its schema (it cannot enforce the
  narrowing), and a scope-less grant of the first release verifies unchanged: its signing bytes are
  the same.
- **The caller still owns state.** Revocation (`revoked`) and the attempts already spent
  (`attemptsUsed`) come from your ledger; spend an attempt atomically after an `allow`.

## Lifecycle decisions

`evaluateLifecycleAction({ action, evidence })` returns `{ decision, reasons[] }`. It never throws
for bad input: missing evidence is `insufficient_evidence`, malformed evidence and unknown actions
are `deny`.

| Action (`LIFECYCLE_ACTIONS`) | Decides | Evidence you observe |
|---|---|---|
| `publish` | the latest validation of exactly `head` is PASS | `head`, `validations[]` (oldest first) |
| `publication-target` | a push would not force-push, and would not reopen or duplicate a pull request | `head`, `remoteSha`, `remoteIsAncestor` (when the remote exists), `pullRequests[]`, `baseBranch` |
| `pull-request-handoff` | the PR read back is open, at `head`, ready and assigned as requested | `head`, `pullRequest`, `requireReady`, `assignee` |
| `complete` | a completion record's PR was validated and published at its head | `issueType`, `outcome`, `head`, `ticketBranch`, `repository`, `pullRequest`, `ledger` |
| `deliver` | whether a result is delivered with a PR, and which revision it describes | `issueType`, `outcome`, `head`, `baseSha`, `sourceRevision?`, `withoutPullRequest` |

The lifecycle `publish` action is a consistency check. The grant `publish` action is an
authorization. They are separate questions with the same name.

## Reviews, completions and refusal shapes

- **Unkeyed markers.** Review and completion markers are not signed, so anyone who can comment can
  write one. `verified` integrity means unaltered and self-consistent, not trusted. Which record is
  current (by author, by supersession) is your policy over your forge's data.
- **Model-written text.** `completions.contentProblems(input)` and `reviews.containsReservedMarker(input)`
  reject hidden content, forged markers, local paths, secrets and mentions before anything is
  published.

| Shape | Where | Meaning |
|---|---|---|
| throws `FactoryCoreError` with `code: "unauthorized"` | `verifyEnvelope`, `authorizeAction`, `requireCapability` | the grant does not authorize this; `message` names the first failed binding, `detail` is structured |
| throws `FactoryCoreError` with `code: "validation_failed"` | `verifyReceipt` | the receipt does not prove a PASS of the expected commit |
| returns `{ decision, reasons[] }` | `evaluateLifecycleAction` | `deny` or `insufficient_evidence`, with stable `code`s (`LIFECYCLE_REASONS`) |
| returns `integrity: "verified" \| "mismatch" \| "unreadable"` | `decodeReview`, `decodeCompletion`, `verifyPublishedSpecification` (`digestMatches`) | the record's own integrity under your scheme |
| throws `TypeError` | `create*Protocol` | your configuration is invalid (a programming error, not a refusal) |

## Stability and exclusions

The digest schemes, the marker formats, the canonical JSON (`canonicalJson`), the signing bytes
(`<scheme>\n` + canonical JSON) and the key ids (`keyIdFor`) are frozen by golden vectors in the
source repository. A change to any of them is a new scheme version, never an edit.

By design the library includes no forge client, signer or key generator, CLI, hosted service,
agent runner or implicit authority. Interactive validation records and interactive authorization are
not closed by this library: a record signed by a key the agent can read, or a check inside a command
the agent can bypass, proves nothing. Closing them needs a separate trust domain (an account the
agent cannot act as), not more code here.

## Packaging

The npm package is a verified release's `LICENSE`, `README.md`, `llms.txt`, `package.json` and
`dist/`, byte for byte except the manifest. Versions published from the release workflow carry npm
provenance naming the release tag and commit. The only runtime dependency is `zod` 4; type
declarations reference `node:buffer` and `node:crypto`, so TypeScript consumers need `@types/node`
(or Bun's types). The package is ESM only. Node does not strip types under `node_modules`
(`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), so use the compiled package, not workspace source.
