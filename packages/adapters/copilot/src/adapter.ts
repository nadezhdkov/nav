import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
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
  UsageRecord,
} from "@navarch/contracts";
import { parseCopilotLine, parseCopilotUsage } from "./stream.ts";

/**
 * Runs GitHub Copilot CLI headless (`copilot -p … --output-format json`) in the sandbox. The
 * grant becomes `--allow-tool` / `--deny-tool` rules, which Copilot checks per command (a chained
 * `ls && printf > f` was denied with only `shell(ls)` allowed), and its path verification keeps
 * file access inside the worktree. Built-in MCP servers are off: they would reach GitHub with
 * the operator's credential, and only the GitHub Integration talks to GitHub (rule 5).
 * Decision: ADR 0012.
 */

export type CopilotOptions = {
  command?: string;
  commandArgs?: string[];
  scrubEnv?: string[];
  killGraceMs?: number;
};

/** Translates the neutral grant into Copilot permission rules. */
export function copilotRules(grant: ToolGrant): { allow: string[]; deny: string[] } {
  const allow = [...(grant.editFiles ? ["write"] : []), ...grant.allowCommands.map(shellRule)];
  const deny = [
    ...grant.denyCommands.map((prefix) => `shell(${prefix}:*)`),
    ...grant.denyPaths.map((path) => `write(${path.replace(/^~(?=\/|$)/, homedir())})`),
    ...(grant.network ? [] : ["url"]),
    ...(grant.editFiles ? [] : ["write"]),
  ];
  return { allow, deny };
}

/** `npm test` → `shell(npm test)`, `npm run *` → `shell(npm run:*)`. */
export function shellRule(pattern: string): string {
  const p = parsePattern(pattern);
  return p.wildcard ? `shell(${p.prefix}:*)` : `shell(${p.prefix})`;
}

/** Premium requests reset at 00:00 UTC on the first day of each month. */
export function nextMonthlyReset(now = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();
}

const MONTHLY_QUOTA = /premium request|monthly|ai credit/i;

export class CopilotAdapter implements AgentAdapter {
  readonly id = "copilot";
  private readonly options: Required<CopilotOptions>;
  private readonly processes: CliProcesses;

  constructor(options: CopilotOptions = {}) {
    this.options = {
      command: options.command ?? "copilot",
      commandArgs: options.commandArgs ?? [],
      scrubEnv: options.scrubEnv ?? DEFAULT_SCRUB_ENV,
      killGraceMs: options.killGraceMs ?? 5_000,
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

  buildArgs(ctx: TaskContext, session: { resume?: string; sessionId?: string }, usageFile: string): string[] {
    const rules = copilotRules(ctx.tools);
    return [
      ...this.options.commandArgs,
      "-p",
      session.resume ? (ctx.resumePrompt ?? RESUME_PROMPT) : ctx.instructions,
      ...(session.resume ? ["--resume", session.resume] : ["--session-id", session.sessionId!]),
      "--output-format",
      "json",
      "--no-ask-user",
      "--no-auto-update",
      "--disable-builtin-mcps",
      "--disallow-temp-dir",
      "--usage-output-file",
      usageFile,
      ...(ctx.model ? ["--model", ctx.model] : []),
      ...rules.allow.map((r) => `--allow-tool=${r}`),
      ...rules.deny.map((r) => `--deny-tool=${r}`),
    ];
  }

  private async attempt(ctx: TaskContext, io: AdapterIO, session: { resume?: string; sessionId?: string }): Promise<TaskResult> {
    let lastText = "";
    let failure = "";
    let result: { exitCode: number } | undefined;
    const commands = new Map<string, string>();
    const usageDir = mkdtempSync(join(tmpdir(), "navarch-copilot-"));
    const usageFile = join(usageDir, "usage.json");

    try {
      const exit = await this.processes.run({
        taskId: ctx.taskId,
        command: this.options.command,
        args: this.buildArgs(ctx, session, usageFile),
        cwd: ctx.sandbox.path,
        env: scrubbedEnv(this.options.scrubEnv),
        timeoutMs: ctx.budget.timeoutMs,
        onLine: (line) => {
          io.emit({ kind: "log", line });
          const item = parseCopilotLine(line);
          if (!item) return;
          switch (item.kind) {
            case "text":
              lastText = item.text;
              io.emit({ kind: "progress", message: item.text.slice(0, 500) });
              break;
            case "tool_start":
              commands.set(item.callId, item.command ?? item.tool);
              if (item.command) io.emit({ kind: "progress", message: `$ ${item.command.slice(0, 200)}`, tool: "shell" });
              break;
            case "tool_done":
              if (item.denied) io.emit({ kind: "denied", tool: "shell", input: commands.get(item.callId) ?? "" });
              else if (item.paths.length) io.emit({ kind: "progress", message: `edited ${item.paths.join(", ").slice(0, 200)}`, tool: "edit" });
              break;
            case "failed":
              failure = item.message;
              break;
            case "result":
              result = item;
              break;
          }
        },
      });
      if (exit.stderr.trim()) io.emit({ kind: "log", line: `[stderr] ${exit.stderr.trim()}` });

      const usage = readUsage(usageFile, ctx.model);
      const final = result || failure
        ? { ok: result?.exitCode === 0 && !failure, summary: lastText, usage, ...(failure ? { error: failure } : {}) }
        : undefined;
      const outcome = cliOutcome("copilot", exit, final, lastText);
      if (outcome.error?.kind !== "rate_limited" || outcome.error.retry_at) return outcome;
      if (!MONTHLY_QUOTA.test(`${outcome.error.message}\n${exit.stderr}`)) return outcome;
      const resetsAt = nextMonthlyReset();
      io.emit({ kind: "quota", window: "premium_requests_monthly", resetsAt, exhausted: true });
      return withRetryAt(outcome, resetsAt);
    } finally {
      rmSync(usageDir, { recursive: true, force: true });
    }
  }
}

function readUsage(file: string, model: string | undefined): UsageRecord[] {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const u = parseCopilotUsage(text);
  if (!u || !(u.tokensIn || u.tokensOut)) return [];
  return [{ model: u.model || model || "copilot", tokens_in: u.tokensIn, tokens_out: u.tokensOut, cached_tokens: u.cached, cost: 0 }];
}

export const RESUME_PROMPT =
  "You were interrupted. Continue the same task from where you stopped, then finish with a short summary.";
