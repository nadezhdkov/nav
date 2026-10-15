import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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
  Billing,
  HealthStatus,
  TaskContext,
  TaskResult,
  ToolGrant,
} from "@navarch/contracts";
import type { GuardPolicy } from "./guard.ts";
import { parseGrokLine, type GrokResult } from "./stream.ts";

/**
 * Runs the Grok CLI headless (`grok --prompt-file … --output-format streaming-messages-json`) in
 * the worktree, signed in with the operator's grok.com account. Decision: ADR 0024.
 *
 * Each task gets its own home: `HOME` and `GROK_HOME` point into it, so the operator's
 * `~/.claude` skills, plugins and MCP servers (which Grok also loads) and Grok's own config,
 * memory and hooks never apply. Only the login is shared, by linking `~/.grok/auth.json`, which
 * Grok refreshes in place. The grant is enforced twice: Grok's deny-by-default permission rules
 * (`dontAsk` in the home's `.claude/settings.json`), and Navarch's guard as a `PreToolUse` hook.
 */

export type GrokOptions = {
  command?: string;
  commandArgs?: string[];
  scrubEnv?: string[];
  killGraceMs?: number;
  /** Where per-task homes are kept (default: a directory under the OS temp dir). */
  homeRoot?: string;
  /** The operator's Grok home holding `auth.json` (default: `$GROK_HOME`, else `~/.grok`). */
  userGrokHome?: string;
};

/** Grok tools a task never gets: media generation, feedback to xAI, questions nobody answers, background runners. */
const ALWAYS_REMOVED = ["image_gen", "image_edit", "image_to_video", "reference_to_video", "send_feedback", "ask_user_question", "monitor", "workflow"];
const EDIT_TOOLS = ["search_replace", "write"];
const WEB_TOOLS = ["web_search", "web_fetch"];

/** Variables that would loosen the task's setup: folder trust off, another agent definition. */
const GROK_ENV_REMOVED = ["GROK_FOLDER_TRUST", "GROK_AGENT"];

const GROK_CONFIG = `# Written by Navarch for one task (ADR 0024).
[cli]
auto_update = false

[session]
load_envrc = false

[features]
telemetry = false
feedback = false
`;

/** Translates the neutral grant into Grok permission rules (Claude Code settings syntax). */
export function grokPermissions(grant: ToolGrant, home = homedir()): { defaultMode: "dontAsk"; allow: string[]; deny: string[] } {
  const allow = grant.editFiles ? ["Edit", "Write"] : [];
  for (const pattern of grant.allowCommands) {
    const p = parsePattern(pattern);
    allow.push(`Bash(${p.prefix})`);
    if (p.wildcard) allow.push(`Bash(${p.prefix} *)`);
  }
  const deny = grant.denyCommands.flatMap((prefix) => [`Bash(${prefix})`, `Bash(${prefix} *)`]);
  for (const path of grant.denyPaths) {
    // HOME points at the task's home, so `~` must be spelled out as the operator's home.
    const real = path.replace(/^~(?=\/|$)/, home);
    for (const tool of ["Read", "Edit", "Write", "Grep"]) deny.push(`${tool}(${real}/**)`);
  }
  if (!grant.network) deny.push("WebFetch");
  if (!grant.editFiles) deny.push("Edit", "Write");
  return { defaultMode: "dontAsk", allow, deny };
}

export class GrokAdapter implements AgentAdapter {
  readonly id = "grok";
  private readonly options: Required<GrokOptions>;
  private readonly processes: CliProcesses;

  constructor(options: GrokOptions = {}) {
    this.options = {
      command: options.command ?? "grok",
      commandArgs: options.commandArgs ?? [],
      scrubEnv: options.scrubEnv ?? DEFAULT_SCRUB_ENV,
      killGraceMs: options.killGraceMs ?? 5_000,
      homeRoot: options.homeRoot ?? join(tmpdir(), "navarch-grok"),
      userGrokHome: options.userGrokHome ?? process.env.GROK_HOME ?? join(homedir(), ".grok"),
    };
    this.processes = new CliProcesses(this.options.killGraceMs);
  }

  capabilities(): AdapterCapabilities {
    return { streaming: true, ownTools: true, resumable: true, enforcement: "exact", billing: "plan" };
  }

  healthcheck(): Promise<HealthStatus> {
    return healthcheck(this.options.command, [...this.options.commandArgs, "--version"]);
  }

  unavailableReason(): string | undefined {
    if (process.env.XAI_API_KEY || existsSync(join(this.options.userGrokHome, "auth.json"))) return undefined;
    return `grok is not signed in: run \`grok login\` (no auth.json in ${this.options.userGrokHome})`;
  }

  async run(ctx: TaskContext, io: AdapterIO): Promise<TaskResult> {
    const home = this.prepareHome(ctx);
    let result: TaskResult | undefined;
    if (ctx.resumeToken) {
      result = await this.attempt(ctx, io, home, { resume: ctx.resumeToken });
      if (isMissingSession(result)) {
        io.emit({ kind: "progress", message: "previous session not found, starting a new one" });
        result = undefined;
      }
    }
    if (!result) {
      const sessionId = randomUUID();
      io.emit({ kind: "resume_token", token: sessionId });
      result = await this.attempt(ctx, io, home, { sessionId });
    }
    // Grok keeps sessions in its home: keep it after a failure so a retry can resume.
    if (result.status === "succeeded" || result.error?.kind === "cancelled") rmSync(home, { recursive: true, force: true });
    return result;
  }

  cancel(taskId: string): Promise<void> {
    return this.processes.cancel(taskId);
  }

