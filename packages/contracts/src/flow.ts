import { z } from "zod";

/**
 * Flow definition, spec §9.4: versioned YAML, the source of truth for what a run does. A running
 * instance is a TaskGraph (§6.2), made of tasks the Orchestrator creates as nodes become due.
 *
 * Phase 1 runs linear flows (an `edges` chain) with `trigger`, `agent`, `action`, `approval`,
 * `loop`, `github` and `team` (ADR 0022) nodes; `switch`, `parallel`, `join`, `judge`, `subflow` and `llm` arrive
 * with Phase 2 and are refused when a flow is loaded (ADR 0011).
 */

const NodeId = z.string().regex(/^[a-z][a-z0-9_]*$/, "node ids are lowercase letters, digits and _");
/** A `${{ … }}` expression (see packages/flow-engine), or a plain value. */
const Expr = z.string().min(1);
const Inputs = z.record(z.string().regex(/^[a-z][a-z0-9_]*$/), Expr);

const base = {
  id: NodeId,
  name: z.string().optional(),
  /** Runs the node only when this expression is true; otherwise it is skipped. */
  when: Expr.optional(),
};

export const TriggerNode = z.strictObject({
  ...base,
  type: z.literal("trigger"),
  /** Event names that start the flow (label triggers arrive in a later slice; runs start from the CLI/API). */
  on: z.array(z.string()).optional(),
  filter: z.record(z.string(), z.string()).optional(),
});

export const AgentNode = z.strictObject({
  ...base,
  type: z.literal("agent"),
  /** An Agent Profile (spec §6.3.3): triager, planner, implementer, reviewer. */
  profile: z.string().min(1),
  /** Adapter for this node; defaults to the run's adapter. */
  adapter: z.string().optional(),
  /** Named inputs added to the agent's prompt as delimited data blocks. */
  inputs: Inputs.optional(),
  /** Accepted for spec compatibility; the Model Router (a later slice) reads it. */
  model: z.record(z.string(), z.unknown()).optional(),
  outputs_schema: z.string().optional(),
});

export const ActionNode = z.strictObject({
  ...base,
  type: z.literal("action"),
  /** The deterministic operation, e.g. `verification.run`. */
  uses: z.string().min(1),
  with: z.record(z.string(), z.unknown()).optional(),
});

export const GitHubNode = z.strictObject({
  ...base,
  type: z.literal("github"),
  /** `pr.create` (always a draft on a `navarch/*` branch). */
  uses: z.string().min(1),
  with: z.record(z.string(), z.unknown()).optional(),
});

export const ApprovalNode = z.strictObject({
  ...base,
  type: z.literal("approval"),
  /** Outputs shown to whoever approves, e.g. `nodes.plan.outputs`. */
  show: z.array(z.string()).optional(),
});

/** A node that can run inside a loop body. */
export const BodyNode = z.discriminatedUnion("type", [AgentNode, ActionNode]);
export type BodyNode = z.infer<typeof BodyNode>;

export const LoopNode = z.strictObject({
  ...base,
  type: z.literal("loop"),
  /** A number or an expression such as `${{ params.max_fix_iterations }}`. */
  max_iterations: z.union([z.number().int().positive(), Expr]),
  /** Evaluated after each iteration; the loop ends when it is true. */
  until: Expr,
  body: z.array(BodyNode).min(1),
});

/**
 * A lead agent and the members it delegates to, turn by turn (ADR 0022). Its tasks are the lead's
 * turns (`<id>.lead`), one per member (`<id>.<key>`), a verification per turn (`<id>.verify`)
 * and the approval of the first plan (`<id>.approve_plan`); a parallel team also merges each editing
 * member back (`<id>.<key>.integrate`, `<id>.<key>.resolve` on a conflict).
 */
export const TeamNode = z.strictObject({
  ...base,
  type: z.literal("team"),
  lead: z.strictObject({ profile: z.string().min(1) }),
  /** A number or an expression; the node fails after this many lead turns. */
  max_turns: z.union([z.number().int().positive(), Expr]),
  /** A number or an expression; a plan that would take the team past this many members fails the node. */
  max_members: z.union([z.number().int().positive(), Expr]).default(12),
  /** When true, the first plan that adds members waits for a human. */
  approve_first_plan: z.union([z.boolean(), Expr]).default(false),
  /** When true, members whose dependencies are done run at once, each in its own worktree, merged back by `<id>.<key>.integrate` (ADR 0029). */
  parallel: z.union([z.boolean(), Expr]).default(false),
  /** A number or an expression; at most this many members of the team run at once. */
  max_parallel: z.union([z.number().int().positive(), Expr]).default(3),
});

export const FlowNode = z.discriminatedUnion("type", [TriggerNode, AgentNode, ActionNode, GitHubNode, ApprovalNode, LoopNode, TeamNode]);
export type FlowNode = z.infer<typeof FlowNode>;

export const FlowParam = z.strictObject({
  type: z.enum(["int", "money", "string", "bool"]),
  default: z.union([z.number(), z.string(), z.boolean()]),
});

export const FlowDefinition = z.strictObject({
  apiVersion: z.literal("navarch/v1"),
  kind: z.literal("Flow"),
  metadata: z.strictObject({
    name: z.string().regex(/^[a-z][a-z0-9-]*$/, "flow names are lowercase letters, digits and -"),
    description: z.string().optional(),
  }),
  params: z.record(z.string(), FlowParam).default({}),
  nodes: z.array(FlowNode).min(1),
  /** One chain, `a -> b -> c`, naming every top-level node once. */
  edges: z.array(z.string()).min(1),
});
export type FlowDefinition = z.infer<typeof FlowDefinition>;

/** Node types the spec defines but Phase 1 does not run yet. */
export const PHASE_2_NODE_TYPES = ["switch", "parallel", "fan-out", "join", "judge", "subflow", "llm"] as const;
