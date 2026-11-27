/**
 * Deterministic JSON: object keys sorted at every level, two-space indentation, a final
 * newline. The same result always prints the same bytes, so agents and tests can compare
 * outputs directly.
 */
export declare function stableJson(value: unknown): string;
/** Canonical form for equality checks (no indentation). */
export declare const canonical: (value: unknown) => string;
/** The same deterministic JSON on one line: `--compact` (fewer bytes and tokens, same content). */
export declare const compactJson: (value: unknown) => string;
/**
 * `--summary`: a bounded projection for a first look. Scalars stay; an array becomes its length
 * and at most its first item's scalar fields; an object becomes its scalar fields. Nothing is
 * invented and the full result is one call away without the flag (on-demand detail).
 */
export declare function summarize(value: Record<string, unknown>): Record<string, unknown>;
