import type { ErrorKind, TaskResult, UsageRecord } from "@vectr/contracts";
import type { CliExit } from "./process.ts";
import { retryAtFromText } from "./retry.ts";

/** Environment variables removed before spawning an agent, so it never sees them. */
export const DEFAULT_SCRUB_ENV = ["GITHUB_TOKEN", "GH_TOKEN", "GITHUB_PAT", "VECTR_GITHUB_TOKEN", "OPENROUTER_API_KEY"];

export function scrubbedEnv(names: string[] = DEFAULT_SCRUB_ENV, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = { ...process.env, ...extra };
  for (const name of names) delete env[name];
  return env;
}

export function classifyError(text: string): ErrorKind {
  const t = text.toLowerCase();
  if (t.includes("budget")) return "budget_exceeded";
  if (/rate.?limit|\b429\b|overloaded|quota|resource.?exhausted|too many requests|usage limit|hit your limit|limit reached/.test(t)) {
    return "rate_limited";
  }
  if (/timeout|timed out|econnreset|econnrefused|network|socket hang up|\b50[234]\b/.test(t)) return "transient";
  return "fatal";
}

export function failed(kind: ErrorKind, message: string, summary = "", usage: UsageRecord[] = []): TaskResult {
  return { status: "failed", summary, artifacts: [], claims: [], usage, error: { kind, message } };
}

export function succeeded(summary: string, usage: UsageRecord[]): TaskResult {
  return { status: "succeeded", summary, artifacts: [], claims: [], usage };
}

/**
 * Common outcome mapping for CLI adapters. `final` is what the CLI reported at the end (if it
 * reported anything); everything else comes from the process exit.
 */
export function cliOutcome(
  cli: string,
  exit: CliExit,
  final: { ok: boolean; error?: string; summary: string; usage: UsageRecord[] } | undefined,
  lastText: string,
): TaskResult {
  const usage = final?.usage ?? [];
  if (exit.cancelled) return failed("cancelled", "cancelled by user", lastText, usage);
  if (exit.spawnError) return failed("fatal", `could not start ${cli}: ${exit.spawnError.message}`, "", usage);
  if (exit.timedOut) return failed("transient", `${cli} timed out`, lastText, usage);
  if (final?.ok && exit.code === 0) return succeeded(final.summary || lastText, usage);
  const message =
    final?.error || exit.stderr.trim().split("\n").slice(-5).join("\n") || `${cli} exited with ${exit.signal ?? `code ${exit.code}`}`;
  const result = failed(classifyError(message), message, final?.summary || lastText, usage);
  return result.error?.kind === "rate_limited" ? withRetryAt(result, retryAtFromText(`${message}\n${exit.stderr}`)) : result;
}

/** Adds the provider's reset time to a rate-limited result. */
export function withRetryAt(result: TaskResult, retryAt: string | undefined): TaskResult {
  if (!retryAt || !result.error) return result;
  return { ...result, error: { ...result.error, retry_at: retryAt } };
}

export function isMissingSession(result: TaskResult): boolean {
  const message = result.error?.message.toLowerCase() ?? "";
  return (
    result.status === "failed" &&
    /no conversation found|session.*not found|invalid session identifier|no (rollout|session|thread) found|thread.*not found/.test(message)
  );
}

/** Short human-readable form of a tool call for progress events. */
export function toolSummary(name: string, input: unknown): string {
  if (typeof input !== "object" || input === null) return name;
  const o = input as Record<string, unknown>;
  const pick = (k: string) => (typeof o[k] === "string" ? (o[k] as string) : "");
  const target = pick("file_path") || pick("path") || pick("absolute_path") || pick("pattern") || pick("command") || pick("dir_path");
  return target ? `${name} ${target.slice(0, 200)}` : name;
}
