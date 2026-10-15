import type { ErrorKind } from "@navarch/contracts";
import type { ToolSpec } from "./tools.ts";

/**
 * Minimal client for OpenAI-compatible chat completions (Ollama, OpenRouter, LiteLLM, vLLM…).
 * Prices and keys come from configuration; nothing provider-specific is hardcoded here.
 */

export type Provider = {
  /** Base URL ending before `/chat/completions`, e.g. `http://127.0.0.1:11434/v1`. */
  baseUrl: string;
  apiKey?: string;
  /** Reads the key when a task starts (e.g. from the Vault), so a key stored later is picked up. */
  getApiKey?: () => Promise<string | undefined>;
  /** The provider refuses requests without a key (OpenRouter, OpenCode Zen); Ollama does not. */
  requiresKey?: boolean;
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
  /** On a rate limit with a known reset: when it resets (ISO 8601) and the limit's name. */
  readonly limit?: { resetsAt: string; window: string };

  constructor(kind: ErrorKind, message: string, limit?: { resetsAt: string; window: string }) {
    super(message);
    this.kind = kind;
    if (limit) this.limit = limit;
  }
}

export async function chat(
  provider: Provider,
  model: string,
  messages: ChatMessage[],
  tools: ToolSpec[],
  signal: AbortSignal,
  timeoutMs = 0,
): Promise<ChatResponse> {
  // A free model's queue can hold a request open without ever answering; the timeout bounds one call.
  const timeout = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined;
  const fail = (err: unknown, what: string): ModelError => {
    if (signal.aborted) return new ModelError("cancelled", "cancelled");
    if (timeout?.aborted) return new ModelError("transient", `no response from ${provider.baseUrl} within ${timeoutMs / 1_000}s`);
    return new ModelError("transient", `${what} ${provider.baseUrl}: ${err instanceof Error ? err.message : String(err)}`);
  };
  let res: Response;
  try {
    res = await fetch(`${provider.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      signal: timeout ? AbortSignal.any([signal, timeout]) : signal,
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
    throw fail(err, "cannot reach");
  }

  let text: string;
  try {
    text = await res.text();
  } catch (err) {
    throw fail(err, "cannot read the response from");
  }
  if (!res.ok) {
    const detail = errorDetail(text);
    const kind: ErrorKind =
      res.status === 429 ? "rate_limited" : res.status >= 500 ? "transient" : res.status === 402 ? "budget_exceeded" : "fatal";
    // `Retry-After` is seconds (or an HTTP date); keep it in the message for the retry hint.
    const after = res.headers.get("retry-after");
    const seconds = after && /^\d+$/.test(after.trim()) ? Number(after) : after ? Math.max(0, (Date.parse(after) - Date.now()) / 1_000) : NaN;
    const hint = Number.isFinite(seconds) ? ` (retry after ${Math.ceil(seconds)}s)` : "";
    throw new ModelError(kind, `HTTP ${res.status} from ${provider.baseUrl}: ${detail}${hint}`, kind === "rate_limited" ? rateLimit(res.headers, text, detail) : undefined);
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

/**
 * A rate limit's reset from `X-RateLimit-Reset` (epoch ms or s), in the response headers or, as
 * OpenRouter sends it for its free-model daily limit, in `error.metadata.headers` of the body.
 * The window name comes from the message (`free-models-per-day`), else `requests`.
 */
export function rateLimit(headers: Headers, body: string, detail: string): { resetsAt: string; window: string } | undefined {
  let raw = headers.get("x-ratelimit-reset") ?? undefined;
  if (!raw) {
    try {
      const meta = (JSON.parse(body) as { error?: { metadata?: { headers?: Record<string, unknown> } } }).error?.metadata?.headers ?? {};
      const value = Object.entries(meta).find(([k]) => k.toLowerCase() === "x-ratelimit-reset")?.[1];
      raw = value === undefined ? undefined : String(value);
    } catch {
      // Not JSON: no reset in the body.
    }
  }
  const epoch = raw && /^\d+$/.test(raw.trim()) ? Number(raw) : NaN;
  if (!Number.isFinite(epoch)) return undefined;
  const window = /free-models-per-(day|min)/i.exec(detail)?.[0].toLowerCase() ?? "requests";
  return { resetsAt: new Date(epoch < 1e12 ? epoch * 1_000 : epoch).toISOString(), window };
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
