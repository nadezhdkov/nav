import { z } from "zod";
import { EventType } from "./events.ts";
import { RunStatus, TaskStatus } from "./status.ts";

/** Core API contracts, spec §9.1. */

/** Agent adapters VECTR can run (spec §6.3.2). */
export const AdapterId = z.enum(["claude-code", "gemini-cli", "antigravity", "codex", "native"]);
export type AdapterId = z.infer<typeof AdapterId>;

export const CreateRunRequest = z.object({
  repo_path: z.string().min(1),
  prompt: z.string().min(1),
  /** Defaults to the daemon's `default_adapter`. */
  adapter: AdapterId.optional(),
  budget: z.number().positive().optional(),
  allow_commands: z.array(z.string()).optional(),
  model: z.string().optional(),
});
export type CreateRunRequest = z.infer<typeof CreateRunRequest>;

export const TaskView = z.object({
  id: z.string(),
  run_id: z.string(),
  node_id: z.string(),
  type: z.string(),
  status: TaskStatus,
  attempt: z.number().int(),
  max_attempts: z.number().int(),
  profile: z.string(),
  adapter: z.string(),
  sandbox_path: z.string().nullable(),
  branch: z.string().nullable(),
  cost: z.number(),
  summary: z.string().nullable(),
  error: z.string().nullable(),
  updated_at: z.string(),
});
export type TaskView = z.infer<typeof TaskView>;

export const RunView = z.object({
  id: z.string(),
  status: RunStatus,
  repo_path: z.string(),
  base_commit: z.string(),
  prompt: z.string(),
  budget: z.number(),
  cost_total: z.number(),
  created_at: z.string(),
  updated_at: z.string(),
  ended_at: z.string().nullable(),
});
export type RunView = z.infer<typeof RunView>;

export const RunDetail = RunView.extend({
  tasks: z.array(TaskView),
  artifacts: z.array(
    z.object({ id: z.string(), task_id: z.string(), kind: z.string(), uri: z.string(), summary: z.string() }),
  ),
});
export type RunDetail = z.infer<typeof RunDetail>;

export const ApiError = z.object({ error: z.string(), message: z.string() });
export type ApiError = z.infer<typeof ApiError>;

/** WebSocket `/api/v1/stream` messages. Topics: `run:<id>`, `runs`, `*`. */
export const StreamClientMessage = z.object({
  subscribe: z.array(z.string()).optional(),
  unsubscribe: z.array(z.string()).optional(),
});
export type StreamClientMessage = z.infer<typeof StreamClientMessage>;

export const StreamServerMessage = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("event"), event: z.object({ type: EventType }).passthrough() }),
  z.object({ kind: z.literal("log"), run_id: z.string(), task_id: z.string(), line: z.string() }),
  z.object({ kind: z.literal("subscribed"), topics: z.array(z.string()) }),
  z.object({ kind: z.literal("error"), message: z.string() }),
]);
export type StreamServerMessage = z.infer<typeof StreamServerMessage>;
