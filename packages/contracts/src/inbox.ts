import { z } from "zod";
import { REPO_PATTERN } from "./work.ts";

/** Projects, the Inbox and quota windows (ADR 0021, spec §8.2, §15.3). */

/** In Phase 1 a project is one local clone of one GitHub repository. */
export const ProjectView = z.object({
  id: z.string(),
  name: z.string(),
  /** `owner/name` on GitHub. */
  repo: z.string(),
  /** The local clone runs start in. */
  path: z.string(),
  added_at: z.string(),
  /** Runs of this project that have not ended. */
  active_runs: z.number().int().nonnegative(),
  inbox: z.object({ new: z.number().int().nonnegative(), triaged: z.number().int().nonnegative() }),
  /** When the last sync of this project finished, if any. */
  synced_at: z.string().nullable(),
});
export type ProjectView = z.infer<typeof ProjectView>;

/** A project just registered, with what the user should know, e.g. that the token cannot push to it. */
export const AddProjectResult = ProjectView.extend({ warnings: z.array(z.string()) });
export type AddProjectResult = z.infer<typeof AddProjectResult>;

export const CreateProjectRequest = z.object({
  path: z.string().min(1),
  /** `owner/name`; read from the clone's `origin` when absent, and must match it when given. */
  github: z.string().regex(new RegExp(`^${REPO_PATTERN}$`), "expected owner/name").optional(),
  name: z.string().trim().min(1).max(80).optional(),
});
export type CreateProjectRequest = z.infer<typeof CreateProjectRequest>;

export const WorkItemKind = z.enum(["bug", "feature", "chore", "docs", "question"]);
export type WorkItemKind = z.infer<typeof WorkItemKind>;

export const SuggestedAction = z.enum(["start_run", "needs_info", "duplicate", "skip"]);
export type SuggestedAction = z.infer<typeof SuggestedAction>;

/** What the Inbox triage keeps of a model's answer: enums, numbers and short plain text. */
export const WorkItemTriage = z.object({
  kind: WorkItemKind,
  complexity: z.number().int().min(1).max(5),
  area: z.string().max(40),
  /** Another open item of the same project, by issue number. */
  duplicate_of: z.number().int().positive().nullable(),
  suggested_action: SuggestedAction,
  /** The Flow to start when the action is `start_run`. */
  flow: z.string().regex(/^[a-z][a-z0-9-]*$/).optional(),
  reason: z.string().max(200),
});
export type WorkItemTriage = z.infer<typeof WorkItemTriage>;

/** A WorkItem's status (spec §8.2): not a Run or Task state. */
export const WorkItemStatus = z.enum(["new", "triaged", "in_run", "done", "dismissed", "closed"]);
export type WorkItemStatus = z.infer<typeof WorkItemStatus>;

export const InboxItemView = z.object({
  id: z.string(),
  project_id: z.string(),
  source: z.literal("github"),
  repo: z.string(),
  number: z.number().int().positive(),
  url: z.string(),
  /** Untrusted (T1): shown as plain text. */
  title: z.string(),
  labels: z.array(z.string()),
  author: z.string(),
  status: WorkItemStatus,
  triage: WorkItemTriage.nullable(),
  triage_model: z.string().nullable(),
  /** Median cost of finished `fix-issue` runs with the same complexity; null below 3 runs. */
  estimate: z.object({ usd: z.number().nonnegative(), runs: z.number().int().positive() }).nullable(),
  /** Runs of this item, newest first. */
  runs: z.array(z.string()),
  updated_at: z.string(),
});
export type InboxItemView = z.infer<typeof InboxItemView>;

export const InboxItemDetail = InboxItemView.extend({ body: z.string(), triaged_at: z.string().nullable() });
export type InboxItemDetail = z.infer<typeof InboxItemDetail>;

/** The triage service's state, shown above the list. */
export const TriageState = z.object({
  /** False when no API model can triage; `reason` says why. */
  available: z.boolean(),
  reason: z.string().optional(),
  used_today: z.object({ items: z.number().int().nonnegative(), usd: z.number().nonnegative() }),
  cap: z.object({ items: z.number().int().nonnegative(), usd: z.number().nonnegative() }),
});
export type TriageState = z.infer<typeof TriageState>;