  stopAll(): Promise<void> {
    return this.processes.stopAll();
  }

  taskHome(ctx: TaskContext): string {
    const safe = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, "_");
    return join(this.options.homeRoot, `${safe(ctx.runId)}-${safe(ctx.taskId)}`);
  }

  /** Writes the task's home: Grok config, the login link, permission rules and the guard hook. */
  private prepareHome(ctx: TaskContext): string {
    const home = this.taskHome(ctx);
    const grokHome = join(home, ".grok");
    for (const dir of [join(grokHome, "hooks"), join(home, ".claude")]) mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(grokHome, "config.toml"), GROK_CONFIG, { mode: 0o600 });
    // The lock is shared too, so two tasks refreshing the login at once take turns.
    for (const file of ["auth.json", "auth.json.lock"]) {
      const source = join(this.options.userGrokHome, file);
      const link = join(grokHome, file);
      if (existsSync(source) && !existsSync(link)) symlinkSync(source, link);
    }
    const permissions = grokPermissions(ctx.tools);
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ permissions }, null, 2), { mode: 0o600 });

    const policyFile = join(home, "navarch-guard.json");
    const policy: GuardPolicy = { grant: ctx.tools, root: ctx.sandbox.path, home: homedir() };
    writeFileSync(policyFile, JSON.stringify(policy), { mode: 0o600 });
    const hook = [process.execPath, fileURLToPath(new URL("./guard-hook.ts", import.meta.url)), policyFile].map(shellQuote).join(" ");
    const hooks = { hooks: { PreToolUse: [{ hooks: [{ type: "command", command: hook, timeout: 30 }] }] } };
    writeFileSync(join(grokHome, "hooks", "navarch-guard.json"), JSON.stringify(hooks, null, 2), { mode: 0o600 });
    return home;
  }

  buildArgs(ctx: TaskContext, promptFile: string, session: { resume?: string; sessionId?: string }): string[] {
    const removed = [...ALWAYS_REMOVED, ...(ctx.tools.editFiles ? [] : EDIT_TOOLS), ...(ctx.tools.network ? [] : WEB_TOOLS)];
    return [
      ...this.options.commandArgs,
      "--prompt-file",
      promptFile,
      "--output-format",
      "streaming-messages-json",
      ...(session.resume ? ["--resume", session.resume] : ["--session-id", session.sessionId ?? randomUUID()]),
      ...(ctx.model ? ["--model", ctx.model] : []),
      ...(ctx.budget.maxTurns > 0 ? ["--max-turns", String(ctx.budget.maxTurns)] : []),
      "--no-subagents",
      "--disallowed-tools",
      removed.join(","),
      ...(ctx.tools.network ? [] : ["--disable-web-search"]),
    ];
  }

  buildEnv(home: string): NodeJS.ProcessEnv {
    const env = scrubbedEnv(this.options.scrubEnv, {
      HOME: home,
      GROK_HOME: join(home, ".grok"),
      GROK_MEMORY: "0",
      GROK_SUBAGENTS: "0",
      GROK_FEEDBACK_ENABLED: "0",
      GROK_TELEMETRY_ENABLED: "0",
    });
    for (const name of GROK_ENV_REMOVED) delete env[name];
    return env;
  }

  private async attempt(ctx: TaskContext, io: AdapterIO, home: string, session: { resume?: string; sessionId?: string }): Promise<TaskResult> {
    const promptFile = join(home, "prompt.md");
    writeFileSync(promptFile, session.resume ? (ctx.resumePrompt ?? RESUME_PROMPT) : ctx.instructions, { mode: 0o600 });

    let result: GrokResult | undefined;
    let lastText = "";
    /** Billed per call only with an xAI API key rather than a grok.com sign-in (ADR 0023). */
    let billing: Billing = "plan";
    const tools = new Map<string, { name: string; summary: string }>();
    const exit = await this.processes.run({
      taskId: ctx.taskId,
      command: this.options.command,
      args: this.buildArgs(ctx, promptFile, session),
      cwd: ctx.sandbox.path,
      env: this.buildEnv(home),
      timeoutMs: ctx.budget.timeoutMs,
      onLine: (line) => {
        io.emit({ kind: "log", line });
        for (const item of parseGrokLine(line)) {
          switch (item.kind) {
            case "init":
              billing = !item.apiKeySource || /^(oauth|none|session)/i.test(item.apiKeySource) ? "plan" : "metered";
              break;
            case "text":
              lastText = item.text;
              io.emit({ kind: "progress", message: item.text.slice(0, 500) });
              break;
            case "tool":
              tools.set(item.id, { name: item.name, summary: item.summary });
              io.emit({ kind: "progress", message: item.summary, tool: item.name });
              break;
            case "tool_result": {
              const tool = tools.get(item.toolUseId);
              if (item.denied) io.emit({ kind: "denied", tool: tool?.name ?? "unknown", input: tool?.summary ?? item.message });
              break;
            }
            case "result":
              result = item.result;
              break;
          }
        }
      },
    });
    if (exit.stderr.trim()) io.emit({ kind: "log", line: `[stderr] ${exit.stderr.trim()}` });
    const final = result && {
      ok: result.ok,
      summary: result.text,
      usage: result.usage.map((u) => ({ ...u, billing })),
      ...(result.ok ? {} : { error: `${result.subtype}: ${result.errors.join("; ") || result.stopReason || result.text}` }),
    };
    return cliOutcome("grok", exit, final, lastText);
  }
}

export const RESUME_PROMPT =
  "You were interrupted. Continue the same task from where you stopped, then finish with a short summary.";

const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
