import { z } from "zod";
import { EventType } from "./events.ts";
import { FlowDefinition } from "./flow.ts";
import { RunStatus, TaskStatus } from "./status.ts";
import { ISSUE_REF, WorkItemRef } from "./work.ts";

/** Core API contracts, spec §9.1. */

/** Agent adapters Navarch can run (spec §6.3.2). */
export const AdapterId = z.enum(["claude-code", "gemini-cli", "antigravity", "codex", "copilot", "opencode", "native"]);
export type AdapterId = z.infer<typeof AdapterId>;

export const CreateRunRequest = z
  .object({
    repo_path: z.string().min(1),
    /** What to do; with `issue`, extra instructions added after the issue. */
    prompt: z.string().min(1).optional(),
    /** `owner/repo#N`: the run implements this GitHub issue; the repository's origin must match. */
    issue: z.string().regex(ISSUE_REF, "expected owner/repo#number").optional(),
    /**
     * Pins every agent of the run to this adapter. Without it (and without `model`) the Model
     * Router picks one per task, or the daemon's `default_adapter` when routing is off.
     */
    adapter: AdapterId.optional(),
    budget: z.number().positive().optional(),
    allow_commands: z.array(z.string()).optional(),
    /** Commands the Runner runs in the worktree before the agent's first attempt (e.g. `npm ci`). */
    setup_commands: z.array(z.string().min(1)).optional(),
    model: z.string().optional(),
    /** A Flow by name; defaults to `fix-issue` for issue runs and `task` for prompt runs. */
    flow: z.string().regex(/^[a-z][a-z0-9-]*$/).optional(),
  })
  .refine((r) => r.prompt || r.issue, { message: "a run needs a prompt or an issue" });
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
  /** The model the task runs on, when one was chosen (by `--model` or the Model Router). */
  model: z.string().nullable(),
  sandbox_path: z.string().nullable(),
  branch: z.string().nullable(),
  cost: z.number(),
  summary: z.string().nullable(),
  error: z.string().nullable(),
  /** Set while a rate-limited task waits for its quota to reset. */
  not_before: z.string().nullable(),
  updated_at: z.string(),
  /** Loop iteration, 1 for nodes outside loops. */
  iteration: z.number().int(),
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
  work_item: WorkItemRef.nullable(),
  pr_url: z.string().nullable(),
  /** The Flow's name; null for runs created before Flows. */
  flow: z.string().nullable(),
  autonomy_level: z.number().int().nullable(),
});
export type RunView = z.infer<typeof RunView>;

/** The run's own copy of its Flow and the params it started with (ADR 0011). */
export const RunFlow = z.object({
  definition: FlowDefinition,
  params: z.record(z.string(), z.union([z.number(), z.string(), z.boolean()])),
});
export type RunFlow = z.infer<typeof RunFlow>;

export const RunDetail = RunView.extend({
  /** Null for runs created before Flows. */
  flow_definition: RunFlow.nullable(),
  tasks: z.array(TaskView),
  artifacts: z.array(
    z.object({ id: z.string(), task_id: z.string(), kind: z.string(), uri: z.string(), summary: z.string() }),
  ),
});
export type RunDetail = z.infer<typeof RunDetail>;

export const ApprovalStatus = z.enum(["pending", "approved", "rejected", "cancelled"]);
export type ApprovalStatus = z.infer<typeof ApprovalStatus>;

/** A decision the Policy Engine left to a human (spec §6.10.3, §9.1 `/approvals`). */
export const ApprovalView = z.object({
  id: z.string(),
  run_id: z.string(),
  task_id: z.string(),
  action: z.string(),
  resource: z.string(),
  reason: z.string(),
  summary: z.string(),
  /** `cancelled` when the run ended before anyone decided. */
  status: ApprovalStatus,
  decision_reason: z.string().nullable(),
  created_at: z.string(),
  decided_at: z.string().nullable(),
});
export type ApprovalView = z.infer<typeof ApprovalView>;

export const DecideApprovalRequest = z.object({
  decision: z.enum(["approve", "reject"]),
  reason: z.string().optional(),
});
export type DecideApprovalRequest = z.infer<typeof DecideApprovalRequest>;

