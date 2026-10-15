import { randomUUID } from "node:crypto";
import {
  CliProcesses,
  cliOutcome,
  DEFAULT_SCRUB_ENV,
  healthcheck,
  isMissingSession,
  parsePattern,
  scrubbedEnv,
  withRetryAt,
} from "@navarch/adapter-kit";
import type {
  AdapterCapabilities,
  AdapterIO,
  AgentAdapter,
  HealthStatus,
  TaskContext,
  TaskResult,
  ToolGrant,
} from "@navarch/contracts";
import { parseLine, type ClaudeLimit, type ClaudeResult } from "./stream.ts";

/**
 * Runs Claude Code as a headless subprocess (`claude -p --output-format stream-json`)
 * inside the task's sandbox. Decision: ADR 0003.
 */

export type ClaudeCodeOptions = {
  /** Executable, `claude` by default. */
  command?: string;
  /** Arguments placed before Navarch's own (used by tests to run a fake CLI through node). */
  commandArgs?: string[];
  /** Claude Code permission mode. `acceptEdits` lets it edit files; other tools follow the grant. */
  permissionMode?: string;
  /** Environment variables removed before spawning, so the agent never sees them. */
  scrubEnv?: string[];
  /** Grace period between SIGTERM and SIGKILL on cancel. */
  killGraceMs?: number;
  /**
   * `--setting-sources`: which Claude Code settings to load. The default leaves out `user`, so the
   * operator's own `~/.claude` (CLAUDE.md, hooks, plugins) does not steer the task; the
   * repository's project settings still apply.
   */
  settingSources?: string;
};

const READ_TOOLS = ["Read", "Glob", "Grep", "LS", "TodoWrite"];
const EDIT_TOOLS = ["Edit", "Write", "MultiEdit", "NotebookEdit"];

/** Translates the neutral grant into Claude Code permission rules. */
export function claudeRules(grant: ToolGrant): { allow: string[]; deny: string[] } {
  const allow = [...READ_TOOLS, ...(grant.editFiles ? EDIT_TOOLS : []), ...grant.allowCommands.map(bashRule)];
  const deny = [
    ...grant.denyCommands.map((prefix) => `Bash(${prefix}:*)`),
    ...grant.denyPaths.flatMap((path) => [`Read(${path}/**)`, `Edit(${path}/**)`]),
    ...(grant.network ? [] : ["WebFetch", "WebSearch"]),
    ...(grant.editFiles ? [] : EDIT_TOOLS),
  ];
  return { allow, deny };
}

/** `npm test` → `Bash(npm test)`, `npm run *` → `Bash(npm run:*)`. */
export function bashRule(pattern: string): string {
  const p = parsePattern(pattern);
  return p.wildcard ? `Bash(${p.prefix}:*)` : `Bash(${p.prefix})`;
}

export class ClaudeCodeAdapter implements AgentAdapter {
  readonly id = "claude-code";
  private readonly options: Required<ClaudeCodeOptions>;
  private readonly processes: CliProcesses;

  constructor(options: ClaudeCodeOptions = {}) {
    this.options = {
      command: options.command ?? "claude",
      commandArgs: options.commandArgs ?? [],
      permissionMode: options.permissionMode ?? "acceptEdits",
      scrubEnv: options.scrubEnv ?? DEFAULT_SCRUB_ENV,
      killGraceMs: options.killGraceMs ?? 5_000,
      settingSources: options.settingSources ?? "project,local",
    };
    this.processes = new CliProcesses(this.options.killGraceMs);
  }

  capabilities(): AdapterCapabilities {
    return { streaming: true, ownTools: true, resumable: true, enforcement: "exact" };
  }

  healthcheck(): Promise<HealthStatus> {
    return healthcheck(this.options.command, [...this.options.commandArgs, "--version"]);
  }

  async run(ctx: TaskContext, io: AdapterIO): Promise<TaskResult> {
    if (ctx.resumeToken) {
      const result = await this.attempt(ctx, io, { resume: ctx.resumeToken });
      if (!isMissingSession(result)) return result;
      io.emit({ kind: "progress", message: "previous session not found, starting a new one" });
    }
    const sessionId = randomUUID();
    io.emit({ kind: "resume_token", token: sessionId });
    return this.attempt(ctx, io, { sessionId });
  }

