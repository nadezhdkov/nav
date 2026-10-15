import type { UsageRecord } from "@navarch/contracts";

/**
 * Parser for `grok -p … --output-format streaming-messages-json`: one object per line in the
 * Anthropic Messages wire format, close to Claude Code's stream-json (`system` init, `assistant`,
 * `user` tool results, `result`). Shapes checked against a real Grok CLI 1.0.52 run (grok-4.7).
 * Unknown lines and fields are ignored.
 */

export type GrokItem =
  /** `apiKeySource` is `oauth` when the CLI is signed in to a grok.com account (ADR 0024). */
  | { kind: "init"; sessionId: string; model?: string; apiKeySource?: string }
  | { kind: "text"; text: string }
  | { kind: "tool"; id: string; name: string; summary: string }
  /** A tool call finished; `denied` when Grok's rules or Navarch's guard refused to run it. */
  | { kind: "tool_result"; toolUseId: string; ok: boolean; denied: boolean; message: string }
  | { kind: "result"; result: GrokResult };

export type GrokResult = {
  ok: boolean;
  subtype: string;
  text: string;
  /** Why the run stopped, e.g. `end_turn`, `max_turns`, `cancelled`. */
  stopReason: string;
  errors: string[];
  sessionId?: string;
  usage: UsageRecord[];
};

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** What a refused call's result says: a deny rule, `dontAsk` mode, or a hook such as the guard. */
const DENIED = /was not executed|denied by (permission|prompt) policy|blocked by hook|navarch guard/i;

export function parseGrokLine(line: string): GrokItem[] {
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
      return data.subtype === "init" && str(data.session_id)
        ? [{ kind: "init", sessionId: str(data.session_id), model: str(data.model) || undefined, apiKeySource: str(data.apiKeySource) || undefined }]
        : [];
    case "assistant": {
      const items: GrokItem[] = [];
      for (const block of content(data)) {
        if (block.type === "text" && str(block.text).trim()) items.push({ kind: "text", text: str(block.text) });
        else if (block.type === "tool_use") {
          items.push({ kind: "tool", id: str(block.id), name: str(block.name), summary: toolSummary(str(block.name), block.input) });
        }
      }
      return items;
    }
    case "user":
      return content(data)
        .filter((b) => b.type === "tool_result" && str(b.tool_use_id))
        .map((b) => {
          const message = resultText(b.content);
          const failed = b.is_error === true;
          return { kind: "tool_result" as const, toolUseId: str(b.tool_use_id), ok: !failed, denied: failed && DENIED.test(message), message };
        });
    case "result":
      return [{ kind: "result", result: toResult(data) }];
    default:
      return [];
  }
}

function content(data: Json): Json[] {
  const message = isObject(data.message) ? data.message : {};
  return (Array.isArray(message.content) ? message.content : []).filter(isObject);
}

/** A tool result's content is a JSON string of Grok's own output, or a list of text blocks. */
function resultText(value: unknown): string {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed.startsWith("[")) return value.slice(0, 500);
    try {
      return resultText(JSON.parse(trimmed));
    } catch {
      return value.slice(0, 500);
    }
  }
  if (!Array.isArray(value)) return "";
  return value
    .map((b) => (isObject(b) ? str(b.text) || (isObject(b.content) ? str(b.content.text) : "") : ""))
    .join("\n")
    .slice(0, 500);
}

/** Short form of a Grok tool call: its command or the file it works on. */
export function toolSummary(name: string, input: unknown): string {
  const o = isObject(input) ? input : {};
  const target = str(o.command) || str(o.file_path) || str(o.target_file) || str(o.path) || str(o.pattern) || str(o.query);
  return target ? `${name} ${target.slice(0, 200)}` : name;
}

function toResult(data: Json): GrokResult {
  const usage: UsageRecord[] = [];
  for (const [model, raw] of Object.entries(isObject(data.modelUsage) ? data.modelUsage : {})) {
    if (!isObject(raw)) continue;
    usage.push({
      model,
      tokens_in: num(raw.inputTokens) + num(raw.cacheCreationInputTokens),
      tokens_out: num(raw.outputTokens),
      cached_tokens: num(raw.cacheReadInputTokens),
      cost: num(raw.costUSD),
    });
  }
  // A successful run may report only the totals.
  if (usage.length === 0 && isObject(data.usage)) {
    usage.push({
      model: "unknown",
      tokens_in: num(data.usage.input_tokens) + num(data.usage.cache_creation_input_tokens),
      tokens_out: num(data.usage.output_tokens),
      cached_tokens: num(data.usage.cache_read_input_tokens),
      cost: num(data.total_cost_usd),
    });
  }
  const subtype = str(data.subtype) || "unknown";
  return {
    ok: subtype === "success" && data.is_error !== true,
    subtype,
    text: str(data.result),
    stopReason: str(data.stop_reason),
    errors: (Array.isArray(data.errors) ? data.errors : []).map((e) => (typeof e === "string" ? e : JSON.stringify(e))),
    sessionId: str(data.session_id) || undefined,
    usage,
  };
}
