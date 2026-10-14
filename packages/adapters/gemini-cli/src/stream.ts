import { toolSummary } from "@navarch/adapter-kit";
import type { UsageRecord } from "@navarch/contracts";

/**
 * Parser for `gemini -p … --output-format stream-json`: one JSON event per line with
 * `type` = init | message | tool_use | tool_result | error | result.
 */

export type GeminiItem =
  | { kind: "init"; sessionId: string; model?: string }
  | { kind: "text"; text: string; delta: boolean }
  | { kind: "tool"; id: string; name: string; summary: string }
  | { kind: "tool_result"; id: string; ok: boolean; errorType?: string; message?: string }
  | { kind: "error"; message: string }
  | { kind: "result"; ok: boolean; error?: string; usage: UsageRecord[] };

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

export function parseGeminiLine(line: string): GeminiItem | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return undefined;
  let data: unknown;
  try {
    data = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (!isObject(data)) return undefined;

  switch (data.type) {
    case "init":
      return { kind: "init", sessionId: str(data.session_id), model: str(data.model) || undefined };
    case "message":
      if (data.role !== "assistant") return undefined;
      return { kind: "text", text: str(data.content), delta: data.delta === true };
    case "tool_use":
      return {
        kind: "tool",
        id: str(data.tool_id),
        name: str(data.tool_name),
        summary: toolSummary(str(data.tool_name), data.parameters),
      };
    case "tool_result": {
      const error = isObject(data.error) ? data.error : undefined;
      return {
        kind: "tool_result",
        id: str(data.tool_id),
        ok: data.status === "success",
        ...(error ? { errorType: str(error.type), message: str(error.message) } : {}),
      };
    }
    case "error":
      return { kind: "error", message: str(data.message) || JSON.stringify(data) };
    case "result": {
      const error = isObject(data.error) ? data.error : undefined;
      return {
        kind: "result",
        ok: data.status === "success",
        ...(error ? { error: `${str(error.type)}: ${str(error.message)}` } : {}),
        usage: usage(isObject(data.stats) ? data.stats : {}),
      };
    }
    default:
      return undefined;
  }
}

/** Gemini reports tokens, not cost; free-tier and subscription use is recorded at cost 0. */
function usage(stats: Json): UsageRecord[] {
  const models = isObject(stats.models) ? stats.models : {};
  const records = Object.entries(models)
    .filter((entry): entry is [string, Json] => isObject(entry[1]))
    .map(([model, m]) => ({
      model,
      tokens_in: num(m.input_tokens),
      tokens_out: num(m.output_tokens),
      cached_tokens: num(m.cached),
      cost: 0,
    }));
  if (records.length || !("input_tokens" in stats)) return records;
  return [{ model: "gemini", tokens_in: num(stats.input_tokens), tokens_out: num(stats.output_tokens), cached_tokens: num(stats.cached), cost: 0 }];
}
