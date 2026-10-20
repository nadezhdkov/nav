import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { NativeAdapter, ModelError, chat } from "@navarch/adapter-native";
import type { AgentRuntime } from "@navarch/agent-runtime";
import {
  newId,
  workItemId,
  type Actor,
  type CloneRepoRequest,
  CreateRepoRequest,
  type CreateProjectRequest,
  type GitHubRepoView,
  type InboxItemDetail,
  type InboxItemView,
  type InboxView,
  type NewEvent,
  type ProjectSyncResult,
  type ProjectView,
  type AddProjectResult,
  type StartInboxRequest,
  type StartInboxResult,
  type TriageState,
  type WorkItemStatus,
} from "@navarch/contracts";
import { GitHubError, type GitHubRepo } from "@navarch/github";
import { resolveRepoRoot } from "@navarch/runner";
import type { Config } from "../config.ts";
import type { EventStore, ProjectRecord, WorkItemRecord } from "../events/store.ts";
import { workspaceRoot } from "./workspace.ts";
import { GitHubIntegrationError, type GitHubIntegration } from "../github/integration.ts";
import type { Orchestrator } from "../orchestrator/orchestrator.ts";
import type { PolicyEngine } from "../policy/engine.ts";
import { nativeModels } from "../routing/native-models.ts";
import { estimatesByComplexity, itemStatus } from "./estimate.ts";
import { parseTriage, triageMessages } from "./triage.ts";

export class InboxError extends Error {
  readonly code: "not_found" | "invalid_repo" | "repo_mismatch" | "conflict" | "forbidden" | "github_error";

