import { failed, succeeded } from "@vectr/adapter-kit";
import type {
  AdapterCapabilities,
  AdapterIO,
  AgentAdapter,
  HealthStatus,
  TaskContext,
  TaskResult,
  UsageRecord,
} from "@vectr/contracts";
import { chat, ModelError, type ChatMessage, type Provider } from "./client.ts";
import { SandboxTools, toolSpecs } from "./tools.ts";

/**
 * The native agent (spec §6.3.2): VECTR's own tool loop for any OpenAI-compatible model,
 * local (Ollama) or remote (OpenRouter, including free models). VECTR executes every tool
 * call, so the grant is enforced exactly. Decision: ADR 0004.
 */

export type NativeOptions = {
  /** Providers by name; a model id is `<provider>/<model>`, e.g. `ollama/qwen2.5:7b`. */
  providers: Record<string, Provider>;
  /** Model used when the run does not pin one. */
  defaultModel?: string;
  /** Upper bound on model calls per attempt when the task does not set one. */
  maxTurns?: number;
};

const SYSTEM = [
  "You are an autonomous coding agent working in a git repository. All paths are relative to the repository root.",
  "Use the tools to inspect and change files. Read a file before editing it. Make the smallest change that completes the task.",
  "When you are done, reply without calling a tool: give a short summary of what changed and how you checked it.",
].join("\n");

export function resolveModel(id: string, providers: Record<string, Provider>): { provider: Provider; model: string; name: string } {
  const slash = id.indexOf("/");
  const name = slash > 0 ? id.slice(0, slash) : "";
  const provider = providers[name];
  if (!provider) {
    throw new ModelError("fatal", `model "${id}" must be <provider>/<model> with provider one of: ${Object.keys(providers).join(", ") || "(none configured)"}`);
  }
  return { provider, model: id.slice(slash + 1), name };
}

export class NativeAdapter implements AgentAdapter {
  readonly id = "native";
  private readonly options: NativeOptions;
  private readonly controllers = new Map<string, { controller: AbortController; cancelled: boolean }>();

  constructor(options: NativeOptions) {
    this.options = options;
  }

  capabilities(): AdapterCapabilities {
    return { streaming: false, ownTools: false, resumable: false, enforcement: "exact" };
  }

  async healthcheck(): Promise<HealthStatus> {
    const configured = Object.keys(this.options.providers);
    return { ok: configured.length > 0, detail: `providers: ${configured.join(", ") || "none"}` };
  }

  async run(ctx: TaskContext, io: AdapterIO): Promise<TaskResult> {
    const entry = { controller: new AbortController(), cancelled: false };
    this.controllers.set(ctx.taskId, entry);
    const usage = new Map<string, UsageRecord>();
    let lastText = "";
    try {
      const modelId = ctx.model ?? this.options.defaultModel;
      if (!modelId) return failed("fatal", "the native adapter needs a model, e.g. --model ollama/qwen2.5:7b");
      const { provider, model } = resolveModel(modelId, this.options.providers);
      const tools = new SandboxTools(ctx.sandbox.path, ctx.tools);
      const specs = toolSpecs(ctx.tools);
      const retryNote =
        ctx.attempt > 1 ? "\n\nNote: an earlier attempt may already have changed files in this repository. Check the current state before editing." : "";
      const messages: ChatMessage[] = [
        { role: "system", content: SYSTEM },
        { role: "user", content: ctx.instructions + retryNote },
      ];
      const maxTurns = ctx.budget.maxTurns || this.options.maxTurns || 40;
      const deadline = ctx.budget.timeoutMs > 0 ? Date.now() + ctx.budget.timeoutMs : Infinity;

      for (let turn = 1; turn <= maxTurns; turn++) {
        if (Date.now() > deadline) return failed("transient", "native agent timed out", lastText, [...usage.values()]);
        const started = Date.now();
        const response = await chat(provider, model, messages, specs, entry.controller.signal);
        const record = usage.get(modelId) ?? { model: modelId, tokens_in: 0, tokens_out: 0, cached_tokens: 0, cost: 0, latency_ms: 0 };
        record.tokens_in += response.usage.tokensIn;
        record.tokens_out += response.usage.tokensOut;
        record.cached_tokens += response.usage.cached;
        record.cost += response.usage.cost;
        record.latency_ms = (record.latency_ms ?? 0) + (Date.now() - started);
        usage.set(modelId, record);

        const { content, tool_calls } = response.message;
        io.emit({ kind: "log", line: JSON.stringify({ turn, content, tool_calls, usage: response.usage }) });
        if (content?.trim()) {
          lastText = content.trim();
          io.emit({ kind: "progress", message: lastText.slice(0, 500) });
        }
        if (ctx.budget.maxCost > 0 && record.cost > ctx.budget.maxCost) {
          return failed("budget_exceeded", `spent $${record.cost.toFixed(4)} of $${ctx.budget.maxCost.toFixed(2)}`, lastText, [...usage.values()]);
        }
        if (!tool_calls?.length) {
          return succeeded(lastText || "(the model finished without a summary)", [...usage.values()]);
        }

        messages.push({ role: "assistant", content, tool_calls });
        for (const call of tool_calls) {
          const name = call.function?.name ?? "";
          const args = call.function?.arguments ?? "";
          io.emit({ kind: "progress", message: `${name} ${summarizeArgs(args)}`.trim(), tool: name });
          const outcome = await tools.call(name, args);
          if (outcome.denied) io.emit({ kind: "denied", ...outcome.denied });
          io.emit({ kind: "log", line: JSON.stringify({ tool: name, output: outcome.output.slice(0, 2_000) }) });
          messages.push({ role: "tool", tool_call_id: call.id, content: outcome.output });
        }
      }
      return failed("fatal", `stopped after ${maxTurns} model calls without finishing`, lastText, [...usage.values()]);
    } catch (err) {
      if (entry.cancelled) return failed("cancelled", "cancelled by user", lastText, [...usage.values()]);
      if (err instanceof ModelError) return failed(err.kind, err.message, lastText, [...usage.values()]);
      return failed("fatal", err instanceof Error ? err.message : String(err), lastText, [...usage.values()]);
    } finally {
      this.controllers.delete(ctx.taskId);
    }
  }

  async cancel(taskId: string): Promise<void> {
    const entry = this.controllers.get(taskId);
    if (!entry) return;
    entry.cancelled = true;
    entry.controller.abort();
  }

  async stopAll(): Promise<void> {
    for (const entry of this.controllers.values()) entry.controller.abort();
  }
}

function summarizeArgs(raw: string): string {
  try {
    const args = JSON.parse(raw) as Record<string, unknown>;
    const v = args.path ?? args.command ?? args.pattern;
    return typeof v === "string" ? v.slice(0, 200) : "";
  } catch {
    return "";
  }
}
