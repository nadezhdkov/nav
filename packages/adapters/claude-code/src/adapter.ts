import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import type {
  AdapterCapabilities,
  AdapterIO,
  AgentAdapter,
  ErrorKind,
  HealthStatus,
  TaskContext,
  TaskResult,
} from "@vectr/contracts";
import { parseLine, type ClaudeResult } from "./stream.ts";

/**
 * Runs Claude Code as a headless subprocess (`claude -p --output-format stream-json`)
 * inside the task's sandbox. Decision: ADR 0003.
 */

export type ClaudeCodeOptions = {
  /** Executable, `claude` by default. */
  command?: string;
  /** Arguments placed before VECTR's own (used by tests to run a fake CLI through node). */
  commandArgs?: string[];
  /** Claude Code permission mode. `acceptEdits` lets it edit files; other tools follow the grant. */
  permissionMode?: string;
  /** Environment variables removed before spawning, so the agent never sees them. */
  scrubEnv?: string[];
  /** Grace period between SIGTERM and SIGKILL on cancel. */
  killGraceMs?: number;
};

const DEFAULT_SCRUB = ["GITHUB_TOKEN", "GH_TOKEN", "GITHUB_PAT", "VECTR_GITHUB_TOKEN"];

type Running = { child: ChildProcess; cancelled: boolean };

export class ClaudeCodeAdapter implements AgentAdapter {
  readonly id = "claude-code";
  private readonly options: Required<ClaudeCodeOptions>;
  private readonly running = new Map<string, Running>();

  constructor(options: ClaudeCodeOptions = {}) {
    this.options = {
      command: options.command ?? "claude",
      commandArgs: options.commandArgs ?? [],
      permissionMode: options.permissionMode ?? "acceptEdits",
      scrubEnv: options.scrubEnv ?? DEFAULT_SCRUB,
      killGraceMs: options.killGraceMs ?? 5_000,
    };
  }

  capabilities(): AdapterCapabilities {
    return { streaming: true, ownTools: true, resumable: true };
  }

  async healthcheck(): Promise<HealthStatus> {
    return new Promise((resolve) => {
      const child = spawn(this.options.command, [...this.options.commandArgs, "--version"], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      child.stdout?.on("data", (d) => (out += d));
      child.on("error", (err) => resolve({ ok: false, detail: err.message }));
      child.on("close", (code) => resolve({ ok: code === 0, detail: out.trim() || `exit ${code}` }));
    });
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

  async cancel(taskId: string): Promise<void> {
    const entry = this.running.get(taskId);
    if (!entry) return;
    entry.cancelled = true;
    await this.kill(entry.child);
  }

  /** Stops every running subprocess without marking it cancelled (daemon shutdown). */
  async stopAll(): Promise<void> {
    await Promise.all([...this.running.values()].map((entry) => this.kill(entry.child)));
  }

  private buildArgs(ctx: TaskContext, session: { resume?: string; sessionId?: string }): string[] {
    const args = [...this.options.commandArgs, "-p", "--output-format", "stream-json", "--verbose"];
    if (session.resume) args.push("--resume", session.resume);
    else if (session.sessionId) args.push("--session-id", session.sessionId);
    args.push("--permission-mode", this.options.permissionMode);
    if (ctx.model) args.push("--model", ctx.model);
    if (ctx.budget.maxCost > 0) args.push("--max-budget-usd", ctx.budget.maxCost.toFixed(2));
    if (ctx.tools.allow.length) args.push("--allowedTools", ...ctx.tools.allow);
    if (ctx.tools.deny.length) args.push("--disallowedTools", ...ctx.tools.deny);
    return args;
  }

  private attempt(
    ctx: TaskContext,
    io: AdapterIO,
    session: { resume?: string; sessionId?: string },
  ): Promise<TaskResult> {
    const prompt = session.resume
      ? "You were interrupted. Continue the same task from where you stopped, then finish with a short summary."
      : ctx.instructions;
    const env = { ...process.env };
    for (const name of this.options.scrubEnv) delete env[name];

    const started = Date.now();
    const child = spawn(this.options.command, this.buildArgs(ctx, session), {
      cwd: ctx.sandbox.path,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const entry: Running = { child, cancelled: false };
    this.running.set(ctx.taskId, entry);

    let result: ClaudeResult | undefined;
    let stderr = "";
    let lastText = "";
    let spawnError: Error | undefined;

    child.stdin?.end(prompt);
    child.stderr?.on("data", (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-8_000);
    });
    const lines = createInterface({ input: child.stdout! });
    lines.on("line", (line) => {
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
        }
      }
    });

    const timer =
      ctx.budget.timeoutMs > 0
        ? setTimeout(() => {
            stderr += `\nvectr: timeout after ${ctx.budget.timeoutMs} ms`;
            void this.kill(child);
          }, ctx.budget.timeoutMs)
        : undefined;

    return new Promise((resolve) => {
      child.on("error", (err) => (spawnError = err));
      child.on("close", (code, signal) => {
        if (timer) clearTimeout(timer);
        this.running.delete(ctx.taskId);
        lines.close();
        if (stderr.trim()) io.emit({ kind: "log", line: `[stderr] ${stderr.trim()}` });
        resolve(
          toTaskResult({
            result,
            code,
            signal,
            stderr,
            lastText,
            cancelled: entry.cancelled,
            spawnError,
            elapsedMs: Date.now() - started,
          }),
        );
      });
    });
  }

  private kill(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
    return new Promise((resolve) => {
      const force = setTimeout(() => child.kill("SIGKILL"), this.options.killGraceMs);
      child.once("close", () => {
        clearTimeout(force);
        resolve();
      });
      child.kill("SIGTERM");
    });
  }
}

type Outcome = {
  result?: ClaudeResult;
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  lastText: string;
  cancelled: boolean;
  spawnError?: Error;
  elapsedMs: number;
};

function toTaskResult(o: Outcome): TaskResult {
  const usage = o.result?.usage ?? [];
  if (o.cancelled) {
    return failed("cancelled", "cancelled by user", o.lastText, usage);
  }
  if (o.spawnError) {
    return failed("fatal", `could not start Claude Code: ${o.spawnError.message}`, "", usage);
  }
  if (o.result?.ok) {
    return {
      status: "succeeded",
      summary: o.result.text || o.lastText,
      artifacts: [],
      claims: [],
      usage,
    };
  }
  const detail = o.result ? `${o.result.subtype}: ${o.result.text}` : o.stderr.trim();
  const message = detail || `claude exited with ${o.signal ?? `code ${o.code}`}`;
  return failed(classify(o.result?.subtype ?? "", message), message, o.result?.text || o.lastText, usage);
}

function failed(kind: ErrorKind, message: string, summary: string, usage: TaskResult["usage"]): TaskResult {
  return { status: "failed", summary, artifacts: [], claims: [], usage, error: { kind, message } };
}

function classify(subtype: string, message: string): ErrorKind {
  const text = `${subtype} ${message}`.toLowerCase();
  if (text.includes("budget")) return "budget_exceeded";
  if (text.includes("rate limit") || text.includes("rate_limit") || text.includes("429") || text.includes("overloaded")) {
    return "rate_limited";
  }
  if (text.includes("timeout") || text.includes("econnreset") || text.includes("network")) return "transient";
  return "fatal";
}

function isMissingSession(result: TaskResult): boolean {
  const message = result.error?.message.toLowerCase() ?? "";
  return result.status === "failed" && /no conversation found|session.*not found/.test(message);
}
