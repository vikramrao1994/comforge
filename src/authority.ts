/**
 * `@comforge/cli/authority`: signed execution grants and validation receipts for a host that runs
 * work itself (an execution runtime, a validation controller).
 *
 * This is a separate authority from the lifecycle's own grants (`comforge grant`, command
 * scopes). The two never translate into each other:
 * - a runtime authority is constructed under its own schemes and refuses to be constructed
 *   under a scheme named in `separateFrom`;
 * - it refuses every command grant and every grant without a specification issue, whatever
 *   signed it, so a lifecycle authorization can never start an execution;
 * - trusted keys are passed per call by the host. Nothing here reads a key from a
 *   configuration, a file or the environment, and no key is shared with the lifecycle.
 *
 * Verification needs public keys only. Signing goes through a `Signer` the host supplies, so
 * the process that verifies (an agent, a supervisor) never needs the private key.
 */
import { createPrivateKey, createPublicKey, sign as nodeSign } from "node:crypto";
import {
  ACTION_MODES,
  ACTIONS,
  type ActionContext,
  CAPABILITIES,
  type Capability,
  CLOCK_SKEW_MS,
  canonicalJson,
  createGrantProtocol,
  createReceiptProtocol,
  EnvelopeSchema,
  envelopeDigest,
  FactoryCoreError,
  GRANT_MODES,
  type Grant,
  type GrantMode,
  type GrantSchemaType,
  keyIdFor,
  MAX_GRANT_LIFETIME_MS,
  PROHIBITED_MODES,
  RECEIPT_MAX_AGE_MS,
  type Receipt,
  type ReceiptExpectation,
  type ReceiptSchemaType,
  type RuntimeAction,
  requireCapability,
  type SignedReceipt,
  type TrustedKey,
} from "@comforge/core";

export const RUNTIME_AUTHORITY_SCHEMA = "comforge-runtime-authority/v1" as const;

export type AuthorityErrorCode = "unauthorized" | "validation_failed";

/** The one refusal an authority throws; the message names the first binding that failed. */
export class AuthorityError extends Error {
  readonly code: AuthorityErrorCode;
  readonly detail: Record<string, unknown> | undefined;

  constructor(code: AuthorityErrorCode, message: string, detail?: Record<string, unknown>) {
    super(message);
    this.name = "AuthorityError";
    this.code = code;
    this.detail = detail;
  }
}

/** Signs exact bytes with one Ed25519 key. Lives only where that key lives. */
export interface Signer {
  readonly publicKeyPem: string;
  sign(bytes: Uint8Array): Uint8Array;
}

/** A signer over a PEM private key held in this process: for the owner's or controller's side. */
export function ed25519Signer(privateKeyPem: string): Signer {
  const key = createPrivateKey(privateKeyPem);
  if (key.asymmetricKeyType !== "ed25519")
    throw new TypeError("@comforge/cli/authority: the signing key must be Ed25519");
  const publicKeyPem = createPublicKey(key).export({ type: "spki", format: "pem" }).toString();
  return { publicKeyPem, sign: (bytes) => nodeSign(null, bytes, key) };
}

/** An execution grant: always bound to its published specification issue. */
export type RuntimeGrant = Grant & { issue: number };
export interface RuntimeGrantEnvelope {
  grant: RuntimeGrant;
  keyId: string;
  signature: string;
}

export interface RuntimeAuthorityOptions {
  /** The authority format. An unknown value is refused. */
  schema: typeof RUNTIME_AUTHORITY_SCHEMA;
  /** `owner/name`; a grant or receipt naming another repository never verifies. */
  repository: string;
  ticketPattern: RegExp;
  branchForTicket: (ticket: string) => string;
  grantScheme: string;
  receiptScheme: string;
  /**
   * Schemes of every other authority in this repository (the lifecycle's grant scheme). The
   * authority refuses to exist under one of them. Required, so the separation is stated.
   */
  separateFrom: readonly string[];
}

export interface RuntimeAuthority {
  readonly schema: typeof RUNTIME_AUTHORITY_SCHEMA;
  readonly repository: string;
  readonly grants: {
    readonly scheme: string;
    readonly schema: GrantSchemaType;
    /** Owner side: validates the fields as an execution grant and signs them. */
    issue(fields: unknown, signer: Signer): RuntimeGrantEnvelope;
    /** Signature, schema, trust and validity window. Says nothing about any action. */
    verify(raw: unknown, trusted: TrustedKey[], now: Date): RuntimeGrantEnvelope;
    /** The decision for one action; throws naming the first failed binding. */
    authorize(raw: unknown, trusted: TrustedKey[], context: ActionContext, now: Date): RuntimeGrant;
    requireCapability(grant: RuntimeGrant, capability: Capability, why: string): void;
    /** Stable identity of one signed envelope. */
    digest(envelope: RuntimeGrantEnvelope): string;
  };
  readonly receipts: {
    readonly scheme: string;
    readonly schema: ReceiptSchemaType;
    /** Controller side: validates the receipt and signs it. */
    seal(receipt: unknown, signer: Signer): SignedReceipt;
    /** Refuses anything but a current PASS receipt for exactly the expected commit and tree. */
    verify(raw: unknown, publicKeyPem: string, expect: ReceiptExpectation): Receipt;
  };
}

