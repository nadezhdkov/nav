import { createHash } from "node:crypto";
import { createWriteStream, existsSync, type WriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  newId,
  redact,
  type Actor,
  type AgentAdapter,
  type AgentProfile,
  type NewEvent,
  type SandboxHandle,
  type TaskResult,
  type ToolGrant,
} from "@navarch/contracts";
import { DEFAULT_SCRUB_ENV, scrubbedEnv } from "@navarch/adapter-kit";
import { route, type RouteDecision, type RouteRequest, type RouterConfig } from "@navarch/model-router";
import { changedFiles, createWorktree, runShell, worktreeDiff } from "@navarch/runner";

/**
 * Agent Runtime (spec §6.3.1): prepares the sandbox and task context, runs the adapter and
 * turns its output into events, logs and artifacts. It never decides what is allowed: the
 * tool grant comes from the Policy Engine through the caller. It is the only caller of the
 * Model Router (architecture rule 4).
 */

export type RuntimeDeps = {
  home: string;
  adapters: Map<string, AgentAdapter>;
  publish: (event: NewEvent) => void;
  onLog?: (runId: string, taskId: string, line: string) => void;
  /** Model Router policy; without it, `route()` is never asked (every run is pinned). */
  router?: RouterConfig;
};

export type TaskSpec = {
  runId: string;
  taskId: string;
  nodeId: string;
  /** Names the run's worktree and branch (`navarch/<run>/<slug>`); every agent of a run shares it. Defaults to `nodeId`. */
  sandboxSlug?: string;
  attempt: number;
  repoPath: string;
  baseCommit: string;
  adapter: string;
  profile: AgentProfile;
  instructions: string;
  model?: string;
  tools: ToolGrant;
  /** Run by the Runner in the sandbox, once per sandbox, before the agent; not part of the agent's grant. */
  setupCommands?: string[];
  /** Also saves the agent's summary as an artifact of this kind (the planner's plan). */
  summaryArtifact?: "plan";
  budget: { maxCost: number; maxTurns: number; timeoutMs: number };
  resumeToken?: string;
  sandboxId?: string;
  /** Aborted when the task is cancelled or the daemon stops; ends setup and the agent at any stage. */
  signal?: AbortSignal;
};

export type TaskOutcome = TaskResult & { durationMs: number; cost: number };

export class AgentRuntime {
  private readonly deps: RuntimeDeps;

  constructor(deps: RuntimeDeps) {
    this.deps = deps;
  }

  /** Asks the Model Router where an agent task should run, among the adapters this runtime has. */
  route(req: Omit<RouteRequest, "adapters">): RouteDecision | undefined {
    if (!this.deps.router) return undefined;
    return route(this.deps.router, { ...req, adapters: new Set(this.deps.adapters.keys()) });
  }

  async execute(spec: TaskSpec): Promise<TaskOutcome> {
    const adapter = this.deps.adapters.get(spec.adapter);
    if (!adapter) throw new Error(`unknown adapter: ${spec.adapter}`);
    const actor: Actor = { kind: "agent", profile: spec.profile.id, adapter: adapter.id, model: spec.model };
    const started = Date.now();

    const failed = (kind: "fatal" | "cancelled", message: string): TaskOutcome => ({
      status: "failed",
      summary: "",
      artifacts: [],
      claims: [],
      usage: [],
      error: { kind, message },
      cost: 0,
      durationMs: Date.now() - started,
    });
    const sandbox = await this.prepareSandbox(spec);
    const log = await this.openLog(spec);
    // Cancel or stop can arrive before the agent process exists; the adapter can only kill what it started.
    const stopAgent = () => void adapter.cancel(spec.taskId);
    try {
      if (spec.signal?.aborted) return failed("cancelled", "cancelled before setup");
      const setupError = await this.runSetup(spec, sandbox, log);
      if (spec.signal?.aborted) return failed("cancelled", "cancelled during setup");
      if (setupError) return failed("fatal", setupError);
      // Adapters start their process synchronously in run(), so the listener below can always reach it.
      const running = adapter.run(
        {
          taskId: spec.taskId,
          runId: spec.runId,
          attempt: spec.attempt,
          profile: spec.profile,
          instructions: spec.instructions,
          model: spec.model,
          sandbox,
          tools: spec.tools,
          budget: spec.budget,
          resumeToken: spec.resumeToken,
        },
        {
          emit: (event) => {
            if (event.kind === "log") {
              const line = redact(event.line);
              log.write(line + "\n");
              this.deps.onLog?.(spec.runId, spec.taskId, line);
            } else if (event.kind === "progress") {
              this.publish(spec, actor, "task.progress", {
                message: redact(event.message),
                ...(event.tool ? { tool: event.tool } : {}),
              });
            } else if (event.kind === "denied") {
              this.publish(spec, actor, "policy.denied", {
                action: `tool.${event.tool}`,
                resource: redact(event.input),
                reason: "not in the tool grant",
              });
            } else if (event.kind === "quota") {
              this.publish(spec, actor, "quota.observed", {
                adapter: adapter.id,
                window: event.window,
                ...(event.utilization !== undefined ? { utilization: event.utilization } : {}),
                ...(event.resetsAt ? { resets_at: event.resetsAt } : {}),
                ...(event.exhausted !== undefined ? { exhausted: event.exhausted } : {}),
              });
            } else {
              this.publish(spec, actor, "task.resume_token", { adapter: adapter.id, token: event.token });
            }
          },
        },
      );
      spec.signal?.addEventListener("abort", stopAgent, { once: true });
      const result = await running;

      for (const usage of result.usage) this.publish(spec, actor, "model.call.completed", usage);
      const artifacts = [...result.artifacts];
      if (spec.summaryArtifact && result.status === "succeeded" && result.summary.trim()) {
        artifacts.push(await this.saveArtifact(spec, spec.summaryArtifact, "md", redact(result.summary), result.summary.split("\n")[0]!.slice(0, 120)));
      }
      if (result.error?.kind !== "cancelled") {
        const diffId = await this.saveDiff(spec, sandbox);
        if (diffId) artifacts.push(diffId);
      }
      const cost = result.usage.reduce((sum, u) => sum + u.cost, 0);
      const summary = redact(result.summary);
      return { ...result, summary, outputs: { ...result.outputs, summary }, artifacts, cost, durationMs: Date.now() - started };
    } finally {
      spec.signal?.removeEventListener("abort", stopAgent);
      await new Promise<void>((resolve) => log.end(resolve));
    }
  }

