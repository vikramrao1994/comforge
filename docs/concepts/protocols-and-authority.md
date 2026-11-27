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