  constructor(code: InboxError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

export type InboxDeps = {
  /** The Navarch home; managed clones live in its `repos/` (ADR 0026). */
  home: string;
  config: Config;
  store: EventStore;
  policy: PolicyEngine;
  github: GitHubIntegration;
  orchestrator: Orchestrator;
  runtime: AgentRuntime;
  adapters: Map<string, unknown>;
  now?: () => number;
};

const daemon: Actor = { kind: "system", component: "inbox" };
const MAX_TRIAGE_FAILURES = 3;
const TICK_MS = 60_000;

/**
 * Projects, the GitHub sync and the Inbox triage (ADR 0021). Syncs read through the GitHub
 * Integration only; triage asks the Agent Runtime for API models, as the concierge does; every
 * side effect is decided by the Policy Engine first.
 */
export class InboxService {
  private readonly deps: InboxDeps;
  private readonly now: () => number;
  /** ETags of a project's last listing, by project and cursor: an unchanged repository answers 304. */
  private readonly etags = new Map<string, string>();
  private readonly syncing = new Map<string, Promise<ProjectSyncResult>>();
  /** A project rate limited by GitHub is not polled before this time. */
  private readonly backoff = new Map<string, number>();
  private triaging: Promise<void> | undefined;
  private triageAgain = false;
  private unavailable: string | undefined;
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;

  constructor(deps: InboxDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
  }

  start(): void {
    this.stopped = false;
    if (this.deps.config.inbox.poll_minutes > 0) {
      this.timer = setInterval(() => void this.poll(), TICK_MS);
      this.timer.unref();
      setTimeout(() => void this.poll(), 5_000).unref();
    }
    this.kickTriage();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await Promise.allSettled([...this.syncing.values(), this.triaging]);
  }

  // --- projects ---

  listProjects(): ProjectView[] {
    const items = this.deps.store.workItems();
    return this.deps.store.listProjects().map((p) => this.projectView(p, items));
  }

  async addProject(req: CreateProjectRequest, actor: Actor): Promise<AddProjectResult> {
    let path: string;
    try {
      path = await resolveRepoRoot(resolve(req.path));
    } catch {
      throw new InboxError("invalid_repo", `${req.path} is not a git repository`);
    }
    const origin = await this.deps.github.repoOf(path);
    if (!origin) throw new InboxError("invalid_repo", `${path} has no origin on GitHub; add one or pass --github owner/name`);
    if (req.github && req.github.toLowerCase() !== origin.toLowerCase()) {
      throw new InboxError("repo_mismatch", `${path} has origin ${origin}, not ${req.github}`);
    }
    const existing = this.deps.store.listProjects().find((p) => p.path === path || p.repo.toLowerCase() === origin.toLowerCase());
    if (existing) throw new InboxError("conflict", `${existing.repo} is already project ${existing.id} (${existing.path})`);
    this.decide(actor, "project.add", origin);
    const id = newId("prj");
    const name = req.name ?? origin.split("/")[1]!;
    this.deps.store.append([{ type: "project.added", run_id: null, task_id: null, actor, payload: { project_id: id, name, repo: origin, path } }]);
    return { ...this.projectView(this.deps.store.getProject(id)!, []), warnings: await this.pushWarnings(path, origin) };
  }

  /**
   * A project the token cannot push to still syncs its Inbox and can run read-only work, but its
   * issue runs will be refused at start (go/no-go F5): say so when it is added.
   */
  private async pushWarnings(path: string, repo: string): Promise<string[]> {
    try {
      await this.deps.github.checkPush(path, repo);
      return [];
    } catch (err) {
      const why = err instanceof Error ? err.message.split("\n")[0] : String(err);
      return [
        `${why}: issue runs here cannot open PRs until the GitHub token has write access (fine-grained PAT: Contents and Pull requests read and write).`,
      ];
    }
  }

  // --- GitHub repositories (ADR 0026) ---

  /** The repositories the token reaches, each with its project when one is registered. */
  async listGitHubRepos(refresh = false): Promise<GitHubRepoView[]> {
    let repos: GitHubRepo[];
    try {
      repos = await this.deps.github.listRepos(refresh);
    } catch (err) {
      throw new InboxError("github_error", `listing GitHub repositories failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    const projects = new Map(this.deps.store.listProjects().map((p) => [p.repo.toLowerCase(), p]));
    return repos.map((r) => {
      const project = projects.get(r.repo.toLowerCase());
      return { ...r, project_id: project?.id ?? null, path: project?.path ?? null };
    });
  }

  /**
   * The project for a GitHub repository the token lists: the registered one, or a new clone in
   * `<home>/repos/<owner>/<name>` registered as a project. `created` says which; only a new one carries the
   * push warnings of addProject, since a registered one gave them when it was added.
   */
  async cloneProject(req: CloneRepoRequest, actor: Actor): Promise<{ project: AddProjectResult; created: boolean }> {
    const existing = this.deps.store.listProjects().find((p) => p.repo.toLowerCase() === req.repo.toLowerCase());
    if (existing) return { project: { ...this.projectView(existing, this.deps.store.workItems()), warnings: [] }, created: false };
    const listed = (await this.listGitHubRepos()).find((r) => r.repo.toLowerCase() === req.repo.toLowerCase());
    if (!listed) throw new InboxError("not_found", `${req.repo} is not among the repositories the GitHub token reaches`);
    const [owner, name] = listed.repo.split("/") as [string, string];
    const root = workspaceRoot(this.deps.config.workspace.root);
    // Under the workspace root a clone is `<root>/<name>`, where the user keeps their projects (ADR 0073).
    const dest = root ? join(root, name) : join(this.deps.home, "repos", owner, name);
    // A clone left by an earlier attempt is reused when its origin is this repository; addProject checks that.
    if (!existsSync(dest)) {
      try {
        await this.deps.github.clone(listed.repo, dest, actor);
      } catch (err) {
        if (err instanceof GitHubIntegrationError && err.code === "policy_denied") throw new InboxError("forbidden", err.message);
        throw new InboxError("github_error", err instanceof Error ? err.message : String(err));
      }
    }
    return { project: await this.addProject({ path: dest, github: listed.repo }, actor), created: true };
  }

  /**
   * A new repository on the token's account, cloned and registered like a picked one (ADR 0072). The
   * repository exists on GitHub once the first step succeeds, even when the clone fails; picking it
   * afterwards clones it.
   */
  async createProject(req: CreateRepoRequest, actor: Actor): Promise<AddProjectResult> {
    const parsed = CreateRepoRequest.parse(req);
    let created: GitHubRepo;
    try {
      created = await this.deps.github.createRepo({ name: parsed.name, private: parsed.private, ...(parsed.description ? { description: parsed.description } : {}) }, actor);
    } catch (err) {
      if (err instanceof GitHubIntegrationError && err.code === "policy_denied") throw new InboxError("forbidden", err.message);
      throw new InboxError("github_error", `creating the repository failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    this.deps.store.append([{ type: "github.repo.created", run_id: null, task_id: null, actor, payload: { repo: created.repo, private: created.private } }]);
    return (await this.cloneProject({ repo: created.repo }, actor)).project;
  }

  removeProject(id: string, actor: Actor): void {
    const project = this.deps.store.getProject(id);
    if (!project || project.removed_at) throw new InboxError("not_found", `project ${id} not found`);
    this.decide(actor, "project.remove", project.repo);
    this.deps.store.append([{ type: "project.removed", run_id: null, task_id: null, actor, payload: { project_id: id } }]);
  }

  // --- sync ---

  /** Syncs one project, or all of them; each result has its counts or its error. */
  async sync(projectId: string | undefined, actor: Actor): Promise<ProjectSyncResult[]> {
    const projects = projectId ? [this.project(projectId)] : this.deps.store.listProjects();
    const results = await Promise.all(projects.map((p) => this.syncProject(p, actor)));
    this.kickTriage();
    return results;
  }

  /** Polling: syncs each project whose last sync is older than `inbox.poll_minutes`, one at a time. */
  async poll(): Promise<void> {
    const minutes = this.deps.config.inbox.poll_minutes;
    if (this.stopped || minutes <= 0) return;
    const now = this.now();
    for (const project of this.deps.store.listProjects()) {
      if (this.stopped) return;
      if ((this.backoff.get(project.id) ?? 0) > now) continue;
      if (project.synced_at && now - Date.parse(project.synced_at) < minutes * 60_000) continue;
      await this.syncProject(project, daemon);
    }
    this.kickTriage();
  }

  private syncProject(project: ProjectRecord, actor: Actor): Promise<ProjectSyncResult> {
    const running = this.syncing.get(project.id);
    if (running) return running;
    const job = this.doSync(project, actor).finally(() => this.syncing.delete(project.id));
    this.syncing.set(project.id, job);
    return job;
  }

  private async doSync(project: ProjectRecord, actor: Actor): Promise<ProjectSyncResult> {
    const empty = { project_id: project.id, new: 0, changed: 0, closed: 0, not_modified: false };
    const decision = this.deps.policy.decide(actor, "inbox.sync", project.repo, { autonomyLevel: this.deps.config.autonomy_level });
    if (decision.effect !== "allow") return { ...empty, error: `sync denied: ${decision.reason}` };
    const cursor = project.sync_cursor ?? undefined;
    const etagKey = `${project.id}|${cursor ?? ""}`;
    let listing;
    try {
      listing = await this.deps.github.client.listIssues(project.repo, { ...(cursor ? { since: cursor } : {}), ...(this.etags.has(etagKey) ? { etag: this.etags.get(etagKey)! } : {}) });
    } catch (err) {
      if (err instanceof GitHubError && err.resetAt) this.backoff.set(project.id, Date.parse(err.resetAt));
      return { ...empty, error: (err as Error).message };
    }
    const synced = (r: Omit<ProjectSyncResult, "project_id" | "error">, next?: string): NewEvent => ({
      type: "inbox.synced",
      run_id: null,
      task_id: null,
      actor,
      payload: { project_id: project.id, ...r, ...(next ? { cursor: next } : {}) },
    });
    if (listing.notModified) {
      this.deps.store.append([synced({ new: 0, changed: 0, closed: 0, not_modified: true })]);
      return { ...empty, not_modified: true };
    }

    const known = new Map(this.deps.store.workItems({ projectId: project.id }).map((i) => [i.id, i]));
    const events: NewEvent[] = [];
    const counts = { new: 0, changed: 0, closed: 0, not_modified: false };
    const seen = new Set<string>();
    let next = cursor;
    const github: Actor = { kind: "system", component: "github" };
    for (const issue of listing.issues) {
      if (!next || issue.updated_at > next) next = issue.updated_at;
      const id = workItemId(issue.repo, issue.number);
      seen.add(id);
      const item = known.get(id);
      if (issue.state === "closed") {
        if (item && !item.closed) {
          events.push({ type: "workitem.closed", run_id: null, task_id: null, actor: github, payload: { item_id: id } });
          counts.closed++;
        }
        continue;
      }
      const { state: _state, updated_at: _updated, ...workItem } = issue;
      if (item && !item.closed && item.title === issue.title && item.body === issue.body && sameLabels(item.labels, issue.labels)) continue;
      if (item) counts.changed++;
      else counts.new++;
      events.push({ type: "workitem.received", run_id: null, task_id: null, actor: github, payload: { ...workItem, project_id: project.id } });
    }
    // A full listing (the first sync) has every open issue: items missing from it were closed.
    if (!cursor) {
      for (const item of known.values()) {
        if (!item.closed && !seen.has(item.id)) {
          events.push({ type: "workitem.closed", run_id: null, task_id: null, actor: github, payload: { item_id: item.id } });
          counts.closed++;
        }
      }
    }
    this.deps.store.append([...events, synced(counts, next)]);
    if (listing.etag) this.etags.set(`${project.id}|${next ?? ""}`, listing.etag);
    return { project_id: project.id, ...counts };
  }

  // --- triage ---

  /** Starts triaging items that need it, unless a pass is already running (then it runs again after). */
  kickTriage(): void {
    if (this.stopped || !this.deps.config.inbox.triage.enabled) return;
    if (this.triaging) {
      this.triageAgain = true;
      return;
    }
    this.triaging = this.drain()
      .catch(() => {})
      .finally(() => {
        this.triaging = undefined;
        if (this.triageAgain && !this.stopped) {
          this.triageAgain = false;
          this.kickTriage();
        }
      });
  }

  /** Resolves when no triage pass is running (tests and the API's sync wait on it). */
  async idle(): Promise<void> {
    while (this.triaging) await this.triaging;
  }

  triageState(): TriageState {
    const cap = { items: this.deps.config.inbox.triage.daily_items, usd: this.deps.config.inbox.triage.daily_usd };
    const used = this.deps.store.triageUsage(this.dayStart());
    const limited = used.items >= cap.items || used.usd >= cap.usd;
    const reason = !this.deps.config.inbox.triage.enabled
      ? "triage is off (inbox.triage.enabled: false)"
      : (this.unavailable ?? (limited ? `daily triage limit reached (${cap.items} items, $${cap.usd})` : undefined));
    return { available: !reason, ...(reason ? { reason } : {}), used_today: { items: used.items, usd: round(used.usd) }, cap };
  }

  private async drain(): Promise<void> {
    for (;;) {
      if (this.stopped) return;
      const items = this.deps.store.workItems();
      const item = items.find(needsTriage);
      if (!item) return;
      const usage = this.deps.store.triageUsage(this.dayStart());
      const cap = { items: this.deps.config.inbox.triage.daily_items, usd: this.deps.config.inbox.triage.daily_usd };
      const decision = this.deps.policy.decide(daemon, "inbox.triage", item.id, { autonomyLevel: this.deps.config.autonomy_level, usage, cap });
      if (decision.effect !== "allow") return;
      const native = this.deps.adapters.get("native");
      if (!(native instanceof NativeAdapter)) {
        this.unavailable = "triage needs the native adapter (adapters.native.enabled)";
        return;
      }
      const found = nativeModels(this.deps, "inbox", this.deps.config.inbox.model);
      if ("reason" in found) {
        this.unavailable = `no API model for triage: ${found.reason}. Set inbox.model (e.g. openrouter/<id>:free) or add native entries to the inbox tier (routing.profiles.inbox, default fast)`;
        return;
      }
      this.unavailable = undefined;
      const others = items.filter((o) => o.project_id === item.project_id && o.id !== item.id && !o.closed && !o.dismissed);
      await this.triageOne(native, found.models, item, others);
    }
  }

  private async triageOne(native: NativeAdapter, models: string[], item: WorkItemRecord, others: WorkItemRecord[]): Promise<void> {
    const messages = triageMessages(item, others.map((o) => ({ number: o.number, title: o.title })));
    let lastError = "no model answered";
    let lastModel: string | undefined;
    for (const model of models) {
      lastModel = model;
      try {
        const { provider, model: providerModel } = await native.connect(model);
        const response = await chat(provider, providerModel, messages, [], new AbortController().signal, 120_000);
        const parsed = parseTriage(response.message.content, new Set(others.map((o) => o.number)));
        const actor: Actor = { kind: "agent", profile: "inbox", adapter: "native", model };
        if ("error" in parsed) {
          this.deps.store.append([{ type: "workitem.triage_failed", run_id: null, task_id: null, actor, payload: { item_id: item.id, model, reason: parsed.error } }]);
        } else {
          this.deps.store.append([
            { type: "workitem.triaged", run_id: null, task_id: null, actor, payload: { item_id: item.id, triage: parsed.triage, model, cost_usd: response.usage.cost } },
          ]);
        }
        return;
      } catch (err) {
        lastError = (err as Error).message;
        if (err instanceof ModelError && err.kind === "rate_limited" && err.limit) {
          const provider = model.split("/")[0];
          this.deps.store.append([
            {
              type: "quota.observed",
              run_id: null,
              task_id: null,
              actor: { kind: "agent", profile: "inbox", adapter: "native", model },
              payload: { adapter: "native", window: err.limit.window, resets_at: err.limit.resetsAt, exhausted: true, model_prefix: `${provider}/` },
            },
          ]);
        }
        // A rate limit or a passing failure moves to the next model; anything else ends the attempt.
        if (!(err instanceof ModelError) || (err.kind !== "rate_limited" && err.kind !== "transient")) break;
      }
    }
    this.deps.store.append([
      { type: "workitem.triage_failed", run_id: null, task_id: null, actor: daemon, payload: { item_id: item.id, ...(lastModel ? { model: lastModel } : {}), reason: lastError.slice(0, 500) } },
    ]);
  }

  // --- the Inbox ---

  list(filter: { projectId?: string; status?: WorkItemStatus[] } = {}): InboxView {
    const estimates = estimatesByComplexity(this.deps.store.finishedIssueRuns());
    const items = this.deps.store
      .workItems(filter.projectId ? { projectId: filter.projectId } : {})
      .map((i) => toView(i, estimates))
      .filter((i) => !filter.status || filter.status.includes(i.status));
    return { items, triage: this.triageState() };
  }

  get(id: string): InboxItemDetail {
    const item = this.deps.store.workItems({ id })[0];
    if (!item) throw new InboxError("not_found", `inbox item ${id} not found`);
    const view = toView(item, estimatesByComplexity(this.deps.store.finishedIssueRuns()));
    return { ...view, body: item.body, triaged_at: item.triaged_at };
  }

  /** Starts one issue run per item, in its project's clone, through the same path as `POST /runs`. */
  async startRuns(req: StartInboxRequest, actor: Actor): Promise<StartInboxResult> {
    const result: StartInboxResult = { runs: [], errors: [] };
    for (const itemId of [...new Set(req.item_ids)]) {
      const item = this.deps.store.workItems({ id: itemId })[0];
      if (!item) {
        result.errors.push({ item_id: itemId, message: "not found" });
        continue;
      }
      const status = itemStatus(item);
      if (status === "in_run" || status === "closed") {
        result.errors.push({ item_id: itemId, message: status === "in_run" ? "a run of this item is still active" : "the issue is closed" });
        continue;
      }
      const project = this.deps.store.getProject(item.project_id)!;
      try {
        const run = await this.deps.orchestrator.startRun(
          {
            repo_path: project.path,
            issue: `${item.repo}#${item.number}`,
            ...(req.flow ? { flow: req.flow } : {}),
            ...(req.budget ? { budget: req.budget } : {}),
          },
          actor,
        );
        result.runs.push({ item_id: itemId, run_id: run.id });
      } catch (err) {
        result.errors.push({ item_id: itemId, message: (err as Error).message });
      }
    }
    return result;
  }

  dismiss(id: string, reason: string | undefined, actor: Actor): InboxItemDetail {
    const item = this.get(id);
    if (item.status !== "dismissed") {
      this.deps.store.append([{ type: "workitem.dismissed", run_id: null, task_id: null, actor, payload: { item_id: id, ...(reason ? { reason } : {}) } }]);
    }
    return this.get(id);
  }

  restore(id: string, actor: Actor): InboxItemDetail {
    const item = this.get(id);
    if (item.status === "dismissed") this.deps.store.append([{ type: "workitem.restored", run_id: null, task_id: null, actor, payload: { item_id: id } }]);
    this.kickTriage();
    return this.get(id);
  }

  private project(id: string): ProjectRecord {
    const project = this.deps.store.getProject(id);
    if (!project || project.removed_at) throw new InboxError("not_found", `project ${id} not found`);
    return project;
  }

  private projectView(p: ProjectRecord, items: WorkItemRecord[]): ProjectView {
    const own = items.filter((i) => i.project_id === p.id).map(itemStatus);
    return {
      id: p.id,
      name: p.name,
      repo: p.repo,
      path: p.path,
      added_at: p.added_at,
      active_runs: this.deps.store.activeRunsIn(p.path),
      inbox: { new: own.filter((s) => s === "new").length, triaged: own.filter((s) => s === "triaged").length },
      synced_at: p.synced_at,
    };
  }

  private decide(actor: Actor, action: string, resource: string): void {
    const decision = this.deps.policy.decide(actor, action, resource, { autonomyLevel: this.deps.config.autonomy_level });
    if (decision.effect !== "allow") throw new InboxError("forbidden", `${action} denied: ${decision.reason}`);
  }

  /** Midnight of today in the PC's local time, where the daily triage caps reset. */
  private dayStart(): string {
    const d = new Date(this.now());
    d.setHours(0, 0, 0, 0);
    return d.toISOString();
  }
}

function needsTriage(item: WorkItemRecord): boolean {
  const status = itemStatus(item);
  return status === "new" && item.triage_failures < MAX_TRIAGE_FAILURES;
}

function toView(item: WorkItemRecord, estimates: Map<number, { usd: number; runs: number }>): InboxItemView {
  return {
    id: item.id,
    project_id: item.project_id,
    source: "github",
    repo: item.repo,
    number: item.number,
    url: item.url,
    title: item.title,
    labels: item.labels,
    author: item.author,
    status: itemStatus(item),
    // An item that changed since its triage keeps showing the old one until it is triaged again.
    triage: item.triage,
    triage_model: item.triage_model,
    estimate: item.triage ? (estimates.get(item.triage.complexity) ?? null) : null,
    runs: item.runs.map((r) => r.id),
    updated_at: item.updated_at,
  };
}

function sameLabels(a: string[], b: string[]): boolean {
  return a.length === b.length && [...a].sort().join("\n") === [...b].sort().join("\n");
}

function round(usd: number): number {
  return Math.round(usd * 10_000) / 10_000;
}
