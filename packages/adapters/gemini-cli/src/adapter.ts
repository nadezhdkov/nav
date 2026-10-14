import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CliProcesses,
  cliOutcome,
  DEFAULT_SCRUB_ENV,
  healthcheck,
  isMissingSession,
  parsePattern,
  scrubbedEnv,
} from "@vectr/adapter-kit";
import type {
  AdapterCapabilities,
  AdapterIO,
  AgentAdapter,
  HealthStatus,
  TaskContext,
  TaskResult,
  ToolGrant,
  UsageRecord,
} from "@vectr/contracts";
import { parseGeminiLine } from "./stream.ts";

/**
 * Runs Gemini CLI headless (`gemini -p … --output-format stream-json`) in the sandbox.
 * The grant becomes a Gemini policy file (TOML) passed with `--policy`. Decision: ADR 0004.
 */

export type GeminiCliOptions = {
  command?: string;
  commandArgs?: string[];
  scrubEnv?: string[];
  killGraceMs?: number;
};

const ALLOW_PRIORITY = 500;
const DENY_PRIORITY = 999;

/** Gemini policy rules for a grant. Gemini file tools are already limited to the workspace. */
export function geminiPolicy(grant: ToolGrant): string {
  const rules: string[] = [];
  const rule = (fields: Record<string, string | number>) =>
    rules.push(
      "[[rule]]\n" +
        Object.entries(fields)
          .map(([k, v]) => `${k} = ${typeof v === "number" ? v : JSON.stringify(v)}`)
          .join("\n"),
    );

  for (const prefix of grant.denyCommands) {
    rule({ toolName: "run_shell_command", commandPrefix: prefix, decision: "deny", priority: DENY_PRIORITY });
  }
  if (!grant.network) {
    for (const tool of ["web_fetch", "google_web_search"]) rule({ toolName: tool, decision: "deny", priority: DENY_PRIORITY });
  }
  for (const pattern of grant.allowCommands) {
    const p = parsePattern(pattern);
    if (p.wildcard) {
      rule({ toolName: "run_shell_command", commandPrefix: p.prefix, decision: "allow", priority: ALLOW_PRIORITY });
    } else {
      rule({ toolName: "run_shell_command", commandRegex: `^${escapeRegExp(p.prefix)}$`, decision: "allow", priority: ALLOW_PRIORITY });
    }
  }
  return rules.join("\n\n") + "\n";
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export class GeminiCliAdapter implements AgentAdapter {
  readonly id = "gemini-cli";
  private readonly options: Required<GeminiCliOptions>;
  private readonly processes: CliProcesses;

  constructor(options: GeminiCliOptions = {}) {
    this.options = {
      command: options.command ?? "gemini",
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
    const dir = mkdtempSync(join(tmpdir(), "vectr-gemini-"));
    const policyFile = join(dir, "vectr-policy.toml");
    writeFileSync(policyFile, geminiPolicy(ctx.tools), { mode: 0o600 });
    try {
      if (ctx.resumeToken) {
        const result = await this.attempt(ctx, io, policyFile, { resume: ctx.resumeToken });
        if (!isMissingSession(result)) return result;
        io.emit({ kind: "progress", message: "previous session not found, starting a new one" });
      }
      const sessionId = randomUUID();
      io.emit({ kind: "resume_token", token: sessionId });
      return await this.attempt(ctx, io, policyFile, { sessionId });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  cancel(taskId: string): Promise<void> {
    return this.processes.cancel(taskId);
  }

  stopAll(): Promise<void> {
    return this.processes.stopAll();
  }

  private async attempt(
    ctx: TaskContext,
    io: AdapterIO,
    policyFile: string,
    session: { resume?: string; sessionId?: string },
  ): Promise<TaskResult> {
    const prompt = session.resume ? RESUME_PROMPT : ctx.instructions;
    const args = [
      ...this.options.commandArgs,
      "--prompt",
      prompt,
      "--output-format",
      "stream-json",
      "--approval-mode",
      ctx.tools.editFiles ? "auto_edit" : "plan",
      "--policy",
      policyFile,
      "--skip-trust",
    ];
    if (session.resume) args.push("--resume", session.resume);
    else if (session.sessionId) args.push("--session-id", session.sessionId);
    if (ctx.model) args.push("--model", ctx.model);

    const tools = new Map<string, { name: string; summary: string }>();
    let text = "";
    let lastText = "";
    let final: { ok: boolean; error?: string; summary: string; usage: UsageRecord[] } | undefined;
    let streamError = "";

    const flushText = () => {
      if (text.trim()) {
        lastText = text.trim();
        io.emit({ kind: "progress", message: lastText.slice(0, 500) });
      }
      text = "";
    };

    const exit = await this.processes.run({
      taskId: ctx.taskId,
      command: this.options.command,
      args,
      cwd: ctx.sandbox.path,
      env: scrubbedEnv(this.options.scrubEnv),
      timeoutMs: ctx.budget.timeoutMs,
      onLine: (line) => {
        io.emit({ kind: "log", line });
        const item = parseGeminiLine(line);
        if (!item) return;
        switch (item.kind) {
          case "text":
            if (item.delta) text += item.text;
            else {
              flushText();
              text = item.text;
              flushText();
            }
            break;
          case "tool":
            flushText();
            tools.set(item.id, { name: item.name, summary: item.summary });
            io.emit({ kind: "progress", message: item.summary, tool: item.name });
            break;
          case "tool_result":
            if (!item.ok && item.errorType === "policy_violation") {
              const tool = tools.get(item.id);
              io.emit({ kind: "denied", tool: tool?.name ?? "unknown", input: tool?.summary ?? item.message ?? "" });
            }
            break;
          case "error":
            streamError = item.message;
            break;
          case "result":
            flushText();
            final = {
              ok: item.ok,
              summary: lastText,
              usage: item.usage,
              ...(item.error ? { error: item.error } : {}),
            };
            break;
        }
      },
    });
    flushText();
    if (exit.stderr.trim()) io.emit({ kind: "log", line: `[stderr] ${exit.stderr.trim()}` });
    if (final && !final.ok && !final.error && streamError) final.error = streamError;
    if (!final && streamError) final = { ok: false, error: streamError, summary: lastText, usage: [] };
    return cliOutcome("gemini", exit, final, lastText);
  }
}

export const RESUME_PROMPT =
  "You were interrupted. Continue the same task from where you stopped, then finish with a short summary.";
