import { toolSummary } from "@vectr/adapter-kit";
import type { UsageRecord } from "@vectr/contracts";

/**
 * Parser for `agy -p … --output-format stream-json`: one JSON object per line with
 * `event` = init | step_update | result. Format observed with agy 1.3.5.
 */

export type AgyItem =
  | { kind: "init"; conversationId: string; model?: string }
  | { kind: "text"; text: string }
  | { kind: "tool"; name: string; summary: string }
  | { kind: "tool_error"; name: string; summary: string; message: string }
  | { kind: "result"; ok: boolean; status: string; response: string; error?: string; usage: UsageRecord[]; denied: string[] };

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

export function parseAgyLine(line: string, model = "antigravity"): AgyItem | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return undefined;
  let data: unknown;
  try {
    data = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (!isObject(data)) return undefined;

  switch (data.event) {
    case "init": {
      const init = isObject(data.init) ? data.init : {};
      return { kind: "init", conversationId: str(data.conversation_id), model: str(init.model) || undefined };
    }
    case "step_update": {
      const step = isObject(data.step_update) ? data.step_update : {};
      if (step.step_type === "agent_response") {
        const text = str(step.text_delta);
        return text ? { kind: "text", text } : undefined;
      }
      if (step.step_type !== "tool") return undefined;
      const info = isObject(step.tool_info) ? step.tool_info : {};
      const name = str(step.tool_name) || str(info.name);
      const summary = toolSummary(name, agyParams(info.parameters));
      // A tool appears twice: ACTIVE when called, DONE when finished (with output or error).
      if (step.state === "ACTIVE") return { kind: "tool", name, summary };
      const error = isObject(info.error) ? info.error : undefined;
      return error ? { kind: "tool_error", name, summary, message: `${str(error.type)}: ${str(error.message)}` } : undefined;
    }
    case "result": {
      const result = isObject(data.result) ? data.result : {};
      const status = str(result.status);
      const denied = Array.isArray(result.denied_actions)
        ? result.denied_actions.filter(isObject).map((d) => str(d.action) || str(d.display_name))
        : [];
      return {
        kind: "result",
        ok: status === "SUCCESS",
        status,
        response: str(result.response).trim(),
        ...(str(result.error) ? { error: str(result.error) } : {}),
        usage: usage(isObject(result.usage) ? result.usage : undefined, model),
        denied,
      };
    }
    default:
      return undefined;
  }
}

/** agy tools use PascalCase parameters (`CommandLine`, `AbsolutePath`, `TargetFile`). */
function agyParams(params: unknown): Json {
  const p = isObject(params) ? params : {};
  const target = str(p.CommandLine) || str(p.TargetFile) || str(p.AbsolutePath) || str(p.DirectoryPath) || str(p.Query);
  return target ? { ...p, path: target } : p;
}

/** agy reports tokens, not cost; subscription use is recorded at cost 0. */
function usage(u: Json | undefined, model: string): UsageRecord[] {
  if (!u) return [];
  return [
    {
      model,
      tokens_in: num(u.input_tokens),
      tokens_out: num(u.output_tokens) + num(u.thinking_tokens),
      cached_tokens: num(u.cache_read_tokens),
      cost: 0,
    },
  ];
}
