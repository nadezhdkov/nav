import type { ErrorKind } from "@vectr/contracts";
import type { ToolSpec } from "./tools.ts";

/**
 * Minimal client for OpenAI-compatible chat completions (Ollama, OpenRouter, LiteLLM, vLLM…).
 * Prices and keys come from configuration; nothing provider-specific is hardcoded here.
 */

export type Provider = {
  /** Base URL ending before `/chat/completions`, e.g. `http://127.0.0.1:11434/v1`. */
  baseUrl: string;
  apiKey?: string;
  headers?: Record<string, string>;
  /** Extra JSON merged into every request body (e.g. OpenRouter `usage: { include: true }`). */
  extraBody?: Record<string, unknown>;
};

export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };

export type ChatResponse = {
  message: { content: string | null; tool_calls?: ToolCall[] };
  finishReason: string;
  usage: { tokensIn: number; tokensOut: number; cached: number; cost: number };
};

export class ModelError extends Error {
  readonly kind: ErrorKind;

  constructor(kind: ErrorKind, message: string) {
    super(message);
    this.kind = kind;
  }
}

export async function chat(
  provider: Provider,
  model: string,
  messages: ChatMessage[],
  tools: ToolSpec[],
  signal: AbortSignal,
): Promise<ChatResponse> {
  let res: Response;
  try {
    res = await fetch(`${provider.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      signal,
      headers: {
        "content-type": "application/json",
        ...(provider.apiKey ? { authorization: `Bearer ${provider.apiKey}` } : {}),
        ...provider.headers,
      },
      body: JSON.stringify({
        model,
        messages,
        ...(tools.length ? { tools, tool_choice: "auto" } : {}),
        temperature: 0.2,
        ...provider.extraBody,
      }),
    });
  } catch (err) {
    if (signal.aborted) throw new ModelError("cancelled", "cancelled");
    throw new ModelError("transient", `cannot reach ${provider.baseUrl}: ${err instanceof Error ? err.message : String(err)}`);
  }

  const text = await res.text();
  if (!res.ok) {
    const detail = errorDetail(text);
    const kind: ErrorKind =
      res.status === 429 ? "rate_limited" : res.status >= 500 ? "transient" : res.status === 402 ? "budget_exceeded" : "fatal";
    // `Retry-After` is seconds (or an HTTP date); keep it in the message for the retry hint.
    const after = res.headers.get("retry-after");
    const seconds = after && /^\d+$/.test(after.trim()) ? Number(after) : after ? Math.max(0, (Date.parse(after) - Date.now()) / 1_000) : NaN;
    const hint = Number.isFinite(seconds) ? ` (retry after ${Math.ceil(seconds)}s)` : "";
    throw new ModelError(kind, `HTTP ${res.status} from ${provider.baseUrl}: ${detail}${hint}`);
  }

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new ModelError("transient", `invalid JSON from ${provider.baseUrl}: ${text.slice(0, 200)}`);
  }
  // Some gateways report upstream failures with HTTP 200 and an `error` object.
  if (data.error) throw new ModelError("transient", `provider error: ${errorDetail(JSON.stringify(data))}`);

  const choice = (Array.isArray(data.choices) ? data.choices[0] : undefined) as
    | { message?: ChatResponse["message"]; finish_reason?: string }
    | undefined;
  if (!choice?.message) throw new ModelError("transient", "response has no choices");
  const usage = (data.usage ?? {}) as Record<string, unknown>;
  const details = (usage.prompt_tokens_details ?? {}) as Record<string, unknown>;
  return {
    message: { content: choice.message.content ?? null, ...(choice.message.tool_calls?.length ? { tool_calls: choice.message.tool_calls } : {}) },
    finishReason: choice.finish_reason ?? "",
    usage: {
      tokensIn: num(usage.prompt_tokens),
      tokensOut: num(usage.completion_tokens),
      cached: num(details.cached_tokens),
      cost: num(usage.cost),
    },
  };
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function errorDetail(text: string): string {
  try {
    const data = JSON.parse(text) as { error?: { message?: string } | string; message?: string };
    const e = data.error;
    return (typeof e === "string" ? e : e?.message) ?? data.message ?? text.slice(0, 300);
  } catch {
    return text.slice(0, 300);
  }
}
