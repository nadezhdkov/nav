import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { CliProcesses, cliOutcome, DEFAULT_SCRUB_ENV, failed, healthcheck, parsePattern, scrubbedEnv } from "@navarch/adapter-kit";
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
import { parseAgyLine } from "./stream.ts";

/**
 * Runs the Antigravity CLI headless (`agy -p … --output-format stream-json`) in the sandbox.
 * agy reads permission rules only from its user settings, so each task gets its own HOME with a
 * generated `settings.json`; the Google login lives in the system keyring and still applies.
 * The same HOME keeps the conversation for resume. Decision: ADR 0004.
 */

export type AntigravityOptions = {
  command?: string;
  commandArgs?: string[];
  scrubEnv?: string[];
  killGraceMs?: number;
  /** Where per-task agy homes are kept (default: a directory under the OS temp dir). */
  homeRoot?: string;
};

/** Characters that could chain or redirect commands past an allow rule. */
const NO_SHELL_META = "[^;&|`$<>(){}\\\\\\n]";

export type AgyPermissions = { allow: string[]; deny: string[] };

/** agy permission rules for a grant. Rules are `action(target)`; commands use RE2 regexes. */
export function agyPermissions(grant: ToolGrant, home = homedir()): AgyPermissions {
  const allow: string[] = [];
  const deny: string[] = [];
  for (const pattern of grant.allowCommands) {
    const p = parsePattern(pattern);
    const base = escapeRegExp(p.prefix);
    allow.push(p.wildcard ? `command(regex:^${base}( ${NO_SHELL_META}*)?$)` : `command(regex:^${base}$)`);
  }
  for (const prefix of grant.denyCommands) deny.push(`command(regex:^${escapeRegExp(prefix)}( .*)?$)`);
  for (const path of grant.denyPaths) {
    const abs = path === "~" ? home : path.startsWith("~/") ? join(home, path.slice(2)) : path;
    deny.push(`read_file(${abs})`, `write_file(${abs})`);
  }
  if (!grant.network) deny.push("read_url(*)", "execute_url(*)");
  return { allow, deny };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export class AntigravityAdapter implements AgentAdapter {
  readonly id = "antigravity";
  private readonly options: Required<AntigravityOptions>;
  private readonly processes: CliProcesses;

  constructor(options: AntigravityOptions = {}) {
    this.options = {
      command: options.command ?? "agy",
      commandArgs: options.commandArgs ?? [],
      scrubEnv: options.scrubEnv ?? DEFAULT_SCRUB_ENV,
      killGraceMs: options.killGraceMs ?? 5_000,
      homeRoot: options.homeRoot ?? join(tmpdir(), "navarch-agy"),
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
    const home = this.taskHome(ctx);
    const settingsDir = join(home, ".gemini", "antigravity-cli");
    mkdirSync(settingsDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(settingsDir, "settings.json"), JSON.stringify({ permissions: agyPermissions(ctx.tools) }, null, 2), {
      mode: 0o600,
    });

    let conversation = ctx.resumeToken;
    if (conversation && !existsSync(join(settingsDir, "conversations", `${conversation}.db`))) {
      io.emit({ kind: "progress", message: "previous conversation not found, starting a new one" });
      conversation = undefined;
    }
    let prompt = conversation ? RESUME_PROMPT : ctx.instructions;
    // agy reports usage cumulatively per conversation; record each turn's share.
    let seen: UsageRecord | undefined;
    const usage: UsageRecord[] = [];
    let result: TaskResult;
    for (let turn = 0; ; turn++) {
      const outcome = await this.attempt(ctx, io, home, prompt, conversation);
      conversation = outcome.conversationId ?? conversation;
      for (const u of outcome.result.usage) {
        usage.push(seen ? { ...u, tokens_in: u.tokens_in - seen.tokens_in, tokens_out: u.tokens_out - seen.tokens_out, cached_tokens: u.cached_tokens - seen.cached_tokens } : u);
        seen = u;
      }
      result = { ...outcome.result, usage };
      // A denied tool ends agy's turn. Tell the agent and let it carry on without that tool.
      if (result.status !== "succeeded" || !outcome.denied.length || !conversation) break;
      if (turn >= MAX_DENIED_TURNS) {
        result = failed("fatal", `stopped after ${MAX_DENIED_TURNS} turns ending in a denied tool`, result.summary, usage);
        break;
      }
      io.emit({ kind: "progress", message: "a tool was denied by policy; continuing without it" });
      prompt = deniedPrompt(outcome.denied, ctx.tools.allowCommands);
    }
    // Keep the home after a failure so a retry can resume the conversation.
    if (result.status === "succeeded" || result.error?.kind === "cancelled") rmSync(home, { recursive: true, force: true });
    return result;
  }

  cancel(taskId: string): Promise<void> {
    return this.processes.cancel(taskId);
  }

  stopAll(): Promise<void> {
    return this.processes.stopAll();
  }

  private taskHome(ctx: TaskContext): string {
    const safe = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, "_");
    return join(this.options.homeRoot, `${safe(ctx.runId)}-${safe(ctx.taskId)}`);
  }

  private async attempt(
    ctx: TaskContext,
    io: AdapterIO,
    home: string,
    prompt: string,
    resume: string | undefined,
  ): Promise<{ result: TaskResult; denied: string[]; conversationId?: string }> {
    const args = [
      ...this.options.commandArgs,
      "--print",
      prompt,
      "--output-format",
      "stream-json",
      "--mode",
      ctx.tools.editFiles ? "accept-edits" : "plan",
    ];
    if (resume) args.push("--conversation", resume);
    if (ctx.model) args.push("--model", ctx.model);

    const realHome = homedir();
    const gitConfig = join(realHome, ".gitconfig");
    const env = scrubbedEnv(this.options.scrubEnv, {
      HOME: home,
      ...(existsSync(gitConfig) ? { GIT_CONFIG_GLOBAL: gitConfig } : {}),
    });

    let model = ctx.model ?? "antigravity";
    let text = "";
    let lastText = "";
    let lastTool = { name: "", summary: "" };
    let conversationId: string | undefined;
    const denied: string[] = [];
    let final: { ok: boolean; error?: string; summary: string; usage: UsageRecord[] } | undefined;

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
      env,
      timeoutMs: ctx.budget.timeoutMs,
      onLine: (line) => {
        io.emit({ kind: "log", line });
        const item = parseAgyLine(line, model);
        if (!item) return;
        switch (item.kind) {
          case "init":
            if (item.model) model = item.model;
            if (item.conversationId) conversationId = item.conversationId;
            if (item.conversationId && item.conversationId !== resume) io.emit({ kind: "resume_token", token: item.conversationId });
            break;
          case "text":
            text += item.text;
            break;
          case "tool":
            flushText();
            lastTool = { name: item.name, summary: item.summary };
            io.emit({ kind: "progress", message: item.summary, tool: item.name });
            break;
          case "tool_error":
            io.emit({ kind: "log", line: `[tool error] ${item.summary}: ${item.message}` });
            break;
          case "result":
            flushText();
            // A denied tool ends the turn, so the denied call is the last tool started.
            for (const action of item.denied) {
              io.emit({ kind: "denied", tool: lastTool.name || action, input: lastTool.summary || action });
              denied.push(lastTool.summary || action);
            }
            final = {
              ok: item.ok,
              summary: item.response || lastText,
              usage: item.usage,
              ...(item.error ? { error: item.error } : item.ok ? {} : { error: `agy finished with status ${item.status}` }),
            };
            break;
        }
      },
    });
    flushText();
    if (exit.stderr.trim()) io.emit({ kind: "log", line: `[stderr] ${exit.stderr.trim()}` });
    const result =
      exit.code === 0 && !final && !exit.cancelled && !exit.timedOut
        ? failed("fatal", "agy exited without a result event", lastText)
        : cliOutcome("agy", exit, final, lastText);
    return { result, denied, ...(conversationId ? { conversationId } : {}) };
  }
}

/** Continuations allowed after turns that ended in a denied tool, before the task fails. */
export const MAX_DENIED_TURNS = 5;

export function deniedPrompt(denied: string[], allowCommands: string[]): string {
  const allowed = allowCommands.length ? allowCommands.join(", ") : "none";
  return (
    `The policy denied: ${denied.join("; ")}. Do not retry it, and do not chain commands with &&, ; or |. ` +
    `Shell commands allowed: ${allowed}. Continue the task without the denied action, then finish with a short summary.`
  );
}

export const RESUME_PROMPT =
  "You were interrupted. Continue the same task from where you stopped, then finish with a short summary.";
