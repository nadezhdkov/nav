import { z } from "zod";
import { AttachmentInfo, RunAttachments } from "./attachments.ts";
import { EventType } from "./events.ts";
import { FlowDefinition } from "./flow.ts";
import { RunStatus, TaskStatus } from "./status.ts";
import { ISSUE_REF, WorkItemRef } from "./work.ts";

/** Core API contracts, spec §9.1. */

/** Agent adapters Navarch can run (spec §6.3.2). */
export const AdapterId = z.enum(["claude-code", "gemini-cli", "antigravity", "codex", "copilot", "opencode", "kilo", "grok", "native"]);
export type AdapterId = z.infer<typeof AdapterId>;

export const CreateRunRequest = z
  .object({
    repo_path: z.string().min(1),
    /** What to do; with `issue`, extra instructions added after the issue. */
    prompt: z.string().min(1).optional(),
    /** `owner/repo#N`: the run implements this GitHub issue; the repository's origin must match. */
    issue: z.string().regex(ISSUE_REF, "expected owner/repo#number").optional(),
    /** A pull request of the clone's origin, `owner/repo#N` (ADR 0032); not with `issue`. */
    pull_request: z.string().regex(ISSUE_REF, "expected owner/repo#number").optional(),
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
    /** Small text documents (a spec, notes) every agent of the run reads after its task. */
    attachments: RunAttachments.optional(),
    /** Values for the Flow's params, checked against their declared types (ADR 0031). */
    params: z.record(z.string(), z.union([z.number(), z.string(), z.boolean()])).optional(),
  })
  .refine((r) => r.prompt || r.issue || r.pull_request, { message: "a run needs a prompt, an issue or a pull request" })
  .refine((r) => !(r.issue && r.pull_request), { message: "a run works on an issue or a pull request, not both" });
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
  /** Billed cost (ADR 0023). */
  cost: z.number(),
  /** API-equivalent cost of plan use, where the agent reports one. */
  plan_cost: z.number(),
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
  /** Codename people read and type, e.g. "brave-frigate" (ADR 0027); the id stays the identifier. */
  name: z.string(),
  status: RunStatus,
  repo_path: z.string(),
  base_commit: z.string(),
  prompt: z.string(),
  budget: z.number(),
  /** Billed cost, what the budget counts (ADR 0023). */
  cost_total: z.number(),
  /** API-equivalent cost of plan use. */
  plan_cost: z.number(),
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
  /** Copies of the Flows its `subflow` nodes run, by name (ADR 0032). */
  subflows: z.record(z.string(), FlowDefinition).optional(),
  /** A Studio Flow and its published version (ADR 0033); absent for built-ins. */
  source: z.enum(["builtin", "studio"]).optional(),
  version: z.number().int().positive().optional(),
});
export type RunFlow = z.infer<typeof RunFlow>;

/** A member of a team as the run's tasks show it (ADR 0022). */
export const TeamMemberView = z.object({
  key: z.string(),
  title: z.string(),
  profile: z.string(),
  prefer: z.string().nullable(),
  depends_on: z.array(z.string()),
  /** The lead turn that added it. */
  turn: z.number().int(),
  task_id: z.string().nullable(),
  /** The task's status; `planned` before it starts, `skipped` when a dependency did not succeed. */
  status: z.string(),
  summary: z.string().nullable(),
  /** How a parallel member's branch got back into the run's worktree (ADR 0029); null when it is not merged (read-only, sequential team). */
  merge: z.enum(["pending", "merging", "resolving", "merged", "conflict"]).nullable(),
  /** The member's own branch in a parallel team. */
  branch: z.string().nullable(),
});
export type TeamMemberView = z.infer<typeof TeamMemberView>;

/** A run's team: its lead's turns, members, open question and the lead's own sub-agents. */
export const TeamView = z.object({
  node_id: z.string(),
  turn: z.number().int(),
  max_turns: z.number().int().nullable(),
  lead_task_id: z.string().nullable(),
  members: z.array(TeamMemberView),
  /** The lead's question while the team waits for the user. */
  question: z.string().nullable(),
  /** The latest valid plan's summary. */
  summary: z.string().nullable(),
  /** Turns whose plan was invalid, with the reason given back to the lead. */
  plan_errors: z.array(z.object({ turn: z.number().int(), error: z.string() })),
  subagents: z.array(z.object({ task_id: z.string(), tool_use_id: z.string(), description: z.string(), status: z.enum(["started", "finished"]) })),
});
export type TeamView = z.infer<typeof TeamView>;

