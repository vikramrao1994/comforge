/**
 * Validation of the trusted, construction-time identity values the review and
 * completion protocols embed in published comments. A value that fails is refused
 * at construction, so a protocol can never emit a marker its own parser rejects or
 * text that opens an HTML comment, inline code or a regular-expression construct.
 */
declare const PATTERNS: {
    readonly scheme: RegExp;
    readonly repository: RegExp;
    readonly markerNamespace: RegExp;
    readonly label: RegExp;
    readonly toolName: RegExp;
    readonly runnerId: RegExp;
    readonly command: RegExp;
};
export type IdentityKind = keyof typeof PATTERNS;
export declare function assertIdentity(protocol: string, field: string, kind: IdentityKind, value: unknown): void;
export declare function hasControlCharacter(value: string): boolean;
export {};
