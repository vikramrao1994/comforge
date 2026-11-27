/**
 * Cost: none — parsers over text the harness is handed
 *
 * Collectors. The Claude Code headless result parser is written against a DOCUMENTED shape that
 * has not been observed in this repository: every field below is "to verify against a real run".
 * A missing field is null, never 0, and is listed in `missing`, so an unverified shape cannot
 * silently produce a zero.
 */
import { existsSync, readFileSync } from "node:fs";

export const CLAUDE_JSON_SHAPE_STATUS =
  "documented shape of `claude -p --output-format json`, to verify against a real run";

export interface ClientMeasures {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheCreationTokens: number | null;
  cacheReadTokens: number | null;
  totalCostUsd: number | null;
  numTurns: number | null;
  durationMs: number | null;
  durationApiMs: number | null;
  sessionId: string | null;
  isError: boolean | null;
}

export interface ParsedClientResult {
  ok: boolean;
  measures: ClientMeasures;
  missing: string[];
  problems: string[];
  shapeStatus: string;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export const EMPTY_MEASURES: ClientMeasures = {
  inputTokens: null,
  outputTokens: null,
  cacheCreationTokens: null,
  cacheReadTokens: null,
  totalCostUsd: null,
  numTurns: null,
  durationMs: null,
  durationApiMs: null,
  sessionId: null,
  isError: null,
};

/** Accepts the result object, or an array of messages containing one `type: "result"` entry. */
export function parseClaudeJson(stdout: string): ParsedClientResult {
  const base = { shapeStatus: CLAUDE_JSON_SHAPE_STATUS };
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return {
      ...base,
      ok: false,
      measures: { ...EMPTY_MEASURES },
      missing: [],
      problems: ["stdout is not JSON"],
    };
  }
  const obj = (
    Array.isArray(parsed)
      ? [...parsed]
          .reverse()
          .find((m) => m && typeof m === "object" && (m as { type?: string }).type === "result")
      : parsed
  ) as Record<string, unknown> | undefined;
  if (!obj || typeof obj !== "object")
    return {
      ...base,
      ok: false,
      measures: { ...EMPTY_MEASURES },
      missing: [],
      problems: ["no result object"],
    };
  const usage = (obj.usage ?? {}) as Record<string, unknown>;
  const measures: ClientMeasures = {
    inputTokens: num(usage.input_tokens),
    outputTokens: num(usage.output_tokens),
    cacheCreationTokens: num(usage.cache_creation_input_tokens),
    cacheReadTokens: num(usage.cache_read_input_tokens),
    totalCostUsd: num(obj.total_cost_usd),
    numTurns: num(obj.num_turns),
    durationMs: num(obj.duration_ms),
    durationApiMs: num(obj.duration_api_ms),
    sessionId: typeof obj.session_id === "string" ? obj.session_id : null,
    isError: typeof obj.is_error === "boolean" ? obj.is_error : null,
  };
  const missing = Object.entries(measures)
    .filter(([, v]) => v === null)
    .map(([k]) => k);
  return { ...base, ok: true, measures, missing, problems: [] };
}

/** Tool calls from a stream-json transcript (`tool_use` content blocks); null when no transcript. */
export function countTranscriptToolCalls(jsonl: string | null): number | null {
  if (jsonl === null) return null;
  let n = 0;
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    try {
      const m = JSON.parse(line) as { type?: string; message?: { content?: { type?: string }[] } };
      if (m.type === "assistant")
        for (const c of m.message?.content ?? []) if (c.type === "tool_use") n++;
    } catch {}
  }
  return n;
}

export interface ToolLogSummary {
  calls: number;
  resultChars: number;
  byTool: Record<string, number>;
}

/** Harness-side count of the wrapper-logged tool invocations (the Bash tool itself is not counted). */
export function readToolLog(file: string): ToolLogSummary {
  const out: ToolLogSummary = { calls: 0, resultChars: 0, byTool: {} };
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as { tool: string; outChars?: number };
      out.calls++;
      out.resultChars += r.outChars ?? 0;
      out.byTool[r.tool] = (out.byTool[r.tool] ?? 0) + 1;
    } catch {}
  }
  return out;
}

/** Sums sessions field by field; a field is null if any session lacks it. */
export function sumMeasures(sessions: ClientMeasures[]): ClientMeasures {
  const sum = (k: keyof ClientMeasures) => {
    const vs = sessions.map((s) => s[k]);
    return vs.length && vs.every((v) => typeof v === "number")
      ? (vs as number[]).reduce((a, b) => a + b, 0)
      : null;
  };
  return {
    inputTokens: sum("inputTokens"),
    outputTokens: sum("outputTokens"),
    cacheCreationTokens: sum("cacheCreationTokens"),
    cacheReadTokens: sum("cacheReadTokens"),
    totalCostUsd: sum("totalCostUsd"),
    numTurns: sum("numTurns"),
    durationMs: sum("durationMs"),
    durationApiMs: sum("durationApiMs"),
    sessionId: sessions.at(-1)?.sessionId ?? null,
    isError: sessions.some((s) => s.isError === true)
      ? true
      : sessions.every((s) => s.isError === false)
        ? false
        : null,
  };
}

/** List prices per million tokens; owner-supplied inputs, default 0 meaning "not supplied". */
export interface Prices {
  inputUsdPerMTok: number;
  outputUsdPerMTok: number;
  cacheWriteUsdPerMTok: number;
  cacheReadUsdPerMTok: number;
}
export const NO_PRICES: Prices = {
  inputUsdPerMTok: 0,
  outputUsdPerMTok: 0,
  cacheWriteUsdPerMTok: 0,
  cacheReadUsdPerMTok: 0,
};
export const pricesSupplied = (p: Prices) => p.inputUsdPerMTok > 0 && p.outputUsdPerMTok > 0;

export function recomputeCostUsd(m: ClientMeasures, p: Prices): number | null {
  if (!pricesSupplied(p)) return null;
  if (m.inputTokens === null || m.outputTokens === null) return null;
  return (
    (m.inputTokens * p.inputUsdPerMTok +
      m.outputTokens * p.outputUsdPerMTok +
      (m.cacheCreationTokens ?? 0) * p.cacheWriteUsdPerMTok +
      (m.cacheReadTokens ?? 0) * p.cacheReadUsdPerMTok) /
    1e6
  );
}

/**
 * The amount booked against the budget: the larger of the client-reported and the recomputed
 * cost; when neither is known the run is booked at its per-run ceiling (fail closed).
 */
export function bookedCostUsd(
  reported: number | null,
  recomputed: number | null,
  ceiling: number,
): number {
  const known = [reported, recomputed].filter((v): v is number => v !== null);
  return known.length ? Math.max(...known) : ceiling;
}