/** One competitor of a compete node (ADR 0031). */
export const CompetitorView = z.object({
  key: z.string(),
  /** Its latest implement task. */
  task_id: z.string().nullable(),
  status: z.string(),
  /** Working, a finalist (its checks passed), or out. */
  state: z.enum(["working", "finalist", "out"]),
  /** Why it is out. */
  reason: z.string().nullable(),
  adapter: z.string().nullable(),
  model: z.string().nullable(),
  iterations: z.number().int(),
  branch: z.string().nullable(),
  summary: z.string().nullable(),
  /** 1 for the judge's first; null until judged or when not a finalist. */
  rank: z.number().int().nullable(),
  score: z.number().nullable(),
  judge_reason: z.string().nullable(),
});
export type CompetitorView = z.infer<typeof CompetitorView>;

/** A run's compete node: competitors, the judge's verdict and the winner. */
export const CompeteView = z.object({
  node_id: z.string(),
  competitors: z.array(CompetitorView),
  judge_task_id: z.string().nullable(),
  judge_summary: z.string().nullable(),
  /** Why the judge's latest answer was not a valid ranking. */
  judge_error: z.string().nullable(),
  winner: z.string().nullable(),
  chosen_by: z.enum(["judge", "user", "only_finalist"]).nullable(),
  adopted: z.boolean(),
});
export type CompeteView = z.infer<typeof CompeteView>;

export const RunDetail = RunView.extend({
  /** Null for runs created before Flows. */
  flow_definition: RunFlow.nullable(),
  tasks: z.array(TaskView),
  artifacts: z.array(
    z.object({ id: z.string(), task_id: z.string(), kind: z.string(), uri: z.string(), summary: z.string() }),
  ),
  /** Set for runs whose Flow has a `team` node (ADR 0022). */
  team: TeamView.nullable(),
  /** Set for runs whose Flow has a `compete` node (ADR 0031). */
  compete: CompeteView.nullable(),
  /** Documents attached to the run, by name and size; their text is in `run.created`. */
  attachments: z.array(AttachmentInfo),
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
  /** Options to pick when approving, the default first; empty for a plain yes or no (ADR 0031). */
  choices: z.array(z.string()),
  /** The option picked, once approved with one. */
  choice: z.string().nullable(),
  created_at: z.string(),
  decided_at: z.string().nullable(),
});
export type ApprovalView = z.infer<typeof ApprovalView>;

