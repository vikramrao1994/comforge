<p align="center">
  <a href="https://github.com/vikramrao1994/comforge">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://github.com/vikramrao1994/comforge/raw/main/docs/assets/brand/comforge-logo-dark.svg">
      <img alt="Comforge" src="https://github.com/vikramrao1994/comforge/raw/main/docs/assets/brand/comforge-logo-light.svg" height="40">
    </picture>
  </a>
</p>

# @comforge/core

Lifecycle contracts and authorization for AI-assisted engineering: specifications, grants, receipts, lifecycle decisions, reviews and completion records, as a pure TypeScript library. It performs no I/O and never signs: you bring the observations and the trust, and it decides consistently.

[![npm](https://img.shields.io/npm/v/@comforge/core?label=npm&color=0b7285)](https://www.npmjs.com/package/@comforge/core)
[![CI](https://github.com/vikramrao1994/comforge/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/vikramrao1994/comforge/actions/workflows/ci.yml)
[![License](https://img.shields.io/npm/l/@comforge/core?color=0b7285)](https://github.com/vikramrao1994/comforge/blob/main/LICENSE)
[![Node](https://img.shields.io/node/v/@comforge/core?color=0b7285)](https://github.com/vikramrao1994/comforge/blob/main/docs/reference/compatibility.md)

## Install

```sh
npm install --save-exact @comforge/core      # or: bun add --exact @comforge/core
```

The only runtime dependency is `zod` 4. The package is ESM only and ships declarations. Import by package name, or through a subpath: `@comforge/core/specification`, `/grant`, `/receipt`, `/review`, `/completion` or `/lifecycle`.

## Quick example

Configure each protocol once, in committed code (the identity values are yours to choose and
are trusted configuration; the full configuration is in the
[walkthrough](https://github.com/vikramrao1994/comforge/blob/main/docs/reference/core.md)).
Then publish a specification and detect an edit after publication:

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

Evaluate a lifecycle step from evidence you observed (an `allow` grants nothing):

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

Both blocks are copied verbatim from the [runnable example](https://github.com/vikramrao1994/comforge/tree/main/examples/core-consumer),
which CI runs under Node.js and Bun. Signing, grants, receipts, reviews and completion records:
[walkthrough and export reference](https://github.com/vikramrao1994/comforge/blob/main/docs/reference/core.md).

## What it provides

| Export | Use |
|---|---|
| `createSpecificationProtocol` | Specification digests, issue bodies and verification of a published specification |
| `createGrantProtocol` | Verify owner-signed grants (`verifyEnvelope`, `authorizeAction`, `authorizeCommand`, `requireCapability`) |
| `createReceiptProtocol` | Verify a signed PASS of an exact commit and tree (`verifyReceipt`) |
| `createReviewProtocol` | Advisory pull request reviews: markers, integrity and decoding |
| `createCompletionProtocol` | Completion records: content rules, markers, integrity and decoding |
| `evaluateLifecycleAction` | A consistency decision (`allow`, `deny` or `insufficient_evidence`) for `publish`, `publication-target`, `pull-request-handoff`, `complete` or `deliver` |
| `isReviewStale`, `reviewProvenance` | Whether a review applies to the current head, and whether its author is on your list |
| `canonicalJson`, `keyIdFor`, `envelopeDigest`, `idempotencyKeyDigest` | The canonical encodings and digests the formats are built on |
| `FactoryCoreError`, `LIFECYCLE_REASONS`, `GRANT_MODES`, `COMMANDS` | The error type and the vocabularies |

An `allow` is never an authorization: merge, release and deploy are not actions, and a grant for one command is never valid for another. A verified marker means unaltered, not trusted. Wire formats are frozen: a change to a digest scheme, marker format, canonical JSON, signing bytes or key id is a new scheme version.

## Compatibility

- Node.js 22.18 or later, or Bun 1.4 or later. Use the compiled package: Node does not strip types under `node_modules`.
- TypeScript consumers need `@types/node` (or Bun's types), because declarations reference `node:buffer` and `node:crypto`.
- Wire formats are stable; the TypeScript API may still change before 1.0.

Details: [compatibility](https://github.com/vikramrao1994/comforge/blob/main/docs/reference/compatibility.md).

## Limitations

- It answers whether a record is unaltered, correctly signed and bound to the right ticket, commit and action. It never answers who wrote it, whether anyone approved it, or whether a validation was meaningful.
- Revocation, attempt counts and the choice of current record come from your own ledger and forge data.
- Interactive validation records and interactive authorization are not closed by this library: a key the agent can read proves nothing. That needs a separate trust domain.
- Excluded by design: a forge client, a signer or key generator, a CLI, a hosted service and an agent runner.

See [what core can and cannot tell you](https://github.com/vikramrao1994/comforge/blob/main/docs/concepts/protocols-and-authority.md#what-comforgecore-can-and-cannot-tell-you).

## Documentation

- [Repository README](https://github.com/vikramrao1994/comforge#readme)
- [Protocols and authority](https://github.com/vikramrao1994/comforge/blob/main/docs/concepts/protocols-and-authority.md), [API](https://github.com/vikramrao1994/comforge/blob/main/docs/reference/api.md), [authorization and trust](https://github.com/vikramrao1994/comforge/blob/main/docs/security/authorization-and-trust.md)
- [Recipes](https://github.com/vikramrao1994/comforge/tree/main/docs/recipes), including [owner grants](https://github.com/vikramrao1994/comforge/blob/main/docs/recipes/05-owner-grants.md)
- [Architecture](https://github.com/vikramrao1994/comforge/blob/main/docs/concepts/architecture.md)
- [Runnable example](https://github.com/vikramrao1994/comforge/tree/main/examples/core-consumer)
- [Changelog](https://github.com/vikramrao1994/comforge/blob/main/packages/core/CHANGELOG.md)
- [License (Apache-2.0)](https://github.com/vikramrao1994/comforge/blob/main/LICENSE)
