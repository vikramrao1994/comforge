/**
 * Deterministic JSON: object keys sorted at every level, two-space indentation, a final
 * newline. The same result always prints the same bytes, so agents and tests can compare
 * outputs directly.
 */
export function stableJson(value) {
    return `${JSON.stringify(sortKeys(value), null, 2)}\n`;
}
function sortKeys(value) {
    if (Array.isArray(value))
        return value.map(sortKeys);
    if (value !== null && typeof value === "object") {
        const out = {};
        for (const key of Object.keys(value).sort())
            out[key] = sortKeys(value[key]);
        return out;
    }
    return value;
}
/** Canonical form for equality checks (no indentation). */
export const canonical = (value) => JSON.stringify(sortKeys(value));