  private async prepareSandbox(spec: TaskSpec): Promise<SandboxHandle> {
    const sandboxId = spec.sandboxId ?? newId("sbx");
    const handle = await createWorktree({
      sandboxId,
      repoPath: spec.repoPath,
      runId: spec.runId,
      taskSlug: spec.sandboxSlug ?? spec.nodeId,
      baseCommit: spec.baseCommit,
      home: this.deps.home,
    });
    this.publish(spec, { kind: "system", component: "runner" }, "sandbox.created", {
      sandbox_id: handle.id,
      kind: handle.kind,
      path: handle.path,
      branch: handle.branch,
      base_commit: handle.baseCommit,
      reused: handle.reused,
    });
    return handle;
  }

  /**
   * Runs the run's setup commands once per sandbox (a marker survives retries and restarts).
   * They are the operator's own commands, so they run through the shell with network, outside
   * the agent's grant; their output goes to the task log. Returns an error message on failure.
   */
  private async runSetup(spec: TaskSpec, sandbox: SandboxHandle, log: WriteStream): Promise<string | undefined> {
    const commands = spec.setupCommands ?? [];
    // One marker per sandbox: later tasks of the run (fix iterations) reuse the prepared worktree.
    const marker = join(this.deps.home, "logs", spec.runId, `${spec.sandboxSlug ?? spec.taskId}.setup-done`);
    if (!commands.length || existsSync(marker)) return undefined;
    const runner: Actor = { kind: "system", component: "runner" };
    for (const command of commands) {
      log.write(`--- setup: ${command}\n`);
      const started = Date.now();
      const { code, tail } = await runShell(command, {
        cwd: sandbox.path,
        env: scrubbedEnv(DEFAULT_SCRUB_ENV),
        timeoutMs: spec.budget.timeoutMs,
        onOutput: (chunk) => log.write(redact(chunk)),
        ...(spec.signal ? { signal: spec.signal } : {}),
      });
      if (spec.signal?.aborted) return undefined;
      this.publish(spec, runner, "sandbox.setup", { command, exit_code: code, duration_ms: Date.now() - started });
      if (code !== 0) {
        const how = code === null ? "timed out" : `exited with ${code}`;
        return redact(`setup command failed: \`${command}\` ${how}${tail ? `: ${tail}` : ""}`);
      }
    }
    await writeFile(marker, new Date().toISOString());
    return undefined;
  }

  private async openLog(spec: TaskSpec): Promise<WriteStream> {
    const dir = join(this.deps.home, "logs", spec.runId);
    await mkdir(dir, { recursive: true });
    const stream = createWriteStream(join(dir, `${spec.taskId}.log`), { flags: "a" });
    stream.write(`--- attempt ${spec.attempt} ${new Date().toISOString()} ---\n`);
    return stream;
  }

  private async saveArtifact(spec: TaskSpec, kind: "plan", ext: string, content: string, summary: string): Promise<string> {
    const id = newId("art");
    const dir = join(this.deps.home, "artifacts", spec.runId);
    await mkdir(dir, { recursive: true });
    const uri = join(dir, `${id}.${ext}`);
    await writeFile(uri, content);
    this.publish(spec, { kind: "system", component: "runner" }, "artifact.created", {
      artifact_id: id,
      kind,
      uri,
      sha256: createHash("sha256").update(content).digest("hex"),
      summary,
    });
    return id;
  }

  private async saveDiff(spec: TaskSpec, sandbox: SandboxHandle): Promise<string | undefined> {
    const diff = await worktreeDiff(sandbox);
    if (!diff.trim()) return undefined;
    const files = await changedFiles(sandbox);
    const id = newId("art");
    const dir = join(this.deps.home, "artifacts", spec.runId);
    await mkdir(dir, { recursive: true });
    const uri = join(dir, `${id}.diff`);
    await writeFile(uri, diff);
    this.publish(spec, { kind: "system", component: "runner" }, "artifact.created", {
      artifact_id: id,
      kind: "diff",
      uri,
      sha256: createHash("sha256").update(diff).digest("hex"),
      summary: `${files.length} file(s) changed: ${files.slice(0, 10).join(", ")}${files.length > 10 ? ", …" : ""}`,
    });
    return id;
  }

  private publish<T extends NewEvent["type"]>(
    spec: TaskSpec,
    actor: Actor,
    type: T,
    payload: Extract<NewEvent, { type: T }>["payload"],
  ): void {
    this.deps.publish({ type, run_id: spec.runId, task_id: spec.taskId, actor, payload } as NewEvent);
  }
}
