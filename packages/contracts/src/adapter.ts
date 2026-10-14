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

/**
 * What the Policy Engine allows a task to do, in neutral terms. Each adapter translates it to its
 * agent's own mechanism (permission rules, policy files, OS sandbox) and states how strictly it
 * can enforce it in `AdapterCapabilities.enforcement`.
 */
export type ToolGrant = {
  /** Read and edit files inside the sandbox. */
  editFiles: boolean;
  /** Shell commands the agent may run: exact commands, or prefixes ending in ` *`. */
  allowCommands: string[];
  /** Command prefixes that are always denied, even if an allow pattern matches. */
  denyCommands: string[];
  /** Paths outside the sandbox that must stay unreadable (`~` = home directory). */
  denyPaths: string[];
  /** Outbound network access (web fetch/search, package downloads). */
  network: boolean;
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
  | { kind: "denied"; tool: string; input: string }
  | { kind: "quota"; window: string; utilization?: number; resetsAt?: string; exhausted?: boolean };

export type AdapterIO = {
  emit(event: AdapterEvent): void;
};

export type AdapterCapabilities = {
  streaming: boolean;
  ownTools: boolean;
  resumable: boolean;
  /**
   * How the grant's command allowlist is enforced:
   * - `exact`: every command is checked against the allowlist (rules or VECTR's own tools).
   * - `sandbox`: commands are not filtered one by one; an OS sandbox confines writes to the
   *   worktree and blocks network instead.
   */
  enforcement: "exact" | "sandbox";
};

export type HealthStatus = { ok: boolean; detail: string };

export interface AgentAdapter {
  readonly id: string;
  capabilities(): AdapterCapabilities;
  healthcheck(): Promise<HealthStatus>;
  run(ctx: TaskContext, io: AdapterIO): Promise<TaskResult>;
  cancel(taskId: string): Promise<void>;
  /** Stops every running task without marking it cancelled (daemon shutdown). */
  stopAll(): Promise<void>;
}
