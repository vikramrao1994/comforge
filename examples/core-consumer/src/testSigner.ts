// TEST-ONLY signer. factory-core verifies signatures; it never creates keys or signs.
// In a real deployment the owner signs grants with a key the agent cannot read, and a
// trusted validation controller signs receipts with its own key. This file plays both
// roles with deterministic keys so the example produces the same output everywhere.
// Never use these keys, or this file, outside tests.
import { Buffer } from "node:buffer";
import { createPrivateKey, createPublicKey, type KeyObject, sign } from "node:crypto";
import { type Grant, keyIdFor, type Receipt, type TrustedKey } from "@comforge/core";
import { grants, receipts } from "./identity.ts";

// PKCS#8 DER prefix of an Ed25519 private key; the 32-byte seed follows it.
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

export interface TestKey {
  privateKey: KeyObject;
  publicKeyPem: string;
  keyId: string;
}

export function testKey(seedByte: number): TestKey {
  const privateKey = createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, Buffer.alloc(32, seedByte)]),
    format: "der",
    type: "pkcs8",
  });
  const publicKeyPem = createPublicKey(privateKey).export({ type: "spki", format: "pem" }).toString();
  return { privateKey, publicKeyPem, keyId: keyIdFor(publicKeyPem) };
}

export const trusted = (key: TestKey, label: string): TrustedKey => ({
  keyId: key.keyId,
  publicKeyPem: key.publicKeyPem,
  label,
});

// #region sign-grant
/** The owner's side: sign the protocol's exact signing bytes, base64url-encoded. */
export function signGrant(grant: Grant, key: TestKey) {
  return {
    grant,
    keyId: key.keyId,
    signature: sign(null, grants.signingBytes(grant), key.privateKey).toString("base64url"),
  };
}
// #endregion sign-grant

/** The validation controller's side: the same recipe over the receipt's signing bytes. */
export function signReceipt(receipt: Receipt, key: TestKey) {
  return {
    receipt,
    keyId: key.keyId,
    signature: sign(null, receipts.signingBytes(receipt), key.privateKey).toString("base64url"),
  };
}
