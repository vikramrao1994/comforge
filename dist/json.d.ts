/**
 * Deterministic JSON: object keys sorted at every level, two-space indentation, a final
 * newline. The same result always prints the same bytes, so agents and tests can compare
 * outputs directly.
 */
export declare function stableJson(value: unknown): string;
/** Canonical form for equality checks (no indentation). */
export declare const canonical: (value: unknown) => string;
