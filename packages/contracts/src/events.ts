import { z } from "zod";
import { FlowDefinition } from "./flow.ts";
import { RunStatus, TaskStatus } from "./status.ts";
import { VerificationReport, VerifyCommand, WorkItem, WorkItemRef } from "./work.ts";

/** Who caused an event (spec §9.2 `actor`). */
export const Actor = z.discriminatedUnion("kind", [
  /** `device_id` names the paired device a mobile action came from (ADR 0020). */
  z.object({ kind: z.literal("user"), via: z.enum(["cli", "web", "mobile", "api"]), device_id: z.string().optional() }),
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

/**
 * Reason of `running → interrupted → ready` when the user interrupts an agent to give it an
 * instruction (ADR 0019). Such an attempt does not count toward `max_attempts`.
 */
export const INSTRUCTION_INTERRUPT = "instruction";

/** Reason of `running → interrupted → ready` when the user pauses a run (ADR 0020); not an attempt either. */
export const PAUSE_INTERRUPT = "pause";

export const TaskError = z.object({
  kind: ErrorKind,
  message: z.string(),
  /** For `rate_limited`: when the provider said the quota resets (ISO 8601), if it said so. */
  retry_at: z.string().optional(),
});
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

export const QuotaObservation = z.object({
  adapter: z.string(),
  /** Provider's name for the limit window, e.g. `five_hour`, `seven_day`, `primary`. */
  window: z.string(),
  /** Share of the window used, 0..1. */
  utilization: z.number().nonnegative().optional(),
  resets_at: z.string().optional(),
  /** True when this window is exhausted and requests are refused. */
  exhausted: z.boolean().optional(),
  /** When the limit covers only some of the adapter's models: their id prefix, e.g. `openrouter/` (ADR 0014). */
  model_prefix: z.string().optional(),
});
export type QuotaObservation = z.infer<typeof QuotaObservation>;

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
    /** Absent in runs created before setup commands existed. */
    setup_commands: z.array(z.string()).optional(),
    model: z.string().optional(),
    /** The issue the run works on; absent for runs started from a prompt. */
    work_item: WorkItemRef.optional(),
    /** From `.navarch/project.yaml` at `base_commit`; absent in runs created before verification existed. */
    verify: z.array(VerifyCommand).optional(),
    protected_paths: z.array(z.string()).optional(),
    /** The Flow this run executes, copied whole so a later edit of the YAML cannot change a running run. Absent before Flows. */
    flow: z.object({ definition: FlowDefinition, params: z.record(z.string(), z.union([z.number(), z.string(), z.boolean()])) }).optional(),
    /** Spec §11: from `.navarch/project.yaml`, else the daemon's configuration. Absent before per-run levels. */
    autonomy_level: z.number().int().min(0).max(4).optional(),
    /** `auto`: the Model Router picks each agent task's adapter; `pinned`: the run's adapter and model (ADR 0013). Absent (pinned) before routing. */
    routing: z.enum(["auto", "pinned"]).optional(),
  }),
  "run.status_changed": z.object({ from: RunStatus, to: RunStatus, reason: z.string().optional() }),
  "task.created": z.object({
    node_id: z.string(),
    type: z.string(),
    profile: z.string(),
    adapter: z.string(),
    max_attempts: z.number().int().positive(),
    /** 1 for the first pass; loop nodes create one task per iteration. */
    iteration: z.number().int().positive().optional(),
    /** The run state while this task is in progress (spec §8.4). */
    stage: RunStatus.optional(),
    /** For action and github nodes: the operation, e.g. `verification.run`, `pr.create`. */
    uses: z.string().optional(),
    /** Inputs resolved when the task was created, rendered as text for the agent's prompt. */
    inputs: z.record(z.string(), z.string()).optional(),
    /** `auto` when the Model Router picks this agent task's adapter at dispatch (ADR 0013). */
    routing: z.literal("auto").optional(),
  }),
  "task.status_changed": z.object({
    from: TaskStatus,
    to: TaskStatus,
    attempt: z.number().int().nonnegative(),
    reason: z.string().optional(),
    error: TaskError.optional(),
    /** On `failed → ready` after a rate limit: the task is not dispatched before this time (ISO 8601). */
    not_before: z.string().optional(),
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
    /** What later nodes can read as `nodes.<id>.outputs` (an agent's `summary`, a verification's `passed`, …). */
    outputs: z.record(z.string(), z.unknown()).optional(),
  }),
  "sandbox.created": z.object({
    sandbox_id: z.string(),
    kind: z.enum(["worktree", "container"]),
    path: z.string(),
    branch: z.string(),
    base_commit: z.string(),
    reused: z.boolean(),
  }),
  /** One setup command the Runner ran in the sandbox before the agent (output goes to the task log). */
  "sandbox.setup": z.object({
    command: z.string(),
    exit_code: z.number().int().nullable(),
    duration_ms: z.number().int().nonnegative(),
  }),
  "artifact.created": z.object({
    artifact_id: z.string(),
    kind: ArtifactKind,
    uri: z.string(),
    sha256: z.string(),
    summary: z.string(),
  }),
  "model.call.completed": UsageRecord,
  /**
   * The Model Router chose where an agent task runs (spec §6.4.2). The task's adapter and model
   * change to the chosen ones and its resume token is dropped, since it belonged to another agent.
   */
  "model.routed": z.object({
    /** Catalog id. */
    model_id: z.string(),
    adapter: z.string(),
    model: z.string().optional(),
    provider: z.string(),
    tier: z.enum(["fast", "standard", "expert"]),
    reason: z.string(),
    candidates: z.array(z.string()),
    skipped: z.array(z.object({ id: z.string(), reason: z.string() })),
    /** On a fallback after a rate limit: the catalog id the task left. */
    fallback_from: z.string().optional(),
  }),
  /** An instruction from the user to a run's agents (ADR 0019); `task_id` targets one task. */
  "run.message": z.object({
    message_id: z.string(),
    text: z.string(),
    task_id: z.string().optional(),
    delivery: z.enum(["next", "now"]),
  }),
  /** An instruction reached an agent: it was in the prompt of this task's attempt. */
  "run.message.delivered": z.object({ message_id: z.string(), task_id: z.string(), attempt: z.number().int().positive() }),
  /** Quota state an agent reported for its account (e.g. Claude's 5-hour and weekly windows). */
  "quota.observed": QuotaObservation,
  /** The GitHub Integration read a work item (spec §7.1); recorded before the run that uses it. */
  "workitem.received": WorkItem,
  /** The Runner checked a task's worktree with the project's verify commands (spec §6.6). */
  "verification.completed": VerificationReport.extend({ artifact_id: z.string() }),
  /** The GitHub Integration pushed a run branch. Only `navarch/*` branches, never forced. */
  "github.push": z.object({ repo: z.string(), branch: z.string(), commit: z.string() }),
  "github.pr.opened": z.object({
    repo: z.string(),
    number: z.number().int().positive(),
    url: z.string().url(),
    branch: z.string(),
    draft: z.boolean(),
  }),
  /** The Policy Engine asked a human before a side effect (spec §6.10.3); the task waits. */
  "approval.requested": z.object({
    approval_id: z.string(),
    action: z.string(),
    resource: z.string(),
    reason: z.string(),
    /** What will happen, shown to whoever decides. */
    summary: z.string(),
  }),
  "approval.decided": z.object({
    approval_id: z.string(),
    decision: z.enum(["approved", "rejected"]),
    reason: z.string().optional(),
  }),
  /** A node whose `when` was false; the flow continues with the next one. */
  "flow.node.skipped": z.object({ node_id: z.string(), reason: z.string() }),
  "policy.denied": z.object({
    action: z.string(),
    resource: z.string(),
    reason: z.string(),
  }),
  /** A phone was paired from the desktop UI (ADR 0020). Tokens and their hashes never appear in events. */
  "device.paired": z.object({ device_id: z.string(), name: z.string() }),
  /** A device can no longer sign in: revoked by the user, by itself, or after a refresh token was reused. */
  "device.revoked": z.object({ device_id: z.string(), reason: z.string() }),
  /** A device turned Web Push on or off; the subscription itself is kept outside the event log. */
  "device.push_changed": z.object({ device_id: z.string(), enabled: z.boolean() }),
  /** The kill switch paused every active run (spec §6.12.4). */
  "fleet.stopped": z.object({ run_ids: z.array(z.string()) }),
  "notification.sent": z.object({
    channel: z.literal("web_push"),
    device_id: z.string(),
    kind: z.string(),
    run_id: z.string().nullable(),
  }),
  "notification.failed": z.object({
    channel: z.literal("web_push"),
    device_id: z.string(),
    kind: z.string(),
    status: z.number().int().nullable(),
    message: z.string(),
  }),
  /** A message in a concierge conversation (ADR 0016); the assistant's carries its model and usage. */
  "concierge.message": z.object({
    conversation_id: z.string(),
    role: z.enum(["user", "assistant"]),
    text: z.string(),
    model: z.string().optional(),
    tokens_in: z.number().int().nonnegative().optional(),
    tokens_out: z.number().int().nonnegative().optional(),
    cost: z.number().nonnegative().optional(),
  }),
  /** The concierge proposed an action; nothing happens until the operator confirms it. */
  "concierge.action.proposed": z.object({
    conversation_id: z.string(),
    proposal_id: z.string(),
    action: z.string(),
    args: z.record(z.string(), z.unknown()),
    summary: z.string(),
  }),
  "concierge.action.decided": z.object({
    conversation_id: z.string(),
    proposal_id: z.string(),
    decision: z.enum(["approved", "rejected"]),
    result: z.string().optional(),
    error: z.string().optional(),
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

export type NavarchEvent<T extends EventType = EventType> = {
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
