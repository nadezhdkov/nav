/**
 * Parser for `copilot -p … --output-format json`: one event per line, `{ type, data, … }`.
 * The adapter uses assistant.message (final text), tool.execution_start/complete (commands,
 * edits, denials), session.error and the closing `result` (session id, exit code). Shapes
 * checked against a real Copilot CLI 1.0.98 run.
 */

export type CopilotItem =
  | { kind: "text"; text: string }
  | { kind: "tool_start"; callId: string; tool: string; command?: string }
  | { kind: "tool_done"; callId: string; ok: boolean; denied: boolean; error?: string; exitCode?: number; paths: string[] }
  | { kind: "failed"; message: string }
  | { kind: "result"; sessionId: string; exitCode: number; premiumRequests: number };

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

export function parseCopilotLine(line: string): CopilotItem | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return undefined;
  let event: unknown;
  try {
    event = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (!isObject(event)) return undefined;
  const data = isObject(event.data) ? event.data : {};

  switch (event.type) {
    case "assistant.message": {
      const text = str(data.content);
      return text.trim() ? { kind: "text", text } : undefined;
    }
    case "tool.execution_start": {
      const args = isObject(data.arguments) ? data.arguments : {};
      const command = str(args.command);
      return { kind: "tool_start", callId: str(data.toolCallId), tool: str(data.toolName), ...(command ? { command } : {}) };
    }
    case "tool.execution_complete": {
      const error = isObject(data.error) ? data.error : {};
      const shell = isObject(data.shellExecution) ? data.shellExecution : {};
      const edits = Array.isArray(data.fileEdits) ? data.fileEdits.filter(isObject) : [];
      return {
        kind: "tool_done",
        callId: str(data.toolCallId),
        ok: data.success === true,
        denied: error.code === "denied",
        ...(str(error.message) ? { error: str(error.message) } : {}),
        ...(typeof shell.exitCode === "number" ? { exitCode: shell.exitCode } : {}),
        paths: edits.map((e) => str(e.path)).filter(Boolean),
      };
    }
    // Not seen in a real run yet; the name follows the CLI's `session.*` events (🟡 inferred).
    case "session.error":
    case "error":
      return { kind: "failed", message: str(data.message) || str(event.message) || "copilot error" };
    case "result": {
      const usage = isObject(event.usage) ? event.usage : {};
      return {
        kind: "result",
        sessionId: str(event.sessionId),
        exitCode: num(event.exitCode),
        premiumRequests: num(usage.premiumRequests),
      };
    }
    default:
      return undefined;
  }
}

export type CopilotUsage = { model: string; tokensIn: number; tokensOut: number; cached: number };

/** Token totals from the `--usage-output-file` JSON (`modelMetrics.<model>.usage`). */
export function parseCopilotUsage(text: string): CopilotUsage | undefined {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isObject(data) || !isObject(data.modelMetrics)) return undefined;
  const total: CopilotUsage = { model: str(data.currentModel), tokensIn: 0, tokensOut: 0, cached: 0 };
  for (const [model, metrics] of Object.entries(data.modelMetrics)) {
    const usage = isObject(metrics) && isObject(metrics.usage) ? metrics.usage : {};
    total.tokensIn += num(usage.inputTokens);
    total.tokensOut += num(usage.outputTokens);
    total.cached += num(usage.cacheReadTokens);
    if (!total.model) total.model = model;
  }
  return total;
}