export const DecideApprovalRequest = z.object({
  decision: z.enum(["approve", "reject"]),
  reason: z.string().optional(),
  /** One of the approval's choices; only with `approve`. */
  choice: z.string().min(1).optional(),
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

/** A paired phone (ADR 0020, spec §6.12.3). */
export const DeviceView = z.object({
  id: z.string(),
  name: z.string(),
  paired_at: z.string(),
  last_seen_at: z.string().nullable(),
  revoked_at: z.string().nullable(),
  /** Web Push is on for this device. */
  push: z.boolean(),
});
export type DeviceView = z.infer<typeof DeviceView>;

/** A single-use pairing code, shown as a QR code of `url` on the desktop. */
export const DevicePairing = z.object({ code: z.string(), url: z.string(), expires_at: z.string() });
export type DevicePairing = z.infer<typeof DevicePairing>;

export const PairDeviceRequest = z.object({
  code: z.string().min(1).max(256),
  name: z.string().trim().min(1).max(80),
});
export type PairDeviceRequest = z.infer<typeof PairDeviceRequest>;

export const RefreshDeviceRequest = z.object({ refresh_token: z.string().min(1).max(256) });
export type RefreshDeviceRequest = z.infer<typeof RefreshDeviceRequest>;

/** A short-lived access token and a rotating refresh token for one device. */
export const DeviceSession = z.object({
  device: DeviceView,
  access_token: z.string(),
  access_expires_at: z.string(),
  refresh_token: z.string(),
});
export type DeviceSession = z.infer<typeof DeviceSession>;

/** The Web UI's languages (ADR 0017); notifications are written in the device's. */
export const Locale = z.enum(["en", "pt-BR", "es", "de", "zh-CN"]);
export type Locale = z.infer<typeof Locale>;

/** A browser's Web Push subscription (`PushSubscription.toJSON()`) and the language to notify in. */
export const PushSubscriptionRequest = z.object({
  endpoint: z.string().url().max(2048),
  keys: z.object({ p256dh: z.string().min(1).max(256), auth: z.string().min(1).max(64) }),
  locale: Locale.default("en"),
});
export type PushSubscriptionRequest = z.infer<typeof PushSubscriptionRequest>;

export const PushKey = z.object({ public_key: z.string() });
export type PushKey = z.infer<typeof PushKey>;

/** Remote access as the daemon sees it (`GET /api/v1/remote`, `navarch remote status`). */
export const RemoteStatus = z.object({
  mode: z.enum(["tailscale", "off"]),
  installed: z.boolean(),
  running: z.boolean(),
  /** The HTTPS origin the phone opens; from the config or the tailnet name. */
  url: z.string().nullable(),
  /** `tailscale serve` proxies that origin to this daemon. */
  serving: z.boolean(),
  /** What to run when `serving` is false. */
  setup_command: z.string(),
});
export type RemoteStatus = z.infer<typeof RemoteStatus>;

/** The kill switch's result: the runs it paused. */
export const StopResult = z.object({ paused: z.array(z.string()) });
export type StopResult = z.infer<typeof StopResult>;

/** A repository earlier runs used; a phone can start runs only in these. */
export const RepoView = z.object({ path: z.string(), last_run_at: z.string() });
export type RepoView = z.infer<typeof RepoView>;

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
  waiting: z.object({ kind: z.enum(["approval", "quota", "question"]), until: z.string().optional() }).nullable(),
  /** Whether its adapter can resume a session, so `now` instructions are possible. */
  resumable: z.boolean(),
  /** Instructions waiting for this agent (targeted at it, or at the whole run). */
  pending_messages: z.number().int().nonnegative(),
  /** Its part in a team (ADR 0022), and the member key. */
  team_role: z.enum(["lead", "member"]).nullable(),
  team_key: z.string().nullable(),
});
export type FleetAgent = z.infer<typeof FleetAgent>;

/** Finished Flow nodes over all nodes of the run's Flow copy; a loop iteration counts once (slice 10). */
export const RunProgress = z.object({ done: z.number().int().nonnegative(), total: z.number().int().nonnegative() });
export type RunProgress = z.infer<typeof RunProgress>;

export const FleetRun = RunView.extend({
  agents: z.array(FleetAgent),
  team: TeamView.nullable(),
  compete: CompeteView.nullable(),
  /** Null for runs created before Flows. */
  progress: RunProgress.nullable(),
  /** The registered project whose path is the run's `repo_path` (ADR 0021). */
  project_id: z.string().nullable(),
});
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

/** A file changed in a run's worktree since the run's base commit (slice 10). */
export const WorktreeFileStatus = z.enum(["added", "modified", "deleted", "renamed", "untracked"]);
export type WorktreeFileStatus = z.infer<typeof WorktreeFileStatus>;

export const WorktreeFile = z.object({
  /** Relative to the worktree. */
  path: z.string(),
  old_path: z.string().optional(),
  status: WorktreeFileStatus,
  /** Null for binary files. */
  added: z.number().int().nonnegative().nullable(),
  removed: z.number().int().nonnegative().nullable(),
});
export type WorktreeFile = z.infer<typeof WorktreeFile>;

/** The live state of a run's worktree, read without touching its index or files. */
export const WorktreeStatus = z.object({
  run_id: z.string(),
  branch: z.string().nullable(),
  path: z.string().nullable(),
  base_commit: z.string(),
  /** False before the worktree is created and after it is removed. */
  exists: z.boolean(),
  files: z.array(WorktreeFile),
  totals: z.object({ files: z.number().int().nonnegative(), added: z.number().int().nonnegative(), removed: z.number().int().nonnegative() }),
});
export type WorktreeStatus = z.infer<typeof WorktreeStatus>;

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
