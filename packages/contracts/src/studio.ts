import { z } from "zod";
import { RunStatus } from "./status.ts";

/**
 * Flow Studio (spec §6.2.3, ADR 0033): built-in Flows are the files of `flows/`; Studio Flows are
 * YAML documents in the event store with a draft and immutable published versions.
 */

export const FLOW_NAME = /^[a-z][a-z0-9-]*$/;
/** A draft's YAML is at most this many bytes. */
export const FLOW_YAML_MAX_BYTES = 64 * 1024;

/** One validation finding (ADR 0033): errors block Publish, warnings never do. */
export const FlowProblem = z.object({
  severity: z.enum(["error", "warning"]),
  message: z.string(),
  /** The node it concerns, when there is one. */
  node: z.string().optional(),
  /** The YAML path, e.g. `["nodes", 2, "profile"]`. */
  path: z.array(z.union([z.string(), z.number()])).optional(),
  /** 1-based line in the YAML text. */
  line: z.number().int().positive().optional(),
});
export type FlowProblem = z.infer<typeof FlowProblem>;

export const FlowSource = z.enum(["builtin", "studio"]);
export type FlowSource = z.infer<typeof FlowSource>;

export const FlowSummary = z.object({
  name: z.string(),
  description: z.string().nullable(),
  source: FlowSource,
  /** The latest published version of a Studio Flow; null for built-ins and unpublished drafts. */
  published_version: z.number().int().positive().nullable(),
  draft: z.object({ revision: z.number().int().positive(), saved_at: z.string() }).nullable(),
  /** Top-level nodes of the published (or built-in) Flow; null when only a draft exists. */
  node_count: z.number().int().nonnegative().nullable(),
  /**
   * What a run of the published (or built-in) Flow must start from: any prompt, an issue (it opens
   * a PR unconditionally) or a pull request; null when only a draft exists.
   */
  needs: z.enum(["prompt", "issue", "pull_request"]).nullable(),
  /** A built-in with the same name took precedence over this Studio Flow. */
  shadowed: z.boolean(),
  updated_at: z.string().nullable(),
});
export type FlowSummary = z.infer<typeof FlowSummary>;

export const FlowVersionView = z.object({ version: z.number().int().positive(), published_at: z.string(), actor: z.string(), sha256: z.string() });
export type FlowVersionView = z.infer<typeof FlowVersionView>;

export const FlowDetail = FlowSummary.extend({
  /** The draft's YAML, when there is a draft. */
  draft_yaml: z.string().nullable(),
  /** The published version's YAML, or the built-in's file. */
  published_yaml: z.string().nullable(),
  /** The published version the draft started from. */
  based_on: z.number().int().positive().nullable(),
  versions: z.array(FlowVersionView),
});
export type FlowDetail = z.infer<typeof FlowDetail>;

/** What the Studio's forms offer: the daemon's profiles, adapters, operations and runnable Flows. */
export const FlowCatalogView = z.object({
  profiles: z.array(z.object({ id: z.string(), edits: z.boolean() })),
  adapters: z.array(z.string()),
  uses: z.object({ action: z.array(z.string()), github: z.array(z.string()) }),
  /** Flows a `subflow` node may run, with their params. */
  flows: z.array(z.object({ name: z.string(), params: z.record(z.string(), z.object({ type: z.string(), default: z.union([z.number(), z.string(), z.boolean()]) })) })),
});
export type FlowCatalogView = z.infer<typeof FlowCatalogView>;

export const SaveFlowDraftRequest = z.object({
  yaml: z.string(),
  /** The draft revision the editor loaded; null when there is no draft yet. */
  revision: z.number().int().positive().nullable(),
});
export type SaveFlowDraftRequest = z.infer<typeof SaveFlowDraftRequest>;

export const FlowRevisionRequest = z.object({ revision: z.number().int().positive() });
export type FlowRevisionRequest = z.infer<typeof FlowRevisionRequest>;

export const ValidateFlowRequest = z.object({ yaml: z.string(), name: z.string().optional() });
export type ValidateFlowRequest = z.infer<typeof ValidateFlowRequest>;

export const ValidateFlowResponse = z.object({ problems: z.array(FlowProblem) });
export type ValidateFlowResponse = z.infer<typeof ValidateFlowResponse>;

const Scalar = z.union([z.string(), z.number(), z.boolean()]);
const Outputs = z.record(z.string(), Scalar);

/** What a simulated node does (ADR 0033): its outputs per iteration (the last repeats), or fail. */
export const SimulatedOutcome = z.object({
  outputs: z.union([Outputs, z.array(Outputs).min(1)]).optional(),
  /** The node's task fails (or, for an approval, is rejected). */
  fail: z.boolean().optional(),
});
export type SimulatedOutcome = z.infer<typeof SimulatedOutcome>;

export const SimulationRequest = z.object({
  yaml: z.string(),
  params: z.record(z.string(), Scalar).optional(),
  autonomy_level: z.number().int().min(0).max(3).default(2),
  outcomes: z.record(z.string(), SimulatedOutcome).default({}),
});
export type SimulationRequest = z.input<typeof SimulationRequest>;

export const SimulatedStep = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("start"),
    node: z.string(),
    type: z.string(),
    iteration: z.number().int().positive(),
    stage: RunStatus,
    status: z.enum(["succeeded", "failed"]),
    outputs: z.record(z.string(), z.unknown()),
  }),
  z.object({ kind: z.literal("skip"), node: z.string(), reason: z.string() }),
]);
export type SimulatedStep = z.infer<typeof SimulatedStep>;

export const SimulationResult = z.object({
  problems: z.array(FlowProblem),
  steps: z.array(SimulatedStep),
  /** Null when the Flow has errors and was not simulated. */
  end: z
    .discriminatedUnion("kind", [
      z.object({ kind: z.literal("done"), pr_opened: z.boolean() }),
      z.object({ kind: z.literal("fail"), reason: z.string() }),
      z.object({ kind: z.literal("limit") }),
    ])
    .nullable(),
});
export type SimulationResult = z.infer<typeof SimulationResult>;
