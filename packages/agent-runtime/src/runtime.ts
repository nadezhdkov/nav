import { createHash } from "node:crypto";
import { createWriteStream, type WriteStream } from "node:fs";
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
} from "@vectr/contracts";
import { changedFiles, createWorktree, worktreeDiff } from "@vectr/runner";

/**
 * Agent Runtime (spec §6.3.1): prepares the sandbox and task context, runs the adapter and
 * turns its output into events, logs and artifacts. It never decides what is allowed: the
 * tool grant comes from the Policy Engine through the caller.
 */

export type RuntimeDeps = {
  home: string;
  adapters: Map<string, AgentAdapter>;
  publish: (event: NewEvent) => void;
  onLog?: (runId: string, taskId: string, line: string) => void;
};

export type TaskSpec = {
  runId: string;
  taskId: string;
  nodeId: string;
  attempt: number;
  repoPath: string;
  baseCommit: string;
  adapter: string;
  profile: AgentProfile;
  instructions: string;
  model?: string;
  tools: ToolGrant;
  budget: { maxCost: number; maxTurns: number; timeoutMs: number };
  resumeToken?: string;
  sandboxId?: string;
};

export type TaskOutcome = TaskResult & { durationMs: number; cost: number };

export class AgentRuntime {
  private readonly deps: RuntimeDeps;

  constructor(deps: RuntimeDeps) {
    this.deps = deps;
  }

  async execute(spec: TaskSpec): Promise<TaskOutcome> {
    const adapter = this.deps.adapters.get(spec.adapter);
    if (!adapter) throw new Error(`unknown adapter: ${spec.adapter}`);
    const actor: Actor = { kind: "agent", profile: spec.profile.id, adapter: adapter.id, model: spec.model };
    const started = Date.now();

    const sandbox = await this.prepareSandbox(spec);
    const log = await this.openLog(spec);
    try {
      const result = await adapter.run(
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
            } else {
              this.publish(spec, actor, "task.resume_token", { adapter: adapter.id, token: event.token });
            }
          },
        },
      );

      for (const usage of result.usage) this.publish(spec, actor, "model.call.completed", usage);
      const artifacts = [...result.artifacts];
      if (result.error?.kind !== "cancelled") {
        const diffId = await this.saveDiff(spec, sandbox);
        if (diffId) artifacts.push(diffId);
      }
      const cost = result.usage.reduce((sum, u) => sum + u.cost, 0);
      return { ...result, summary: redact(result.summary), artifacts, cost, durationMs: Date.now() - started };
    } finally {
      await new Promise<void>((resolve) => log.end(resolve));
    }
  }

  private async prepareSandbox(spec: TaskSpec): Promise<SandboxHandle> {
    const sandboxId = spec.sandboxId ?? newId("sbx");
    const handle = await createWorktree({
      sandboxId,
      repoPath: spec.repoPath,
      runId: spec.runId,
      taskSlug: spec.nodeId,
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

  private async openLog(spec: TaskSpec): Promise<WriteStream> {
    const dir = join(this.deps.home, "logs", spec.runId);
    await mkdir(dir, { recursive: true });
    const stream = createWriteStream(join(dir, `${spec.taskId}.log`), { flags: "a" });
    stream.write(`--- attempt ${spec.attempt} ${new Date().toISOString()} ---\n`);
    return stream;
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