  cancel(taskId: string): Promise<void> {
    return this.processes.cancel(taskId);
  }

  stopAll(): Promise<void> {
    return this.processes.stopAll();
  }

  private buildArgs(ctx: TaskContext, session: { resume?: string; sessionId?: string }): string[] {
    const rules = claudeRules(ctx.tools);
    const args = [...this.options.commandArgs, "-p", "--output-format", "stream-json", "--verbose"];
    if (session.resume) args.push("--resume", session.resume);
    else if (session.sessionId) args.push("--session-id", session.sessionId);
    args.push("--permission-mode", this.options.permissionMode);
    if (this.options.settingSources) args.push("--setting-sources", this.options.settingSources);
    if (ctx.model) args.push("--model", ctx.model);
    if (ctx.budget.maxCost > 0) args.push("--max-budget-usd", ctx.budget.maxCost.toFixed(2));
    if (rules.allow.length) args.push("--allowedTools", ...rules.allow);
    if (rules.deny.length) args.push("--disallowedTools", ...rules.deny);
    return args;
  }

  private async attempt(ctx: TaskContext, io: AdapterIO, session: { resume?: string; sessionId?: string }) {
    let result: ClaudeResult | undefined;
    let limit: ClaudeLimit | undefined;
    let lastText = "";
    const exit = await this.processes.run({
      taskId: ctx.taskId,
      command: this.options.command,
      args: this.buildArgs(ctx, session),
      cwd: ctx.sandbox.path,
      env: scrubbedEnv(this.options.scrubEnv),
      stdin: session.resume ? (ctx.resumePrompt ?? RESUME_PROMPT) : ctx.instructions,
      timeoutMs: ctx.budget.timeoutMs,
      onLine: (line) => {
        io.emit({ kind: "log", line });
        for (const item of parseLine(line)) {
          if (item.kind === "text") {
            lastText = item.text;
            io.emit({ kind: "progress", message: item.text.slice(0, 500) });
          } else if (item.kind === "tool") {
            io.emit({ kind: "progress", message: item.summary, tool: item.name });
          } else if (item.kind === "result") {
            result = item.result;
            for (const denial of item.result.denials) io.emit({ kind: "denied", ...denial });
          } else if (item.kind === "quota") {
            limit = item.limit;
            for (const w of item.limit.windows) {
              const exhausted = item.limit.status === "rejected" && w.window === item.limit.type;
              io.emit({ kind: "quota", window: w.window, utilization: w.utilization, ...(w.resetsAt ? { resetsAt: w.resetsAt } : {}), exhausted });
            }
          }
        }
      },
    });
    if (exit.stderr.trim()) io.emit({ kind: "log", line: `[stderr] ${exit.stderr.trim()}` });
    const final = result && {
      ok: result.ok,
      summary: result.text,
      usage: result.usage,
      ...(result.ok ? {} : { error: `${result.subtype}: ${result.text}` }),
    };
    // Claude Code exits non-zero on some successful runs with warnings; trust its result line.
    if (result?.ok && !exit.cancelled && !exit.timedOut) return cliOutcome("claude", { ...exit, code: 0 }, final, lastText);
    const outcome = cliOutcome("claude", exit, final, lastText);
    return limit?.status === "rejected" ? rejectedByLimit(outcome, limit) : outcome;
  }
}

export const RESUME_PROMPT =
  "You were interrupted. Continue the same task from where you stopped, then finish with a short summary.";

/** A run refused by the subscription limit waits for that window to reset. */
function rejectedByLimit(outcome: TaskResult, limit: ClaudeLimit): TaskResult {
  if (outcome.status !== "failed" || outcome.error?.kind === "cancelled") return outcome;
  const resetsAt = limit.windows.find((w) => w.window === limit.type)?.resetsAt ?? limit.resetsAt;
  const error = { kind: "rate_limited" as const, message: outcome.error?.message ?? `claude usage limit reached (${limit.type})` };
  return withRetryAt({ ...outcome, error }, resetsAt);
}
