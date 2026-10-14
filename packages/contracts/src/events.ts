import { z } from "zod";
import { RunStatus, TaskStatus } from "./status.ts";

/** Who caused an event (spec §9.2 `actor`). */
export const Actor = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("user"), via: z.enum(["cli", "web", "mobile", "api"]) }),
  z.object({ kind: z.literal("system"), component: z.string() }),
  z.object({
    kind: z.literal("agent"),
    profile: z.string(),
    adapter: z.string(),
    model: z.string().optional(),
  }),
]);
export type Actor = z.infer<typeof Actor>;

export const ErrorKind = z.enum([
  "transient",
  "rate_limited",
  "fatal",
  "policy_denied",
  "budget_exceeded",
  "cancelled",
  "interrupted",
]);
export type ErrorKind = z.infer<typeof ErrorKind>;

export const TaskError = z.object({ kind: ErrorKind, message: z.string() });
export type TaskError = z.infer<typeof TaskError>;

export const UsageRecord = z.object({
  model: z.string(),
  tokens_in: z.number().int().nonnegative(),
  tokens_out: z.number().int().nonnegative(),
  cached_tokens: z.number().int().nonnegative(),
  cost: z.number().nonnegative(),
  latency_ms: z.number().int().nonnegative().optional(),
});
export type UsageRecord = z.infer<typeof UsageRecord>;

export const ArtifactKind = z.enum(["plan", "diff", "report", "spec", "log"]);
export type ArtifactKind = z.infer<typeof ArtifactKind>;

/** Payload schema for each event type. New types are added here first (contracts first). */
export const EventPayloads = {
  "run.created": z.object({
    repo_path: z.string(),
    base_commit: z.string(),
    prompt: z.string(),
    budget: z.number().nonnegative(),
    adapter: z.string(),
    profile: z.string(),
    allow_commands: z.array(z.string()),
    model: z.string().optional(),
  }),
  "run.status_changed": z.object({ from: RunStatus, to: RunStatus, reason: z.string().optional() }),
  "task.created": z.object({
    node_id: z.string(),
    type: z.string(),
    profile: z.string(),
    adapter: z.string(),
    max_attempts: z.number().int().positive(),
  }),
  "task.status_changed": z.object({
    from: TaskStatus,
    to: TaskStatus,
    attempt: z.number().int().nonnegative(),
    reason: z.string().optional(),
    error: TaskError.optional(),
  }),
  "task.progress": z.object({
    message: z.string(),
    tool: z.string().optional(),
  }),
  "task.resume_token": z.object({ adapter: z.string(), token: z.string() }),
  "task.completed": z.object({
    status: z.enum(["succeeded", "failed", "needs_input"]),
    summary: z.string(),
    artifacts: z.array(z.string()),
    cost: z.number().nonnegative(),
    duration_ms: z.number().int().nonnegative(),
    error: TaskError.optional(),
  }),
  "sandbox.created": z.object({
    sandbox_id: z.string(),
    kind: z.enum(["worktree", "container"]),
    path: z.string(),
    branch: z.string(),
    base_commit: z.string(),
    reused: z.boolean(),
  }),
  "artifact.created": z.object({
    artifact_id: z.string(),
    kind: ArtifactKind,
    uri: z.string(),
    sha256: z.string(),
    summary: z.string(),
  }),
  "model.call.completed": UsageRecord,
  "run.message": z.object({ text: z.string() }),
  "policy.denied": z.object({
    action: z.string(),
    resource: z.string(),
    reason: z.string(),
  }),
} as const;

export type EventType = keyof typeof EventPayloads;
export const EventType = z.enum(Object.keys(EventPayloads) as [EventType, ...EventType[]]);
export type EventPayload<T extends EventType> = z.infer<(typeof EventPayloads)[T]>;

/** Common event envelope, spec §9.2. */
export const EventEnvelope = z.object({
  id: z.string(),
  seq: z.number().int().positive(),
  ts: z.string(),
  type: EventType,
  run_id: z.string().nullable(),
  task_id: z.string().nullable(),
  actor: Actor,
  payload: z.record(z.string(), z.unknown()),
  schema_version: z.literal(1),
});

export type VectrEvent<T extends EventType = EventType> = {
  id: string;
  seq: number;
  ts: string;
  type: T;
  run_id: string | null;
  task_id: string | null;
  actor: Actor;
  payload: EventPayload<T>;
  schema_version: 1;
};

/** An event before the store assigns `id`, `seq` and `ts`. */
export type NewEvent<T extends EventType = EventType> = {
  [K in T]: {
    type: K;
    run_id: string | null;
    task_id: string | null;
    actor: Actor;
    payload: EventPayload<K>;
  };
}[T];

export function parsePayload<T extends EventType>(type: T, payload: unknown): EventPayload<T> {
  return EventPayloads[type].parse(payload) as EventPayload<T>;
}
