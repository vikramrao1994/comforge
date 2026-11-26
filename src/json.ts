/**
 * Deterministic JSON: object keys sorted at every level, two-space indentation, a final
 * newline. The same result always prints the same bytes, so agents and tests can compare
 * outputs directly.
 */
export function stableJson(value: unknown): string {
  return `${JSON.stringify(sortKeys(value), null, 2)}\n`;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort())
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    return out;
  }
  return value;
}

/** Canonical form for equality checks (no indentation). */
export const canonical = (value: unknown): string => JSON.stringify(sortKeys(value));
