/**
 * Validation of the trusted, construction-time identity values the review and
 * completion protocols embed in published comments. A value that fails is refused
 * at construction, so a protocol can never emit a marker its own parser rejects or
 * text that opens an HTML comment, inline code or a regular-expression construct.
 */
const PATTERNS = {
    scheme: /^[a-z0-9][a-z0-9.-]{0,79}\/v[0-9]{1,4}$/,
    repository: /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/,
    // Literal inside a regular expression: letters, digits and `-` only.
    markerNamespace: /^[a-z][a-z0-9-]{0,39}$/,
    // A printable single line that cannot open or close an HTML comment or inline code.
    label: /^[A-Za-z0-9][A-Za-z0-9 .()-]{0,79}$/,
    toolName: /^[a-z][a-z0-9_]{0,63}$/,
    runnerId: /^[a-z][a-z0-9-]{0,63}$/,
    // A shell command line shown in inline code: no backtick, no HTML.
    command: /^[A-Za-z0-9][A-Za-z0-9 :./_-]{0,119}$/,
};
export function assertIdentity(protocol, field, kind, value) {
    if (typeof value !== "string" || !PATTERNS[kind].test(value))
        throw new TypeError(`factory-core: invalid ${protocol} protocol ${field}`);
}
export function hasControlCharacter(value) {
    for (const char of value) {
        const code = char.codePointAt(0) ?? 0;
        if (code < 0x20 || code === 0x7f)
            return true;
    }
    return false;
}
