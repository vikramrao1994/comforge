import { createHash, createPublicKey } from "node:crypto";

/**
 * Deterministic JSON: object keys sorted by code unit, `undefined` members dropped,
 * arrays in order, no whitespace. Every signed grant and receipt is signed over this
 * form, so its output is a compatibility contract with records already signed.
 * An `undefined` array element serializes to nothing (`[undefined]` → `[]`).
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/** First 16 hex characters of the SHA-256 of a public key's SPKI DER encoding. */
export function keyIdFor(publicKeyPem: string): string {
  const der = createPublicKey(publicKeyPem).export({ type: "spki", format: "der" });
  return createHash("sha256").update(der).digest("hex").slice(0, 16);
}
