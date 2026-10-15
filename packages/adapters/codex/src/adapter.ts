import {
  CliProcesses,
  cliOutcome,
  DEFAULT_SCRUB_ENV,
  healthcheck,
  isMissingSession,
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
  UsageRecord,
} from "@navarch/contracts";
import { codexSessionsDir, readCodexLimits } from "./limits.ts";
import { parseCodexLine } from "./stream.ts";

/**
 * Runs Codex CLI headless (`codex exec --json`) in the sandbox. Codex has no per-command
 * allowlist in exec mode, so the grant is enforced by its OS sandbox instead:
 * `workspace-write` (writes only inside the worktree), network off unless granted, and no
 * approval prompts. Decision: ADR 0004.
 */

export type CodexOptions = {
  command?: string;
  commandArgs?: string[];
  scrubEnv?: string[];
  killGraceMs?: number;
  /** Where Codex keeps session files, read for plan limits (default `$CODEX_HOME/sessions`). */
  sessionsDir?: string;
};

export class CodexAdapter implements AgentAdapter {
  readonly id = "codex";
  private readonly options: Required<CodexOptions>;
  private readonly processes: CliProcesses;

  constructor(options: CodexOptions = {}) {
    this.options = {
      command: options.command ?? "codex",
      commandArgs: options.commandArgs ?? [],
      scrubEnv: options.scrubEnv ?? DEFAULT_SCRUB_ENV,
      killGraceMs: options.killGraceMs ?? 5_000,
      sessionsDir: options.sessionsDir ?? codexSessionsDir(),
    };
    this.processes = new CliProcesses(this.options.killGraceMs);
  }

  capabilities(): AdapterCapabilities {
    return { streaming: true, ownTools: true, resumable: true, enforcement: "sandbox" };
  }

  healthcheck(): Promise<HealthStatus> {
    return healthcheck(this.options.command, [...this.options.commandArgs, "--version"]);
  }

  async run(ctx: TaskContext, io: AdapterIO): Promise<TaskResult> {
    if (ctx.resumeToken) {
      const result = await this.attempt(ctx, io, ctx.resumeToken);
      if (!isMissingSession(result)) return result;
      io.emit({ kind: "progress", message: "previous session not found, starting a new one" });
    }
    return this.attempt(ctx, io);
  }

  cancel(taskId: string): Promise<void> {
    return this.processes.cancel(taskId);
  }

  stopAll(): Promise<void> {
    return this.processes.stopAll();
  }

  /** Arguments for `codex exec` (new thread) or `codex exec resume <id>`; the prompt comes from stdin. */
  buildArgs(ctx: TaskContext, resume?: string): string[] {
    const sandbox = ctx.tools.editFiles ? "workspace-write" : "read-only";
    const config = [
      `sandbox_mode="${sandbox}"`,
      `approval_policy="never"`,
      `sandbox_workspace_write.network_access=${ctx.tools.network}`,
    ].flatMap((c) => ["-c", c]);
    const model = ctx.model ? ["-m", ctx.model] : [];
    const common = ["--json", "--skip-git-repo-check", ...config, ...model];
    return resume
      ? [...this.options.commandArgs, "exec", "resume", ...common, resume, "-"]
      : [...this.options.commandArgs, "exec", ...common, "-"];
  }

  private async attempt(ctx: TaskContext, io: AdapterIO, resume?: string): Promise<TaskResult> {
    let lastText = "";
    let failure = "";
    let sawTurnEnd = false;
    const usage: UsageRecord = { model: ctx.model ?? "codex", tokens_in: 0, tokens_out: 0, cached_tokens: 0, cost: 0 };

    let threadId = resume ?? "";
    const exit = await this.processes.run({
      taskId: ctx.taskId,
      command: this.options.command,
      args: this.buildArgs(ctx, resume),
      cwd: ctx.sandbox.path,
      env: scrubbedEnv(this.options.scrubEnv),
      stdin: resume ? (ctx.resumePrompt ?? RESUME_PROMPT) : ctx.instructions,
      timeoutMs: ctx.budget.timeoutMs,
      onLine: (line) => {
        io.emit({ kind: "log", line });
        const item = parseCodexLine(line);
        if (!item) return;
        switch (item.kind) {
          case "thread":
            if (item.threadId) threadId = item.threadId;
            if (!resume && item.threadId) io.emit({ kind: "resume_token", token: item.threadId });
            break;
          case "text":
            lastText = item.text;
            io.emit({ kind: "progress", message: item.text.slice(0, 500) });
            break;
          case "command":
            io.emit({
              kind: "progress",
              message: `$ ${item.command.slice(0, 200)}${item.exitCode ? ` (exit ${item.exitCode})` : ""}`,
              tool: "shell",
            });
            break;
          case "file_change":
            io.emit({ kind: "progress", message: `edited ${item.paths.join(", ").slice(0, 200)}`, tool: "edit" });
            break;
          case "usage":
            sawTurnEnd = true;
            usage.tokens_in += item.tokensIn;
            usage.tokens_out += item.tokensOut;
            usage.cached_tokens += item.cached;
            break;
          case "failed":
            failure = item.message;
            break;
        }
      },
    });
    if (exit.stderr.trim()) io.emit({ kind: "log", line: `[stderr] ${exit.stderr.trim()}` });
    const usageList = usage.tokens_in || usage.tokens_out ? [usage] : [];
    const final = sawTurnEnd || failure
      ? { ok: sawTurnEnd && !failure, summary: lastText, usage: usageList, ...(failure ? { error: failure } : {}) }
      : undefined;
    const outcome = cliOutcome("codex", exit, final, lastText);

    const limits = readCodexLimits(this.options.sessionsDir, threadId);
    for (const l of limits) {
      io.emit({ kind: "quota", window: l.window, utilization: l.utilization, ...(l.resetsAt ? { resetsAt: l.resetsAt } : {}), exhausted: l.exhausted });
    }
    if (outcome.error?.kind !== "rate_limited" || outcome.error.retry_at) return outcome;
    const resets = limits.filter((l) => l.exhausted && l.resetsAt).map((l) => l.resetsAt!);
    return withRetryAt(outcome, resets.sort().at(-1));
  }
}

export const RESUME_PROMPT =
  "You were interrupted. Continue the same task from where you stopped, then finish with a short summary.";
