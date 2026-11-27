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

/** The same deterministic JSON on one line: `--compact` (fewer bytes and tokens, same content). */
export const compactJson = (value: unknown): string => `${canonical(value)}\n`;

/**
 * `--summary`: a bounded projection for a first look. Scalars stay; an array becomes its length
 * and at most its first item's scalar fields; an object becomes its scalar fields. Nothing is
 * invented and the full result is one call away without the flag (on-demand detail).
 */
export function summarize(value: Record<string, unknown>): Record<string, unknown> {
  const scalars = (o: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(o).filter(([, v]) => v === null || typeof v !== "object"));
  const out: Record<string, unknown> = { summary: true };
  for (const [key, v] of Object.entries(value)) {
    if (v === null || typeof v !== "object") out[key] = v;
    else if (Array.isArray(v)) {
      const first = v[0];
      out[key] = {
        count: v.length,
        ...(first !== null && typeof first === "object" && !Array.isArray(first)
          ? { first: scalars(first as Record<string, unknown>) }
          : {}),
      };
    } else out[key] = scalars(v as Record<string, unknown>);
  }
  return out;
}
