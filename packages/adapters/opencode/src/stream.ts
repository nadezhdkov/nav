/**
 * Parser for `opencode run --format json`: one event per line, `{ type, sessionID, part | error }`.
 * The adapter uses step_start (session id), text, tool_use (commands, edits, denials),
 * step_finish (tokens, cost) and error. Shapes checked against a real OpenCode 2.0.29 run, and
 * against Kilo CLI 7.8.12 (an OpenCode fork), which words denials and errors differently.
 */

export type OpencodeItem =
  | { kind: "session"; sessionId: string }
  | { kind: "text"; text: string }
  | { kind: "tool"; tool: string; ok: boolean; denied: boolean; command?: string; path?: string; error?: string }
  | { kind: "usage"; tokensIn: number; tokensOut: number; cached: number; cost: number }
  | { kind: "failed"; message: string };

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

export function parseOpencodeLine(line: string): OpencodeItem | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return undefined;
  let event: unknown;
  try {
    event = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (!isObject(event)) return undefined;
  const part = isObject(event.part) ? event.part : {};

  switch (event.type) {
    case "step_start": {
      const sessionId = str(event.sessionID);
      return sessionId ? { kind: "session", sessionId } : undefined;
    }
    case "text": {
      const text = visibleText(str(part.text));
      return text.trim() ? { kind: "text", text } : undefined;
    }
    case "tool_use": {
      const state = isObject(part.state) ? part.state : {};
      const input = isObject(state.input) ? state.input : {};
      const error = str(state.error);
      const command = str(input.command);
      const path = str(input.path) || str(input.filePath) || str(input.file_path);
      return {
        kind: "tool",
        tool: str(part.tool),
        ok: state.status === "completed",
        denied: isDenied(error),
        ...(command ? { command } : {}),
        ...(path ? { path } : {}),
        ...(error ? { error } : {}),
      };
    }
    case "step_finish": {
      const tokens = isObject(part.tokens) ? part.tokens : {};
      const cache = isObject(tokens.cache) ? tokens.cache : {};
      return {
        kind: "usage",
        tokensIn: num(tokens.input),
        tokensOut: num(tokens.output) + num(tokens.reasoning),
        cached: num(cache.read),
        cost: num(part.cost),
      };
    }
    case "error": {
      const error = isObject(event.error) ? event.error : {};
      // Kilo nests the message under `data` and names the error instead of typing it.
      const data = isObject(error.data) ? error.data : {};
      const message = str(error.message) || str(data.message) || str(event.message) || "opencode error";
      // The status goes into the message so the kit's classifier sees a 429 as a rate limit.
      const status = num(error.status) || num(data.statusCode);
      return { kind: "failed", message: `${str(error.type) || str(error.name) || "error"}: ${message}${status ? ` (HTTP ${status})` : ""}` };
    }
    default:
      return undefined;
  }
}

/**
 * OpenCode says "Permission denied: <tool>". Kilo explains the matching rule instead, and calls a
 * tool its rules removed "unavailable".
 */
const DENIED_AT_START = /^permission denied/i;
const DENIED_ANYWHERE = /rule which prevents you from using|tried to call unavailable tool/i;
const isDenied = (text: string) => DENIED_AT_START.test(text) || DENIED_ANYWHERE.test(text);

/** Some free models put their reasoning in the text, closed by `</think>`; keep what follows. */
function visibleText(text: string): string {
  const end = text.lastIndexOf("</think>");
  return end === -1 ? text : text.slice(end + "</think>".length).trimStart();
}
