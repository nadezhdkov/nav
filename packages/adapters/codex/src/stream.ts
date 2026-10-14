/**
 * Parser for `codex exec --json`: one event per line — thread.started, turn.started,
 * item.started/updated/completed, turn.completed (with usage), turn.failed and error.
 */

export type CodexItem =
  | { kind: "thread"; threadId: string }
  | { kind: "text"; text: string }
  | { kind: "command"; command: string; exitCode?: number }
  | { kind: "file_change"; paths: string[] }
  | { kind: "usage"; tokensIn: number; tokensOut: number; cached: number }
  | { kind: "failed"; message: string };

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

export function parseCodexLine(line: string): CodexItem | undefined {
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
    case "thread.started":
      return { kind: "thread", threadId: str(data.thread_id) };
    case "item.completed": {
      const item = isObject(data.item) ? data.item : {};
      switch (item.type) {
        case "agent_message":
          return { kind: "text", text: str(item.text) };
        case "command_execution":
          return {
            kind: "command",
            command: str(item.command),
            ...(typeof item.exit_code === "number" ? { exitCode: item.exit_code } : {}),
          };
        case "file_change": {
          const changes = Array.isArray(item.changes) ? item.changes : [];
          return { kind: "file_change", paths: changes.filter(isObject).map((c) => str(c.path)) };
        }
        default:
          return undefined;
      }
    }
    case "turn.completed": {
      const usage = isObject(data.usage) ? data.usage : {};
      return {
        kind: "usage",
        tokensIn: num(usage.input_tokens),
        tokensOut: num(usage.output_tokens),
        cached: num(usage.cached_input_tokens),
      };
    }
    case "turn.failed": {
      const error = isObject(data.error) ? data.error : {};
      return { kind: "failed", message: str(error.message) || "turn failed" };
    }
    case "error":
      return { kind: "failed", message: str(data.message) || "codex error" };
    default:
      return undefined;
  }
}
