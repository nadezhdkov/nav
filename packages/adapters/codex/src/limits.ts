import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { epochToIso } from "@navarch/adapter-kit";

/**
 * `codex exec --json` does not report plan limits, but Codex writes them to the session file
 * (`$CODEX_HOME/sessions/YYYY/MM/DD/rollout-…-<thread id>.jsonl`) in `token_count` events:
 * `rate_limits.primary|secondary = { used_percent, window_minutes, resets_at }`.
 */

export type CodexLimit = { window: string; utilization: number; resetsAt?: string; exhausted: boolean };

export function codexSessionsDir(): string {
  return join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "sessions");
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

export function readCodexLimits(sessionsDir: string, threadId: string): CodexLimit[] {
  if (!threadId || !existsSync(sessionsDir)) return [];
  let file: string | undefined;
  try {
    // Newest date directories first; the session file name ends with the thread id.
    const names = (readdirSync(sessionsDir, { recursive: true }) as string[]).filter((n) => n.endsWith(`${threadId}.jsonl`));
    file = names.sort().at(-1);
  } catch {
    return [];
  }
  if (!file) return [];

  let limits: Json | undefined;
  for (const line of readFileSync(join(sessionsDir, file), "utf8").split("\n")) {
    if (!line.includes('"rate_limits"')) continue;
    try {
      const payload = (JSON.parse(line) as Json).payload;
      if (isObject(payload) && isObject(payload.rate_limits)) limits = payload.rate_limits;
    } catch {
      // A partly written last line is skipped.
    }
  }
  if (!limits) return [];

  const reached = typeof limits.rate_limit_reached_type === "string" ? limits.rate_limit_reached_type : "";
  const out: CodexLimit[] = [];
  for (const key of ["primary", "secondary"]) {
    const w = limits[key];
    if (!isObject(w)) continue;
    const used = typeof w.used_percent === "number" ? w.used_percent : 0;
    const minutes = typeof w.window_minutes === "number" ? w.window_minutes : 0;
    out.push({
      window: minutes ? `${key}_${minutes}m` : key,
      utilization: used / 100,
      ...(typeof w.resets_at === "number" ? { resetsAt: epochToIso(w.resets_at) } : {}),
      exhausted: used >= 100 || reached === key,
    });
  }
  return out;
}
