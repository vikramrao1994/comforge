/**
 * Deterministic JSON: object keys sorted by code unit, `undefined` members dropped,
 * arrays in order, no whitespace. Every signed grant and receipt is signed over this
 * form, so its output is a compatibility contract with records already signed.
 * An `undefined` array element serializes to nothing (`[undefined]` → `[]`).
 */
export declare function canonicalJson(value: unknown): string;
/** First 16 hex characters of the SHA-256 of a public key's SPKI DER encoding. */
export declare function keyIdFor(publicKeyPem: string): string;
