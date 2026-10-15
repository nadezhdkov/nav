import { mkdtempSync, rmSync } from "node:fs";
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
import { parseOpencodeLine } from "./stream.ts";

/**
 * Runs OpenCode headless (`opencode run --standalone --format json`) in the sandbox, logged in
 * with the operator's OpenCode account. OpenCode Zen's free models answer only to the OpenCode
 * client (the API returns `FreeTierError` to anyone else), so they run through this CLI rather
 * than the native adapter. The grant becomes OpenCode `permission` rules passed in
 * `OPENCODE_CONFIG_CONTENT`; OpenCode checks every command of a chain against them and denies
 * paths outside the worktree (`external_directory`). The operator's global and project configs
 * are not loaded. Decision: ADR 0015.
 */

export type OpencodeOptions = {
  command?: string;
  commandArgs?: string[];
  scrubEnv?: string[];
  killGraceMs?: number;
};

type Rule = "allow" | "deny";

/** Translates the neutral grant into OpenCode permission rules (the last matching rule wins). */
export function opencodePermission(grant: ToolGrant): Record<string, Rule | Record<string, Rule>> {
  const bash: Record<string, Rule> = { "*": "deny" };
  for (const pattern of grant.allowCommands) {
    const p = parsePattern(pattern);
    bash[p.prefix] = "allow";
    if (p.wildcard) bash[`${p.prefix} *`] = "allow";
  }
  for (const prefix of grant.denyCommands) {
    bash[prefix] = "deny";
    bash[`${prefix} *`] = "deny";
  }
  // A redirection writes files even with `edit` denied (`ls > x` ran with only `ls *` allowed).
  bash["*>*"] = "deny";
  bash["*<*"] = "deny";
  for (const path of grant.denyPaths) {
    bash[`*${path}*`] = "deny";
    if (/^~(?=\/|$)/.test(path)) bash[`*${path.replace(/^~/, homedir())}*`] = "deny";
  }
  const web: Rule = grant.network ? "allow" : "deny";
  return {
    "*": "deny",
    read: "allow",
    glob: "allow",
    grep: "allow",
    lsp: "allow",
    edit: grant.editFiles ? "allow" : "deny",
    bash,
    webfetch: web,
    websearch: web,
    external_directory: "deny",
    doom_loop: "deny",
  };
}

/** OpenCode 2.0.29 answers a session id it did not create with this, at least for free models. */
const FOREIGN_SESSION = /free tier can only be used from within opencode/i;

export class OpencodeAdapter implements AgentAdapter {
  readonly id = "opencode";
  private readonly options: Required<OpencodeOptions>;
  private readonly processes: CliProcesses;

  constructor(options: OpencodeOptions = {}) {
    this.options = {
      command: options.command ?? "opencode",
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
      const result = await this.attempt(ctx, io, ctx.resumeToken);
      if (!isMissingSession(result) && !FOREIGN_SESSION.test(result.error?.message ?? "")) return result;
      io.emit({ kind: "progress", message: "previous session not found, starting a new one" });
    }
    // OpenCode names the session itself (a made-up id is refused); it arrives in the first event.
    return this.attempt(ctx, io);
  }

  cancel(taskId: string): Promise<void> {
    return this.processes.cancel(taskId);
  }

  stopAll(): Promise<void> {
    return this.processes.stopAll();
  }

  buildArgs(ctx: TaskContext, resume?: string): string[] {
    return [
      ...this.options.commandArgs,
      "run",
      "--standalone",
      "--format",
      "json",
      ...(ctx.model ? ["--model", ctx.model] : []),
      ...(resume ? ["--session", resume] : ["--title", `navarch ${ctx.runId} ${ctx.taskId}`]),
      "--",
      resume ? RESUME_PROMPT : ctx.instructions,
    ];
  }

  buildEnv(ctx: TaskContext, configDir: string): NodeJS.ProcessEnv {
    const env = scrubbedEnv(this.options.scrubEnv, {
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission: opencodePermission(ctx.tools) }),
      // An empty config directory and no project config: the operator's and the repository's
      // opencode.json (agents, MCP servers, looser permissions) never apply to a task.
      OPENCODE_CONFIG_DIR: configDir,
      OPENCODE_DISABLE_PROJECT_CONFIG: "1",
      OPENCODE_DISABLE_AUTOUPDATE: "1",
    });
    delete env.OPENCODE_CONFIG;
    return env;
  }

  private async attempt(ctx: TaskContext, io: AdapterIO, resume?: string): Promise<TaskResult> {
    let lastText = "";
    let failure = "";
    let session = resume;
    const usage = { tokensIn: 0, tokensOut: 0, cached: 0, cost: 0, steps: 0 };
    const configDir = mkdtempSync(join(tmpdir(), "navarch-opencode-"));

    try {
      const exit = await this.processes.run({
        taskId: ctx.taskId,
        command: this.options.command,
        args: this.buildArgs(ctx, resume),
        cwd: ctx.sandbox.path,
        env: this.buildEnv(ctx, configDir),
        timeoutMs: ctx.budget.timeoutMs,
        onLine: (line) => {
          io.emit({ kind: "log", line });
          const item = parseOpencodeLine(line);
          if (!item) return;
          switch (item.kind) {
            case "session":
              if (item.sessionId !== session) {
                session = item.sessionId;
                io.emit({ kind: "resume_token", token: item.sessionId });
              }
              break;
            case "text":
              lastText = item.text;
              io.emit({ kind: "progress", message: item.text.slice(0, 500) });
              break;
            case "tool": {
              const input = item.command ?? item.path ?? "";
              if (item.denied) io.emit({ kind: "denied", tool: item.tool, input });
              else if (item.command) io.emit({ kind: "progress", message: `$ ${item.command.slice(0, 200)}`, tool: "shell" });
              else if (item.ok && item.path && /write|edit|patch/.test(item.tool)) {
                io.emit({ kind: "progress", message: `edited ${item.path.slice(0, 200)}`, tool: "edit" });
              }
              break;
            }
            case "usage":
              usage.tokensIn += item.tokensIn;
              usage.tokensOut += item.tokensOut;
              usage.cached += item.cached;
              usage.cost += item.cost;
              usage.steps += 1;
              break;
            case "failed":
              failure = item.message;
              break;
          }
        },
      });
      if (exit.stderr.trim()) io.emit({ kind: "log", line: `[stderr] ${exit.stderr.trim()}` });

      const records: UsageRecord[] = usage.steps
        ? [{ model: ctx.model || "opencode", tokens_in: usage.tokensIn, tokens_out: usage.tokensOut, cached_tokens: usage.cached, cost: usage.cost }]
        : [];
      const final = session || failure ? { ok: !failure, summary: lastText, usage: records, ...(failure ? { error: failure } : {}) } : undefined;
      return cliOutcome("opencode", exit, final, lastText);
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  }
}

export const RESUME_PROMPT =
  "You were interrupted. Continue the same task from where you stopped, then finish with a short summary.";