function refuse(message: string): never {
  throw new TypeError(`@comforge/cli/authority: ${message}`);
}

function guarded<T>(run: () => T): T {
  try {
    return run();
  } catch (error) {
    if (error instanceof FactoryCoreError)
      throw new AuthorityError(error.code, error.message, error.detail);
    throw error;
  }
}

export function createRuntimeAuthority(options: RuntimeAuthorityOptions): RuntimeAuthority {
  if (options?.schema !== RUNTIME_AUTHORITY_SCHEMA)
    refuse(`unsupported authority ${JSON.stringify(options?.schema)}`);
  if (!Array.isArray(options.separateFrom))
    refuse("separateFrom must list the schemes of every other authority (may be empty)");
  if (options.grantScheme === options.receiptScheme)
    refuse("grants and receipts need different schemes");
  for (const scheme of [options.grantScheme, options.receiptScheme])
    if (options.separateFrom.includes(scheme))
      refuse(`scheme ${scheme} belongs to another authority`);

  const grantProtocol = createGrantProtocol({
    grantScheme: options.grantScheme,
    repository: options.repository,
    ticketPattern: options.ticketPattern,
    branchForTicket: options.branchForTicket,
  });
  const receiptProtocol = createReceiptProtocol({
    receiptScheme: options.receiptScheme,
    repository: options.repository,
  });

  const executionOnly = (grant: Grant): RuntimeGrant => {
    if (grant.mode === "command" || typeof grant.issue !== "number")
      throw new AuthorityError(
        "unauthorized",
        "a command grant (or any grant without a specification issue) never authorizes a runtime execution",
        { mode: grant.mode },
      );
    return grant as RuntimeGrant;
  };

  return Object.freeze({
    schema: RUNTIME_AUTHORITY_SCHEMA,
    repository: options.repository,
    grants: Object.freeze({
      scheme: grantProtocol.scheme,
      schema: grantProtocol.grantSchema,
      issue(fields: unknown, signer: Signer) {
        const grant = executionOnly(grantProtocol.grantSchema.parse(fields));
        return {
          grant,
          keyId: keyIdFor(signer.publicKeyPem),
          signature: Buffer.from(signer.sign(grantProtocol.signingBytes(grant))).toString(
            "base64url",
          ),
        };
      },
      verify(raw: unknown, trusted: TrustedKey[], now: Date) {
        const envelope = guarded(() => grantProtocol.verifyEnvelope(raw, trusted, now));
        executionOnly(envelope.grant);
        return envelope as RuntimeGrantEnvelope;
      },
      authorize(raw: unknown, trusted: TrustedKey[], context: ActionContext, now: Date) {
        return executionOnly(
          guarded(() => grantProtocol.authorizeAction(raw, trusted, context, now)),
        );
      },
      requireCapability(grant: RuntimeGrant, capability: Capability, why: string) {
        guarded(() => requireCapability(grant, capability, why));
      },
      digest: (envelope: RuntimeGrantEnvelope) => envelopeDigest(envelope),
    }),
    receipts: Object.freeze({
      scheme: receiptProtocol.scheme,
      schema: receiptProtocol.receiptSchema,
      seal(receipt: unknown, signer: Signer) {
        const parsed = receiptProtocol.receiptSchema.parse(receipt);
        return {
          receipt: parsed,
          keyId: keyIdFor(signer.publicKeyPem),
          signature: Buffer.from(signer.sign(receiptProtocol.signingBytes(parsed))).toString(
            "base64url",
          ),
        };
      },
      verify(raw: unknown, publicKeyPem: string, expect: ReceiptExpectation) {
        return guarded(() => receiptProtocol.verifyReceipt(raw, publicKeyPem, expect));
      },
    }),
  });
}

/** Bounds every authority applies; fixed, not configurable. */
export const AUTHORITY_LIMITS = Object.freeze({
  clockSkewMs: CLOCK_SKEW_MS,
  maxGrantLifetimeMs: MAX_GRANT_LIFETIME_MS,
  receiptMaxAgeMs: RECEIPT_MAX_AGE_MS,
});

/**
 * What an execution grant can say: its modes, the modes that can never be granted, the actions
 * a host asks about, which modes authorize which action, and the capabilities.
 */
export const AUTHORITY_VOCABULARY = Object.freeze({
  grantModes: GRANT_MODES,
  prohibitedModes: PROHIBITED_MODES,
  actions: ACTIONS,
  actionModes: ACTION_MODES,
  capabilities: CAPABILITIES,
});

/** The shape of any signed grant envelope, before a scheme is applied. */
export const GrantEnvelopeSchema = EnvelopeSchema;

export { canonicalJson, keyIdFor };
export type {
  ActionContext,
  Capability,
  GrantMode,
  Receipt,
  ReceiptExpectation,
  RuntimeAction,
  SignedReceipt,
  TrustedKey,
};
