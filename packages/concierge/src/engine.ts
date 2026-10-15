import { chat, type NativeAdapter } from "@navarch/adapter-native";

/**
 * What the concierge needs from a model: one completion over the conversation with the
 * concierge's tools offered. This slice implements it on the native adapter's OpenAI-compatible
 * client; an MCP engine driving Claude Code or Copilot can implement it later (ADR 0016).
 */

export type EngineToolCall = { id: string; name: string; arguments: string };

export type EngineMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[] }
  | { role: "tool"; tool_call_id: string; content: string };

export type EngineToolSpec = { name: string; description: string; parameters: Record<string, unknown> };

export type EngineReply = {
  content: string | null;
  toolCalls: EngineToolCall[];
  usage: { tokensIn: number; tokensOut: number; cost: number };
};

export interface ConciergeEngine {
  /** `<provider>/<model>` or another name for the model behind the engine. */
  readonly model: string;
  complete(messages: EngineMessage[], tools: EngineToolSpec[], signal?: AbortSignal): Promise<EngineReply>;
}

/** One concierge turn on an API model, through the native adapter's providers and keys. */
export class NativeChatEngine implements ConciergeEngine {
  readonly model: string;
  private readonly native: NativeAdapter;
  private readonly timeoutMs: number;

  constructor(native: NativeAdapter, model: string, timeoutMs = 120_000) {
    this.native = native;
    this.model = model;
    this.timeoutMs = timeoutMs;
  }

  async complete(messages: EngineMessage[], tools: EngineToolSpec[], signal = new AbortController().signal): Promise<EngineReply> {
    const { provider, model } = await this.native.connect(this.model);
    const specs = tools.map((t) => ({ type: "function" as const, function: { name: t.name, description: t.description, parameters: t.parameters } }));
    const response = await chat(provider, model, messages, specs, signal, this.timeoutMs);
    return {
      content: response.message.content,
      toolCalls: (response.message.tool_calls ?? []).map((c) => ({ id: c.id, name: c.function.name, arguments: c.function.arguments })),
      usage: { tokensIn: response.usage.tokensIn, tokensOut: response.usage.tokensOut, cost: response.usage.cost },
    };
  }
}
