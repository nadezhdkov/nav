import { z } from "zod";
import { TaskError, UsageRecord } from "./events.ts";

/** Agent adapter contract, spec §9.3. */

export const Confidence = z.enum(["confirmed", "inferred", "gap"]);
export type Confidence = z.infer<typeof Confidence>;

export const Claim = z.object({
  text: z.string(),
  confidence: Confidence,
  evidence: z
    .array(
      z.object({
        file: z.string().optional(),
        line: z.number().int().optional(),
        command: z.string().optional(),
        artifact: z.string().optional(),
      }),
    )
    .optional(),
});
export type Claim = z.infer<typeof Claim>;

export const TaskResult = z.object({
  status: z.enum(["succeeded", "failed", "needs_input"]),
  summary: z.string(),
  artifacts: z.array(z.string()),
  claims: z.array(Claim),
  usage: z.array(UsageRecord),
  error: TaskError.optional(),
});
export type TaskResult = z.infer<typeof TaskResult>;

export type AgentProfile = {
  id: string;
  role: string;
  instructions: string;
};

export type SandboxHandle = {
  id: string;
  kind: "worktree" | "container";
  path: string;
  branch: string;
  baseCommit: string;
};

/** Tool permissions granted by the Policy Engine, in the adapter's own rule syntax. */
export type ToolGrant = {
  allow: string[];
  deny: string[];
};

export type TaskContext = {
  taskId: string;
  runId: string;
  attempt: number;
  profile: AgentProfile;
  instructions: string;
  /** Model pinned for the run, if any. Phase 0 has no Model Router yet. */
  model?: string;
  sandbox: SandboxHandle;
  tools: ToolGrant;
  budget: { maxCost: number; maxTurns: number; timeoutMs: number };
  /** Opaque token from an earlier attempt, letting the adapter continue where it stopped. */
  resumeToken?: string;
};

export type AdapterEvent =
  | { kind: "progress"; message: string; tool?: string }
  | { kind: "log"; line: string }
  | { kind: "resume_token"; token: string }
  | { kind: "denied"; tool: string; input: string };

export type AdapterIO = {
  emit(event: AdapterEvent): void;
};

export type AdapterCapabilities = {
  streaming: boolean;
  ownTools: boolean;
  resumable: boolean;
};

export type HealthStatus = { ok: boolean; detail: string };

export interface AgentAdapter {
  readonly id: string;
  capabilities(): AdapterCapabilities;
  healthcheck(): Promise<HealthStatus>;
  run(ctx: TaskContext, io: AdapterIO): Promise<TaskResult>;
  cancel(taskId: string): Promise<void>;
}
