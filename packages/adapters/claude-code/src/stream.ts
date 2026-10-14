import { toolSummary } from "@navarch/adapter-kit";
import type { UsageRecord } from "@navarch/contracts";

/**
 * Parser for `claude -p --output-format stream-json --verbose` output: one JSON object per line.
 * Only the fields Navarch uses are read; unknown lines and fields are ignored, so CLI additions
 * do not break the adapter.
 */

export type StreamItem =
  | { kind: "init"; sessionId: string; model?: string }
  | { kind: "text"; text: string }
  | { kind: "tool"; name: string; summary: string }
  | { kind: "result"; result: ClaudeResult }
  | { kind: "quota"; limit: ClaudeLimit }
  | { kind: "other" };

export type ClaudeResult = {
  ok: boolean;
  subtype: string;
  text: string;
  costUsd: number;
  durationMs: number;
  sessionId?: string;
  usage: UsageRecord[];
  /** Tool calls Claude Code refused because the grant did not allow them. */
  denials: { tool: string; input: string }[];
};

/** Subscription limits from a `rate_limit_event` (5-hour and weekly windows). */
export type ClaudeLimit = {
  /** `allowed`, `allowed_warning` or `rejected`. */
  status: string;
  /** The window the status is about, e.g. `seven_day`. */
  type: string;
  resetsAt?: string;
  windows: { window: string; utilization: number; resetsAt?: string }[];
};

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

export function parseLine(line: string): StreamItem[] {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return [];
  let data: unknown;
  try {
    data = JSON.parse(trimmed);
  } catch {
    return [];
  }
  if (!isObject(data)) return [];

  switch (data.type) {
    case "system":
      if (data.subtype === "init" && typeof data.session_id === "string") {
        return [{ kind: "init", sessionId: data.session_id, model: str(data.model) || undefined }];
      }
      return [{ kind: "other" }];
    case "assistant":
      return assistantItems(data);
    case "result":
      return [{ kind: "result", result: toResult(data) }];
    case "rate_limit_event":
      return isObject(data.rate_limit_info) ? [{ kind: "quota", limit: toLimit(data.rate_limit_info) }] : [{ kind: "other" }];
    default:
      return [{ kind: "other" }];
  }
}

function assistantItems(data: Json): StreamItem[] {
  const message = isObject(data.message) ? data.message : {};
  const content = Array.isArray(message.content) ? message.content : [];
  const items: StreamItem[] = [];
  for (const block of content) {
    if (!isObject(block)) continue;
    if (block.type === "text" && str(block.text).trim()) {
      items.push({ kind: "text", text: str(block.text) });
    } else if (block.type === "tool_use") {
      items.push({ kind: "tool", name: str(block.name), summary: toolSummary(str(block.name), block.input) });
    }
  }
  return items;
}


const epochIso = (v: unknown): string | undefined => (typeof v === "number" && v > 0 ? new Date(v * 1_000).toISOString() : undefined);

function toLimit(info: Json): ClaudeLimit {
  const windows = Object.entries(isObject(info.unifiedWindows) ? info.unifiedWindows : {})
    .filter((entry): entry is [string, Json] => isObject(entry[1]))
    .map(([window, w]) => ({ window, utilization: num(w.utilization), resetsAt: epochIso(w.resetsAt) }));
  return { status: str(info.status), type: str(info.rateLimitType), resetsAt: epochIso(info.resetsAt), windows };
}

function toResult(data: Json): ClaudeResult {
  const usage: UsageRecord[] = [];
  const modelUsage = isObject(data.modelUsage) ? data.modelUsage : {};
  for (const [model, raw] of Object.entries(modelUsage)) {
    if (!isObject(raw)) continue;
    usage.push({
      model,
      tokens_in: num(raw.inputTokens) + num(raw.cacheCreationInputTokens),
      tokens_out: num(raw.outputTokens),
      cached_tokens: num(raw.cacheReadInputTokens),
      cost: num(raw.costUSD),
    });
  }
  if (usage.length === 0 && isObject(data.usage)) {
    usage.push({
      model: "unknown",
      tokens_in: num(data.usage.input_tokens) + num(data.usage.cache_creation_input_tokens),
      tokens_out: num(data.usage.output_tokens),
      cached_tokens: num(data.usage.cache_read_input_tokens),
      cost: num(data.total_cost_usd),
    });
  }
  const denials = (Array.isArray(data.permission_denials) ? data.permission_denials : [])
    .filter(isObject)
    .map((d) => ({ tool: str(d.tool_name), input: toolSummary(str(d.tool_name), d.tool_input) }));
  const subtype = str(data.subtype) || "unknown";
  return {
    ok: subtype === "success" && data.is_error !== true,
    subtype,
    text: str(data.result),
    costUsd: num(data.total_cost_usd),
    durationMs: num(data.duration_ms),
    sessionId: str(data.session_id) || undefined,
    usage,
    denials,
  };
}
