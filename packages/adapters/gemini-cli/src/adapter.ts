import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
} from "@vectr/adapter-kit";
import type {
  AdapterCapabilities,
  AdapterIO,
  AgentAdapter,
  HealthStatus,
  TaskContext,
  TaskError,
  TaskResult,
  ToolGrant,
  UsageRecord,
} from "@vectr/contracts";
import { parseGeminiLine } from "./stream.ts";

/**
 * Runs Gemini CLI headless (`gemini -p … --output-format stream-json`) in the sandbox.
 * The grant becomes a Gemini policy file (TOML) passed with `--policy`. Decision: ADR 0004.
 *
 * Each task gets its own Gemini home (`GEMINI_CLI_HOME`) whose settings select API-key auth,
 * because Google no longer accepts Google-account login from the CLI and the user's own
 * `~/.gemini/settings.json` may still select it. The home links the user's `~/.gemini/.env`
 * (the key is never copied) and keeps the session for resume.
 */

export type GeminiCliOptions = {
  command?: string;
  commandArgs?: string[];
  scrubEnv?: string[];
  killGraceMs?: number;
  /** Where per-task Gemini homes are kept (default: a directory under the OS temp dir). */
  homeRoot?: string;
  /** Home holding the user's `.gemini/.env` with `GEMINI_API_KEY` (default: the OS home). */
  userHome?: string;
};

const API_KEY_SETTINGS = { security: { auth: { selectedType: "gemini-api-key" } } };

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
      homeRoot: options.homeRoot ?? join(tmpdir(), "vectr-gemini"),
      userHome: options.userHome ?? homedir(),
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
    const userEnv = join(this.options.userHome, ".gemini", ".env");
    if (!process.env.GEMINI_API_KEY && !existsSync(userEnv)) {
      return missingKey(`gemini-cli needs an AI Studio key: set GEMINI_API_KEY for vectrd or put it in ${userEnv}. Google-account login is no longer accepted.`);
    }
    const home = this.taskHome(ctx);
    const geminiDir = join(home, ".gemini");
    mkdirSync(geminiDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(geminiDir, "settings.json"), JSON.stringify(API_KEY_SETTINGS, null, 2), { mode: 0o600 });
    const linkedEnv = join(geminiDir, ".env");
    if (existsSync(userEnv) && !existsSync(linkedEnv)) symlinkSync(userEnv, linkedEnv);
    const policyFile = join(home, "vectr-policy.toml");
    writeFileSync(policyFile, geminiPolicy(ctx.tools), { mode: 0o600 });

    let result: TaskResult | undefined;
    if (ctx.resumeToken) {
      result = await this.attempt(ctx, io, home, policyFile, { resume: ctx.resumeToken });
      if (isMissingSession(result)) {
        io.emit({ kind: "progress", message: "previous session not found, starting a new one" });
        result = undefined;
      }
    }
    if (!result) {
      const sessionId = randomUUID();
      io.emit({ kind: "resume_token", token: sessionId });
      result = await this.attempt(ctx, io, home, policyFile, { sessionId });
    }
    // Keep the home after a failure so a retry can resume the session.
    if (result.status === "succeeded" || result.error?.kind === "cancelled") rmSync(home, { recursive: true, force: true });
    return result;
  }

  private taskHome(ctx: TaskContext): string {
    const safe = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, "_");
    return join(this.options.homeRoot, `${safe(ctx.runId)}-${safe(ctx.taskId)}`);
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
    home: string,
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
      env: scrubbedEnv(this.options.scrubEnv, { GEMINI_CLI_HOME: home }),
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

function missingKey(message: string): TaskResult {
  const error: TaskError = { kind: "fatal", message };
  return { status: "failed", summary: "", artifacts: [], claims: [], usage: [], error };
}