export const InboxView = z.object({ items: z.array(InboxItemView), triage: TriageState });
export type InboxView = z.infer<typeof InboxView>;

export const SyncInboxRequest = z.object({ project_id: z.string().optional() });
export type SyncInboxRequest = z.infer<typeof SyncInboxRequest>;

/** One project's sync: counts as in `inbox.synced`, or why it failed or was skipped. */
export const ProjectSyncResult = z.object({
  project_id: z.string(),
  new: z.number().int().nonnegative(),
  changed: z.number().int().nonnegative(),
  closed: z.number().int().nonnegative(),
  not_modified: z.boolean(),
  error: z.string().optional(),
});
export type ProjectSyncResult = z.infer<typeof ProjectSyncResult>;

export const SyncInboxResult = z.object({ results: z.array(ProjectSyncResult) });
export type SyncInboxResult = z.infer<typeof SyncInboxResult>;

export const StartInboxRequest = z.object({
  item_ids: z.array(z.string()).min(1).max(20),
  flow: z.string().regex(/^[a-z][a-z0-9-]*$/).optional(),
  budget: z.number().positive().optional(),
});
export type StartInboxRequest = z.infer<typeof StartInboxRequest>;

export const StartInboxResult = z.object({
  runs: z.array(z.object({ item_id: z.string(), run_id: z.string() })),
  errors: z.array(z.object({ item_id: z.string(), message: z.string() })),
});
export type StartInboxResult = z.infer<typeof StartInboxResult>;

export const DismissItemRequest = z.object({ reason: z.string().trim().max(200).optional() });
export type DismissItemRequest = z.infer<typeof DismissItemRequest>;

/** An agent's latest quota window (from `quota.observed`), for Home. */
export const QuotaView = z.object({
  adapter: z.string(),
  window: z.string(),
  utilization: z.number().nonnegative().nullable(),
  resets_at: z.string().nullable(),
  /** Exhausted and not reset yet. */
  exhausted: z.boolean(),
  model_prefix: z.string().nullable(),
  observed_at: z.string(),
});
export type QuotaView = z.infer<typeof QuotaView>;

/** Stable id of a GitHub issue in the Inbox, so a re-sync never duplicates it. */
export function workItemId(repo: string, number: number): string {
  // `owner~name`: `~` cannot appear in a GitHub name, and it is safe in a URL path.
  return `wi_github_${repo.toLowerCase().replace("/", "~")}_${number}`;
}

/** A GitHub repository the token reaches, for the New run picker (ADR 0026). */
export const GitHubRepoView = z.object({
  /** `owner/name`. */
  repo: z.string(),
  owner: z.string(),
  private: z.boolean(),
  description: z.string().nullable(),
  default_branch: z.string(),
  pushed_at: z.string().nullable(),
  /** Whether the token may push; without it a run can work but cannot open a PR. */
  can_push: z.boolean(),
  /** The project already registered for it, if any. */
  project_id: z.string().nullable(),
  /** Its local clone, when it is a registered project. */
  path: z.string().nullable(),
});
export type GitHubRepoView = z.infer<typeof GitHubRepoView>;

export const CloneRepoRequest = z.object({
  repo: z.string().regex(new RegExp(`^${REPO_PATTERN}$`), "expected owner/name"),
});
export type CloneRepoRequest = z.infer<typeof CloneRepoRequest>;

/** A new repository under the token's own account (ADR 0072): private unless the user says otherwise. */
export const CreateRepoRequest = z.strictObject({
  name: z.string().regex(/^[A-Za-z0-9._-]{1,100}$/, "letters, digits, dots, dashes and underscores, up to 100").refine((n) => !/^\.+$/.test(n) && !n.endsWith(".git"), "not a valid repository name"),
  description: z.string().max(350).optional(),
  private: z.boolean().default(true),
});
export type CreateRepoRequest = z.input<typeof CreateRepoRequest>;
