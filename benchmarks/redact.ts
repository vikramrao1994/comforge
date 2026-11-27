/**
 * Cost: none — pure string handling
 *
 * Redaction and the child-environment allowlist. A result never contains an environment value,
 * a token or an absolute home or run path; the child process never inherits the parent's secrets.
 */
import path from "node:path";

/** Variables a child may inherit by name. Everything else is dropped unless passed explicitly. */
export const ENV_ALLOWLIST = ["PATH", "LANG", "LC_ALL", "TZ"] as const;
/** The only credentials a client process may receive, and only when the owner approved them. */
export const CLIENT_CREDENTIAL_VARS = ["ANTHROPIC_API_KEY"] as const;

/** A complete environment for a child process; always defined, so the type is ProcessEnv. */
export type ChildEnv = NodeJS.ProcessEnv;

export interface ChildEnvOptions {
  home: string;
  /** Explicit extra variables (synthetic tokens, ports). Values are the caller's responsibility. */
  extra?: Record<string, string>;
  /** Names of client credentials to copy from `source`; each must be in CLIENT_CREDENTIAL_VARS. */
  clientCredentials?: string[];
  source?: Record<string, string | undefined>;
}

export function buildChildEnv(opts: ChildEnvOptions): ChildEnv {
  const source = opts.source ?? process.env;
  const env: Record<string, string> = {};
  for (const k of ENV_ALLOWLIST) if (source[k] !== undefined) env[k] = source[k] as string;
  Object.assign(env, {
    HOME: opts.home,
    TMPDIR: path.join(opts.home, "tmp"),
    GIT_CONFIG_GLOBAL: path.join(opts.home, "gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "Agent",
    GIT_AUTHOR_EMAIL: "agent@example.invalid",
    GIT_COMMITTER_NAME: "Agent",
    GIT_COMMITTER_EMAIL: "agent@example.invalid",
    NODE_ENV: "test",
  });
  for (const name of opts.clientCredentials ?? []) {
    if (!(CLIENT_CREDENTIAL_VARS as readonly string[]).includes(name))
      throw new Error(`credential ${name} is not an allowed client credential`);
    const v = source[name];
    if (v === undefined || v === "") throw new Error(`client credential ${name} is not set`);
    env[name] = v;
  }
  Object.assign(env, opts.extra ?? {});
  return env as unknown as ChildEnv;
}

const TOKEN_PATTERNS: RegExp[] = [
  /\bgh[pousr]_[A-Za-z0-9_]{16,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bsk-ant-[A-Za-z0-9_-]{8,}/g,
  /\bsk-[A-Za-z0-9]{20,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];
const HOME_PATTERNS: RegExp[] = [
  /\/Users\/[^/\s"']+/g,
  /\/home\/[^/\s"']+/g,
  /C:\\Users\\[^\\\s"']+/g,
];

export interface RedactionContext {
  /** Environment whose values (>= 8 chars) must never appear in output. */
  env?: Record<string, string | undefined>;
  /** Absolute directories to replace with a placeholder, longest first. */
  roots?: Record<string, string>;
}

export function redactText(text: string, ctx: RedactionContext = {}): string {
  let out = text;
  const roots = Object.entries(ctx.roots ?? {}).sort((a, b) => b[0].length - a[0].length);
  for (const [dir, label] of roots) if (dir.length > 1) out = out.split(dir).join(label);
  for (const v of Object.values(ctx.env ?? {}))
    if (typeof v === "string" && v.length >= 8 && !v.includes("\n"))
      out = out.split(v).join("[env]");
  for (const re of TOKEN_PATTERNS) out = out.replace(re, "[secret]");
  for (const re of HOME_PATTERNS) out = out.replace(re, "~");
  return out;
}

export function redactDeep<T>(value: T, ctx: RedactionContext = {}): T {
  if (typeof value === "string") return redactText(value, ctx) as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, ctx)) as T;
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v, ctx)])) as T;
  return value;
}

/** Throws when serialized output still contains a forbidden literal or a token/home pattern. */
export function assertRedacted(value: unknown, forbidden: string[] = []): void {
  const text = JSON.stringify(value);
  for (const f of forbidden)
    if (f.length >= 4 && text.includes(f)) throw new Error("result contains a forbidden value");
  for (const re of [...TOKEN_PATTERNS, ...HOME_PATTERNS]) {
    re.lastIndex = 0;
    if (re.test(text)) throw new Error(`result matches redaction pattern ${re}`);
  }
}
