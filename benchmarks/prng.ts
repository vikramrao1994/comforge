/**
 * Cost: none — deterministic seeded randomness
 */
import { createHash } from "node:crypto";

/** mulberry32 seeded from the sha256 of a string; the same seed always yields the same stream. */
export function rng(seed: string): () => number {
  let a = createHash("sha256").update(seed).digest().readUInt32LE(0);
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const randInt = (next: () => number, lo: number, hi: number) =>
  lo + Math.floor(next() * (hi - lo + 1));

export function shuffled<T>(items: readonly T[], seed: string): T[] {
  const next = rng(seed);
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

export const sha256 = (text: string | Uint8Array) =>
  createHash("sha256").update(text).digest("hex");

/** Stable JSON: keys sorted at every depth, so a digest does not depend on insertion order. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