/** Concierge (ADR 0016): a conversation in the daemon; act tools become proposals the operator decides. */
export const CreateConversationRequest = z.object({
  /** The operator's working directory; the default repository for runs started from the conversation. */
  cwd: z.string().min(1).optional(),
});
export type CreateConversationRequest = z.infer<typeof CreateConversationRequest>;

export const ConciergeMessageRequest = z.object({ text: z.string().trim().min(1).max(8_000) });
export type ConciergeMessageRequest = z.infer<typeof ConciergeMessageRequest>;

export const ProposalView = z.object({
  id: z.string(),
  tool: z.string(),
  args: z.record(z.string(), z.unknown()),
  summary: z.string(),
  status: z.enum(["pending", "approved", "rejected", "failed"]),
});
export type ProposalView = z.infer<typeof ProposalView>;

export const ConciergeTurn = z.object({ reply: z.string(), proposals: z.array(ProposalView), model: z.string() });
export type ConciergeTurn = z.infer<typeof ConciergeTurn>;

export const DecideProposalRequest = z.object({ decision: z.enum(["approve", "reject"]) });
export type DecideProposalRequest = z.infer<typeof DecideProposalRequest>;

export const ProposalDecision = z.object({ reply: z.string(), proposal: ProposalView });
export type ProposalDecision = z.infer<typeof ProposalDecision>;

/** Web UI sign-in (ADR 0017): `navarch web` gets a single-use code; the SPA trades it for the token. */
export const WebCode = z.object({ code: z.string(), expires_at: z.string() });
export type WebCode = z.infer<typeof WebCode>;

export const WebExchangeRequest = z.object({ code: z.string().min(1).max(256) });
export type WebExchangeRequest = z.infer<typeof WebExchangeRequest>;

export const WebExchangeResponse = z.object({ token: z.string() });
export type WebExchangeResponse = z.infer<typeof WebExchangeResponse>;

/** An instruction from the user to a run (ADR 0019, spec §9.1 `/runs/:id/messages`). */
export const MessageDelivery = z.enum(["next", "now"]);
export type MessageDelivery = z.infer<typeof MessageDelivery>;

export const SendRunMessage = z.object({
  text: z.string().trim().min(1).max(4_000),
  /** Only this task receives it; required for `now`. */
  task_id: z.string().optional(),
  /** `next`: in the next agent attempt's prompt. `now`: interrupt the running task and resume it with the message. */
  delivery: MessageDelivery.default("next"),
});
export type SendRunMessage = z.infer<typeof SendRunMessage>;

export const RunMessage = z.object({
  id: z.string(),
  run_id: z.string(),
  text: z.string(),
  task_id: z.string().nullable(),
  delivery: MessageDelivery,
  created_at: z.string(),
  /** The attempt whose prompt carried it; null while it waits. */
  delivered: z.object({ task_id: z.string(), attempt: z.number().int(), at: z.string() }).nullable(),
});
export type RunMessage = z.infer<typeof RunMessage>;

/** Fleet view (ADR 0019): every agent task of recent runs, grouped by run. */
export const FleetAgent = TaskView.extend({
  /** The agent's latest progress line, else its summary or error. */
  last_activity: z.object({ text: z.string(), tool: z.string().optional(), ts: z.string() }).nullable(),
  /** Why the task is not running when it could be. */
  waiting: z.object({ kind: z.enum(["approval", "quota"]), until: z.string().optional() }).nullable(),
  /** Whether its adapter can resume a session, so `now` instructions are possible. */
  resumable: z.boolean(),
  /** Instructions waiting for this agent (targeted at it, or at the whole run). */
  pending_messages: z.number().int().nonnegative(),
});
export type FleetAgent = z.infer<typeof FleetAgent>;

export const FleetRun = RunView.extend({ agents: z.array(FleetAgent) });
export type FleetRun = z.infer<typeof FleetRun>;

export const FleetWindow = z.enum(["active", "24h"]);
export type FleetWindow = z.infer<typeof FleetWindow>;

export const FleetView = z.object({
  generated_at: z.string(),
  counts: z.object({
    running: z.number().int(),
    waiting: z.number().int(),
    failed: z.number().int(),
    done: z.number().int(),
  }),
  runs: z.array(FleetRun),
});
export type FleetView = z.infer<typeof FleetView>;

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
