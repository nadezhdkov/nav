import { DatabaseSync } from "node:sqlite";
import {
  isTerminalRun,
  isTerminalTask,
  newId,
  parsePayload,
  type DeviceView,
  type FleetAgent,
  type TeamTaskRef,
  type TeamView,
  type RepoView,
  type FleetView,
  type FleetWindow,
  type RunMessage,
  type ApprovalStatus,
  type RunFlow,
  type ApprovalView,
  type NewEvent,
  type RunDetail,
  type RunView,
  type TaskView,
  type NavarchEvent,
  type QuotaObservation,
  type QuotaView,
  type VerifyCommand,
  type WorkItemTriage,
  attachmentInfo,
  type RunAttachment,
} from "@navarch/contracts";
import { evaluate, parseExpr, progress, teamState, teamTaskId } from "@navarch/flow-engine";
import { applyEvent } from "./projections.ts";
import { credentialTables, dropProjections, eventsTable, projectionTables } from "./schema.ts";

export type EventListener = (event: NavarchEvent) => void;

/**
 * Event store (spec §6.1.3): events are validated, written and projected in one transaction,
 * and only published to listeners after the commit (outbox semantics within one process).
 */
export class EventStore {
  readonly db: DatabaseSync;
  private readonly listeners = new Set<EventListener>();

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;");
    this.db.exec(eventsTable);
    this.db.exec(projectionTables);
    this.db.exec(credentialTables);
    // Projections are derived data: when a column was added, rebuild them from the log.
    const has = (table: string, column: string) =>
      (this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === column);
    if (!has("tasks", "not_before") || !has("runs", "protected_paths") || !has("tasks", "outputs") || !has("runs", "autonomy_level") || !has("tasks", "model_id") || !has("tasks", "instruction_interrupts") || !has("runs", "work_item_id") || !has("tasks", "team") || !has("tasks", "plan_cost") || !has("runs", "name")) {
      this.rebuildProjections();
    }
    // After the rebuild: an older runs table has no name column to index until then.
    this.db.exec("CREATE INDEX IF NOT EXISTS runs_name ON runs(name)");
  }

  close(): void {
    this.listeners.clear();
    this.db.close();
  }

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Appends events atomically; throws (and writes nothing) if any is invalid. */
  append(events: NewEvent[]): NavarchEvent[] {
    const stored: NavarchEvent[] = [];
    const insert = this.db.prepare(
      "INSERT INTO events (id, ts, type, run_id, task_id, actor, payload, schema_version) VALUES (?, ?, ?, ?, ?, ?, ?, 1)",
    );
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const e of events) {
        const payload = parsePayload(e.type, e.payload);
        const id = newId("evt");
        const ts = new Date().toISOString();
        const info = insert.run(id, ts, e.type, e.run_id, e.task_id, JSON.stringify(e.actor), JSON.stringify(payload));
        const event = {
          id,
          seq: Number(info.lastInsertRowid),
          ts,
          type: e.type,
          run_id: e.run_id,
          task_id: e.task_id,
          actor: e.actor,
          payload,
          schema_version: 1,
        } as NavarchEvent;
        applyEvent(this.db, event);
        stored.push(event);
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    for (const event of stored) {
      for (const listener of this.listeners) {
        try {
          listener(event);
        } catch {
          // A failing subscriber must not affect the writer or other subscribers.
        }
      }
    }
    return stored;
  }

  events(filter: { runId?: string; afterSeq?: number; limit?: number } = {}): NavarchEvent[] {
    const rows = filter.runId
      ? this.db
          .prepare("SELECT * FROM events WHERE run_id = ? AND seq > ? ORDER BY seq LIMIT ?")
          .all(filter.runId, filter.afterSeq ?? 0, filter.limit ?? 10_000)
      : this.db
          .prepare("SELECT * FROM events WHERE seq > ? ORDER BY seq LIMIT ?")
          .all(filter.afterSeq ?? 0, filter.limit ?? 10_000);
    return rows.map(rowToEvent);
  }

  /** Rebuilds every projection from the event log (replay, spec P5). */
  rebuildProjections(): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec(dropProjections);
      this.db.exec(projectionTables);
      this.db.exec("CREATE INDEX IF NOT EXISTS runs_name ON runs(name)");
      for (const row of this.db.prepare("SELECT * FROM events ORDER BY seq").all()) {
        applyEvent(this.db, rowToEvent(row));
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  // --- projection queries ---

  listRuns(limit = 50): RunView[] {
    return this.db.prepare("SELECT * FROM runs ORDER BY created_at DESC, id DESC LIMIT ?").all(limit).map(toRunView);
  }

  getRun(id: string): RunView | undefined {
    const row = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(id);
    return row ? toRunView(row) : undefined;
  }

  /** The run a codename belongs to, the newest when runs from before names share one (ADR 0027). */
  runIdByName(name: string): string | undefined {
    const row = this.db.prepare("SELECT id FROM runs WHERE name = ? ORDER BY created_at DESC LIMIT 1").get(name) as { id: string } | undefined;
    return row?.id;
  }

  getRunRecord(id: string): RunRecord | undefined {
    const row = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as RunRow | undefined;
    if (!row) return undefined;
    return {
      ...toRunView(row),
      adapter: row.adapter,
      profile: row.profile,
      allow_commands: JSON.parse(row.allow_commands),
      setup_commands: JSON.parse(row.setup_commands),
      model: row.model,
      verify: JSON.parse(row.verify),
      protected_paths: JSON.parse(row.protected_paths),
      flow_definition: row.flow ? (JSON.parse(row.flow) as RunFlow) : null,
      routing: row.routing === "auto" ? "auto" : "pinned",
    };
  }

  /**
   * Quota windows whose latest observation says they are exhausted and reset after `now`
   * (optionally scoped to a model prefix). Feeds the Model Router (ADR 0013, 0014).
   */
  exhaustedQuotas(now = Date.now()): { adapter: string; modelPrefix?: string; resetsAt: string }[] {
    const latest = new Map<string, QuotaObservation>();
    for (const row of this.db.prepare("SELECT payload FROM events WHERE type = 'quota.observed' ORDER BY seq").all() as { payload: string }[]) {
      const q = JSON.parse(row.payload) as QuotaObservation;
      latest.set(JSON.stringify([q.adapter, q.model_prefix ?? "", q.window]), q);
    }
    return [...latest.values()]
      .filter((q) => q.exhausted && q.resets_at && Date.parse(q.resets_at) > now)
      .map((q) => ({ adapter: q.adapter, ...(q.model_prefix ? { modelPrefix: q.model_prefix } : {}), resetsAt: q.resets_at! }));
  }

  /** Catalog ids a task left after rate limits, oldest first. */
  routedFrom(taskId: string): string[] {
    return (this.db.prepare("SELECT payload FROM events WHERE task_id = ? AND type = 'model.routed' ORDER BY seq").all(taskId) as { payload: string }[])
      .map((r) => (JSON.parse(r.payload) as { fallback_from?: string }).fallback_from)
      .filter((id): id is string => Boolean(id));
  }

  /** Nodes of a run whose `when` was false. */
  skippedNodes(runId: string): string[] {
    return (this.db.prepare("SELECT node_id FROM skipped_nodes WHERE run_id = ?").all(runId) as { node_id: string }[]).map((r) => r.node_id);
  }

  /** Every task of a run with its outputs, in creation order. */
  taskRecordsOfRun(runId: string): TaskRecord[] {
    return (this.db.prepare("SELECT * FROM tasks WHERE run_id = ? ORDER BY rowid").all(runId) as TaskRow[]).map(toTaskRecord);
  }

  getRunDetail(id: string): RunDetail | undefined {
    const run = this.getRun(id);
    if (!run) return undefined;
    const artifacts = this.db
      .prepare("SELECT id, task_id, kind, uri, summary FROM artifacts WHERE run_id = ? ORDER BY created_at")
      .all(id) as RunDetail["artifacts"];
    const flow = (this.db.prepare("SELECT flow FROM runs WHERE id = ?").get(id) as { flow: string | null }).flow;
    const definition = flow ? (JSON.parse(flow) as RunFlow) : null;
    return {
      ...run,
      flow_definition: definition,
      tasks: this.tasksOfRun(id),
      artifacts: artifacts.map((a) => ({ ...a })),
      team: this.teamOf(id, definition),
      attachments: this.runAttachments(id).map(attachmentInfo),
    };
  }

  /** The documents attached to a run, from its `run.created` event. */
  runAttachments(runId: string): RunAttachment[] {
    const row = this.db.prepare("SELECT payload FROM events WHERE run_id = ? AND type = 'run.created' ORDER BY seq LIMIT 1").get(runId) as
      | { payload: string }
      | undefined;
    return row ? ((JSON.parse(row.payload) as { attachments?: RunAttachment[] }).attachments ?? []) : [];
  }

  /** A run's team (ADR 0022), derived from its tasks with the Flow engine's own reading. */
  teamOf(runId: string, flow: RunFlow | null): TeamView | null {
    const node = flow?.definition.nodes.find((n) => n.type === "team");
    if (!flow || !node || node.type !== "team") return null;
    const rows = (this.db.prepare("SELECT * FROM tasks WHERE run_id = ? AND node_id LIKE ? ORDER BY rowid").all(runId, `${node.id}.%`) as TaskRow[]).map(toTaskRecord);
    const subagentRows = this.db.prepare("SELECT id, subagents FROM tasks WHERE run_id = ? AND subagents IS NOT NULL ORDER BY rowid").all(runId) as { id: string; subagents: string }[];
    // A parallel team's members carry their own worktree (ADR 0029).
    const parallel = rows.some((t) => t.team?.own_worktree);
    const state = teamState(node.id, rows.map((t) => ({ node_id: t.node_id, iteration: t.iteration, status: t.status, outputs: t.outputs })), parallel);
    const lead = rows.filter((t) => t.node_id === teamTaskId.lead(node.id)).sort((a, b) => b.iteration - a.iteration)[0];
    const lastPlan = state.turns.filter((t) => t.plan).at(-1)?.plan;
    let maxTurns: number | null = null;
    try {
      const v = typeof node.max_turns === "number" ? node.max_turns : Number(evaluate(parseExpr(node.max_turns), { nodes: {}, params: flow.params, project: {} }));
      maxTurns = Number.isFinite(v) ? v : null;
    } catch {
      maxTurns = null;
    }
    return {
      node_id: node.id,
      turn: state.turns.length,
      max_turns: maxTurns,
      lead_task_id: lead?.id ?? null,
      members: state.members.map((m) => {
        const task = rows.filter((t) => t.node_id === teamTaskId.member(node.id, m.key)).at(-1);
        return {
          key: m.key,
          title: m.title,
          profile: m.profile,
          prefer: m.prefer ?? null,
          depends_on: m.depends_on,
          turn: m.turn,
          task_id: task?.id ?? null,
          status: m.skipped ? "skipped" : m.status,
          summary: m.summary ?? null,
          merge: m.merge ?? null,
          branch: task?.team?.own_worktree ? (task.branch ?? null) : null,
        };
      }),
      question: lead?.status === "blocked" && lastPlan?.question ? lastPlan.question : null,
      summary: state.summary ?? null,
      plan_errors: state.turns.flatMap((t) => (t.error ? [{ turn: t.iteration, error: t.error }] : [])),
      subagents: subagentRows.flatMap((r) =>
        (JSON.parse(r.subagents) as { tool_use_id: string; description: string; status: "started" | "finished" }[]).map((x) => ({ task_id: r.id, ...x })),
      ),
    };
  }

  tasksOfRun(runId: string): TaskView[] {
    return this.db.prepare("SELECT * FROM tasks WHERE run_id = ? ORDER BY rowid").all(runId).map(toTaskView);
  }

  getTask(id: string): TaskRecord | undefined {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow | undefined;
    return row ? toTaskRecord(row) : undefined;
  }

  tasksWithStatus(status: string): TaskRecord[] {
    return (this.db.prepare("SELECT * FROM tasks WHERE status = ? ORDER BY updated_at").all(status) as TaskRow[]).map(
      toTaskRecord,
    );
  }

  /** Approvals, newest first. A pending approval whose task no longer waits (run cancelled) shows as `cancelled`. */
  listApprovals(status?: ApprovalStatus): ApprovalView[] {
    const rows = this.db
      .prepare(
        `SELECT a.*, CASE WHEN a.status = 'pending' AND t.status <> 'waiting_approval' THEN 'cancelled' ELSE a.status END AS shown
         FROM approvals a JOIN tasks t ON t.id = a.task_id ORDER BY a.created_at DESC, a.id DESC`,
      )
      .all() as Row[];
    return rows.map(toApprovalView).filter((a) => !status || a.status === status);
  }

  getApproval(id: string): ApprovalView | undefined {
    return this.listApprovals().find((a) => a.id === id);
  }

  /** True when a human approved this task's side effect (one action, or any). */
  taskApproved(taskId: string, action?: string): boolean {
    return Boolean(
      this.db.prepare("SELECT 1 FROM approvals WHERE task_id = ? AND status = 'approved' AND (? IS NULL OR action = ?)").get(taskId, action ?? null, action ?? null),
    );
  }

  /** Instructions sent to a run (ADR 0019), oldest first. */
  listMessages(runId: string): RunMessage[] {
    return this.db.prepare("SELECT * FROM run_messages WHERE run_id = ? ORDER BY created_at, rowid").all(runId).map(toRunMessage);
  }

  /** Paired devices (ADR 0020), newest first; `last_seen_at` comes from the credentials the Devices service keeps. */
  listDevices(): DeviceView[] {
    return this.db
      .prepare(
        `SELECT d.*, c.last_seen_at FROM devices d LEFT JOIN device_credentials c ON c.device_id = d.id ORDER BY d.paired_at DESC, d.rowid DESC`,
      )
      .all()
      .map(toDeviceView);
  }

  getDevice(id: string): DeviceView | undefined {
    const row = this.db.prepare("SELECT d.*, c.last_seen_at FROM devices d LEFT JOIN device_credentials c ON c.device_id = d.id WHERE d.id = ?").get(id);
    return row ? toDeviceView(row) : undefined;
  }

  /** Repositories of earlier runs, most recent first: where a phone may start a run. */
  listRepos(): RepoView[] {
    return this.db
      .prepare("SELECT repo_path AS path, MAX(created_at) AS last_run_at FROM runs GROUP BY repo_path ORDER BY last_run_at DESC LIMIT 50")
      .all()
      .map((r) => ({ path: String((r as Row).path), last_run_at: String((r as Row).last_run_at) }));
  }

  /** Undelivered instructions an attempt of this task should receive: those for the whole run or for the task. */
  pendingMessagesFor(task: { id: string; run_id: string; team?: TeamTaskRef | null }): RunMessage[] {
    // In a team run, messages to the run go to the lead; members only get those sent to them (ADR 0022).
    const toRun = !task.team || task.team.role === "lead";
    return this.db
      .prepare(`SELECT * FROM run_messages WHERE run_id = ? AND delivered_at IS NULL AND (${toRun ? "task_id IS NULL OR " : ""}task_id = ?) ORDER BY created_at, rowid`)
      .all(task.run_id, task.id)
      .map(toRunMessage);
  }

  /**
   * The Fleet view (ADR 0019): runs not ended (plus those that ended in the last 24 hours with
   * `24h`), newest first, each with the latest task of every agent node in Flow order.
   */
  fleet(window: FleetWindow, resumable: (adapter: string) => boolean, now = Date.now()): FleetView {
    const since = new Date(now - 86_400_000).toISOString();
    const runs = this.listRuns(500).filter((r) => !isTerminalRun(r.status) || (window === "24h" && (r.ended_at ?? r.updated_at) >= since));
    const counts = { running: 0, waiting: 0, failed: 0, done: 0 };
    const nowIso = new Date(now).toISOString();
    const trim = (path: string) => path.replace(/\/+$/, "");
    const projectByPath = new Map(this.listProjects().map((p) => [trim(p.path), p.id]));
    const out = runs.map((run) => {
      const rows = this.db.prepare("SELECT * FROM tasks WHERE run_id = ? AND type = 'agent' ORDER BY rowid").all(run.id) as TaskRow[];
      const latest = new Map<string, TaskRow>();
      for (const row of rows) latest.set(String(row.node_id), row);
      const pending = this.db
        .prepare("SELECT task_id FROM run_messages WHERE run_id = ? AND delivered_at IS NULL")
        .all(run.id) as { task_id: string | null }[];
      const agents = [...latest.values()].map((row): FleetAgent => {
        const task = toTaskView(row);
        const activity = row.last_activity ? (JSON.parse(String(row.last_activity)) as FleetAgent["last_activity"]) : null;
        const fallback = task.error ?? task.summary;
        const team = row.team ? (JSON.parse(String(row.team)) as TeamTaskRef) : null;
        const waiting: FleetAgent["waiting"] =
          task.status === "waiting_approval"
            ? { kind: "approval" }
            : task.status === "blocked" && team?.role === "lead"
              ? { kind: "question" }
            : task.status === "ready" && task.not_before && task.not_before > nowIso
              ? { kind: "quota", until: task.not_before }
              : null;
        if (task.status === "running") counts.running++;
        else if (waiting) counts.waiting++;
        else if (task.status === "failed" || task.status === "blocked") counts.failed++;
        else if (task.status === "succeeded") counts.done++;
        return {
          ...task,
          last_activity: activity ?? (fallback ? { text: firstLine(fallback), ts: task.updated_at } : null),
          waiting,
          resumable: resumable(task.adapter),
          pending_messages: pending.filter((m) => m.task_id === task.id || (m.task_id === null && (!team || team.role === "lead") && !isTerminalTask(task.status))).length,
          team_role: team?.role === "lead" || team?.role === "member" ? team.role : null,
          team_key: team?.key ?? null,
        };
      });
      const flowText = (this.db.prepare("SELECT flow FROM runs WHERE id = ?").get(run.id) as { flow: string | null }).flow;
      const flow = flowText ? (JSON.parse(flowText) as RunFlow) : null;
      return {
        ...run,
        agents,
        team: this.teamOf(run.id, flow),
        progress: flow ? this.progressOf(run, flow) : null,
        project_id: projectByPath.get(trim(run.repo_path)) ?? null,
      };
    });
    return { generated_at: nowIso, counts, runs: out };
  }

  /** Step progress of a Flow run (slice 10), read from its tasks like the Orchestrator reads them. */
  private progressOf(run: RunView, flow: RunFlow): { done: number; total: number } {
    return progress(flow.definition, {
      params: flow.params,
      project: { autonomy_level: run.autonomy_level ?? 0, work_item: run.work_item !== null },
      tasks: this.taskRecordsOfRun(run.id).map((t) => ({ node_id: t.node_id, iteration: t.iteration, status: t.status, outputs: t.outputs })),
      skipped: this.skippedNodes(run.id),
    });
  }

  /** Registered projects (ADR 0021), oldest first; removed ones only with `withRemoved`. */
  listProjects(withRemoved = false): ProjectRecord[] {
    return (this.db.prepare(`SELECT * FROM projects ${withRemoved ? "" : "WHERE removed_at IS NULL"} ORDER BY added_at, rowid`).all() as Row[]).map(toProjectRecord);
  }

  getProject(id: string): ProjectRecord | undefined {
    const row = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as Row | undefined;
    return row ? toProjectRecord(row) : undefined;
  }

  /** Inbox items of active projects, with their runs (newest first). */
  workItems(filter: { projectId?: string; id?: string } = {}): WorkItemRecord[] {
    const rows = this.db
      .prepare(
        `SELECT w.* FROM work_items w JOIN projects p ON p.id = w.project_id
         WHERE p.removed_at IS NULL AND (? IS NULL OR w.project_id = ?) AND (? IS NULL OR w.id = ?) ORDER BY w.updated_at DESC, w.rowid DESC`,
      )
      .all(filter.projectId ?? null, filter.projectId ?? null, filter.id ?? null, filter.id ?? null) as Row[];
    const runsOf = this.db.prepare("SELECT id, status FROM runs WHERE work_item_id = ? ORDER BY created_at DESC, id DESC");
    return rows.map((row) => toWorkItemRecord(row, runsOf.all(String(row.id)) as { id: string; status: RunView["status"] }[]));
  }

  /** Runs whose repository is this path and that have not ended. */
  activeRunsIn(path: string): number {
    const rows = this.db.prepare("SELECT status FROM runs WHERE repo_path = ?").all(path) as { status: RunView["status"] }[];
    return rows.filter((r) => !isTerminalRun(r.status)).length;
  }

  /** Inbox triage spending since `since` (ISO 8601): items triaged or attempted, and dollars. */
  triageUsage(since: string): { items: number; usd: number } {
    const rows = this.db
      .prepare("SELECT type, payload FROM events WHERE type IN ('workitem.triaged', 'workitem.triage_failed') AND ts >= ?")
      .all(since) as { type: string; payload: string }[];
    let usd = 0;
    for (const r of rows) if (r.type === "workitem.triaged") usd += Number((JSON.parse(r.payload) as { cost_usd: number }).cost_usd) || 0;
    return { items: rows.length, usd };
  }

  /**
   * Finished `fix-issue` runs (a PR opened, or done) with their cost and their triage task's
   * summary, newest first: what Inbox estimates are made from.
   */
  finishedIssueRuns(limit = 500): { cost: number; triage: string | null }[] {
    return (
      this.db
        .prepare(
          `SELECT r.cost_total AS cost, (SELECT t.summary FROM tasks t WHERE t.run_id = r.id AND t.node_id = 'triage' ORDER BY t.rowid DESC LIMIT 1) AS triage
           FROM runs r WHERE r.status IN ('pr_opened', 'done') AND r.work_item IS NOT NULL ORDER BY r.created_at DESC LIMIT ?`,
        )
        .all(limit) as { cost: number; triage: string | null }[]
    ).map((r) => ({ cost: Number(r.cost), triage: r.triage ?? null }));
  }

  /**
   * Billed and plan-equivalent cost and tokens of the Cost Ledger since `from` (ISO 8601), for all
   * use, one run, or the runs of one repository path (ADR 0023).
   */
  /** Billed spend recorded so far by one task (ADR 0030). */
  taskSpend(taskId: string): number {
    const row = this.db.prepare("SELECT COALESCE(SUM(cost), 0) AS cost FROM usage WHERE task_id = ? AND billing = 'metered'").get(taskId) as { cost: number };
    return row.cost;
  }

  /** How an adapter's latest recorded use was paid for; undefined before it was used. */
  lastBillingOf(adapter: string): "metered" | "plan" | undefined {
    const row = this.db
      .prepare("SELECT u.billing FROM usage u JOIN tasks t ON t.id = u.task_id WHERE t.adapter = ? ORDER BY u.seq DESC LIMIT 1")
      .get(adapter) as { billing: "metered" | "plan" } | undefined;
    return row?.billing;
  }

  usageTotals(from: string | null, scope: { runId?: string; repoPath?: string } = {}): UsageTotals {
    const where = ["(? IS NULL OR u.ts >= ?)"];
    const args: (string | null)[] = [from, from];
    if (scope.runId) {
      where.push("u.run_id = ?");
      args.push(scope.runId);
    }
    if (scope.repoPath) {
      where.push("u.run_id IN (SELECT id FROM runs WHERE repo_path = ?)");
      args.push(scope.repoPath);
    }
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(CASE WHEN u.billing = 'plan' THEN 0 ELSE u.cost END), 0) AS cost,
                COALESCE(SUM(CASE WHEN u.billing = 'plan' THEN u.cost ELSE 0 END), 0) AS plan_cost,
                COALESCE(SUM(u.tokens_in + u.tokens_out), 0) AS tokens
         FROM usage u WHERE ${where.join(" AND ")}`,
      )
      .get(...args) as { cost: number; plan_cost: number; tokens: number };
    return { cost: Number(row.cost), plan_cost: Number(row.plan_cost), tokens: Number(row.tokens) };
  }

  /** A limit the user set for a project or the global month: `usd: null` removed it; undefined means the config applies. */
  budgetOverride(scope: "project_daily" | "global_monthly", target: string | null): { usd: number | null } | undefined {
    const row = this.db.prepare("SELECT usd FROM budget_overrides WHERE scope = ? AND target = ?").get(scope, target ?? "") as { usd: number | null } | undefined;
    return row ? { usd: row.usd === null ? null : Number(row.usd) } : undefined;
  }

  /** Whether `budget.threshold` was already recorded for this scope, period and ratio. */
  budgetAlerted(scope: string, target: string | null, period: string, ratio: number): boolean {
    return !!this.db.prepare("SELECT 1 FROM budget_alerts WHERE scope = ? AND target = ? AND period = ? AND ratio = ?").get(scope, target ?? "", period, ratio);
  }

  /** Finished agent attempts since `from`, oldest first: the observed metrics' source (ADR 0023). */
  attemptsSince(from: string): AttemptRecord[] {
    return (this.db.prepare("SELECT * FROM attempts WHERE ts >= ? ORDER BY seq").all(from) as Row[]).map((r) => ({
      ts: String(r.ts),
      run_id: String(r.run_id),
      task_id: String(r.task_id),
      profile: String(r.profile),
      adapter: String(r.adapter),
      model: (r.model as string | null) ?? null,
      model_id: (r.model_id as string | null) ?? null,
      status: String(r.status) as AttemptRecord["status"],
      error_kind: (r.error_kind as string | null) ?? null,
      duration_ms: Number(r.duration_ms),
      tokens_in: Number(r.tokens_in),
      tokens_out: Number(r.tokens_out),
      cached_tokens: Number(r.cached_tokens),
      cost: Number(r.cost),
      plan_cost: Number(r.plan_cost),
    }));
  }

  /** The latest observation of every quota window, by adapter (Home, ADR 0021). */
  quotas(now = Date.now()): QuotaView[] {
    const latest = new Map<string, QuotaView>();
    for (const row of this.db.prepare("SELECT ts, payload FROM events WHERE type = 'quota.observed' ORDER BY seq").all() as { ts: string; payload: string }[]) {
      const q = JSON.parse(row.payload) as QuotaObservation;
      const reset = q.resets_at ? Date.parse(q.resets_at) : undefined;
      latest.set(JSON.stringify([q.adapter, q.model_prefix ?? "", q.window]), {
        adapter: q.adapter,
        window: q.window,
        utilization: q.utilization ?? null,
        resets_at: q.resets_at ?? null,
        exhausted: Boolean(q.exhausted) && (reset === undefined || reset > now),
        model_prefix: q.model_prefix ?? null,
        observed_at: row.ts,
      });
    }
    return [...latest.values()].sort((a, b) => a.adapter.localeCompare(b.adapter) || a.window.localeCompare(b.window));
  }

  getArtifact(id: string): { id: string; run_id: string; kind: string; uri: string; summary: string } | undefined {
    const row = this.db.prepare("SELECT id, run_id, kind, uri, summary FROM artifacts WHERE id = ?").get(id) as
      | { id: string; run_id: string; kind: string; uri: string; summary: string }
      | undefined;
    return row ? { ...row } : undefined;
  }
}


export type UsageTotals = { cost: number; plan_cost: number; tokens: number };

export type AttemptRecord = {
  ts: string;
  run_id: string;
  task_id: string;
  profile: string;
  adapter: string;
  model: string | null;
  model_id: string | null;
  status: "succeeded" | "failed" | "needs_input";
  error_kind: string | null;
  duration_ms: number;
  tokens_in: number;
  tokens_out: number;
  cached_tokens: number;
  cost: number;
  plan_cost: number;
};

export type ProjectRecord = {
  id: string;
  name: string;
  repo: string;
  path: string;
  added_at: string;
  removed_at: string | null;
  sync_cursor: string | null;
  synced_at: string | null;
};

export type WorkItemRecord = {
  id: string;
  project_id: string;
  repo: string;
  number: number;
  url: string;
  title: string;
  body: string;
  labels: string[];
  author: string;
  closed: boolean;
  dismissed: boolean;
  version: number;
  triage: WorkItemTriage | null;
  triage_model: string | null;
  /** The version the triage is for; older than `version` when the issue changed since. */
  triage_version: number | null;
  triage_failures: number;
  triaged_at: string | null;
  updated_at: string;
  runs: { id: string; status: RunView["status"] }[];
};

export type RunRecord = RunView & {
  adapter: string;
  profile: string;
  allow_commands: string[];
  setup_commands: string[];
  model: string | null;
  verify: VerifyCommand[];
  protected_paths: string[];
  flow_definition: RunFlow | null;
  routing: "auto" | "pinned";
};
export type TaskRecord = TaskView & {
  sandbox_id: string | null;
  resume_token: string | null;
  rate_limit_waits: number;
  /** Attempts stopped by the user to give an instruction; they do not count toward `max_attempts`. */
  instruction_interrupts: number;
  stage: RunView["status"] | null;
  uses: string | null;
  inputs: Record<string, string>;
  outputs: Record<string, unknown> | null;
  /** Catalog id the Model Router chose; null until routed (or for pinned tasks). */
  model_id: string | null;
  routing: "auto" | null;
  /** The team this task is part of (ADR 0022). */
  team: TeamTaskRef | null;
  /** For team members: the lead's preferred adapter or catalog entry. */
  prefer: string | null;
};

type Row = Record<string, unknown>;
type RunRow = Row & {
  adapter: string;
  profile: string;
  allow_commands: string;
  setup_commands: string;
  model: string | null;
  verify: string;
  protected_paths: string;
  flow: string | null;
  routing: string | null;
};
type TaskRow = Row;

function rowToEvent(row: Row): NavarchEvent {
  return {
    id: String(row.id),
    seq: Number(row.seq),
    ts: String(row.ts),
    type: row.type,
    run_id: (row.run_id as string | null) ?? null,
    task_id: (row.task_id as string | null) ?? null,
    actor: JSON.parse(String(row.actor)),
    payload: JSON.parse(String(row.payload)),
    schema_version: 1,
  } as NavarchEvent;
}

function toApprovalView(row: Row): ApprovalView {
  return {
    id: String(row.id),
    run_id: String(row.run_id),
    task_id: String(row.task_id),
    action: String(row.action),
    resource: String(row.resource),
    reason: String(row.reason),
    summary: String(row.summary),
    status: row.shown as ApprovalStatus,
    decision_reason: (row.decision_reason as string | null) ?? null,
    created_at: String(row.created_at),
    decided_at: (row.decided_at as string | null) ?? null,
  };
}

function toRunView(row: Row): RunView {
  return {
    id: String(row.id),
    name: String(row.name),
    status: row.status as RunView["status"],
    repo_path: String(row.repo_path),
    base_commit: String(row.base_commit),
    prompt: String(row.prompt),
    budget: Number(row.budget),
    cost_total: Number(row.cost_total),
    plan_cost: Number(row.plan_cost ?? 0),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
    ended_at: (row.ended_at as string | null) ?? null,
    work_item: row.work_item ? (JSON.parse(String(row.work_item)) as RunView["work_item"]) : null,
    pr_url: (row.pr_url as string | null) ?? null,
    flow: row.flow ? (JSON.parse(String(row.flow)) as RunFlow).definition.metadata.name : null,
    autonomy_level: row.autonomy_level === null || row.autonomy_level === undefined ? null : Number(row.autonomy_level),
  };
}

function toTaskView(row: Row): TaskView {
  return {
    id: String(row.id),
    run_id: String(row.run_id),
    node_id: String(row.node_id),
    type: String(row.type),
    status: row.status as TaskView["status"],
    attempt: Number(row.attempt),
    max_attempts: Number(row.max_attempts),
    profile: String(row.profile),
    adapter: String(row.adapter),
    model: (row.model as string | null) ?? null,
    sandbox_path: (row.sandbox_path as string | null) ?? null,
    branch: (row.branch as string | null) ?? null,
    cost: Number(row.cost),
    plan_cost: Number(row.plan_cost ?? 0),
    summary: (row.summary as string | null) ?? null,
    error: (row.error as string | null) ?? null,
    not_before: (row.not_before as string | null) ?? null,
    updated_at: String(row.updated_at),
    iteration: Number(row.iteration ?? 1),
  };
}

function toTaskRecord(row: Row): TaskRecord {
  return {
    ...toTaskView(row),
    sandbox_id: (row.sandbox_id as string | null) ?? null,
    resume_token: (row.resume_token as string | null) ?? null,
    rate_limit_waits: Number(row.rate_limit_waits ?? 0),
    instruction_interrupts: Number(row.instruction_interrupts ?? 0),
    stage: (row.stage as RunView["status"] | null) ?? null,
    uses: (row.uses as string | null) ?? null,
    inputs: row.inputs ? (JSON.parse(String(row.inputs)) as Record<string, string>) : {},
    outputs: row.outputs ? (JSON.parse(String(row.outputs)) as Record<string, unknown>) : null,
    model_id: (row.model_id as string | null) ?? null,
    routing: row.routing === "auto" ? "auto" : null,
    team: row.team ? (JSON.parse(String(row.team)) as TeamTaskRef) : null,
    prefer: (row.prefer as string | null) ?? null,
  };
}

function toProjectRecord(row: Row): ProjectRecord {
  return {
    id: String(row.id),
    name: String(row.name),
    repo: String(row.repo),
    path: String(row.path),
    added_at: String(row.added_at),
    removed_at: (row.removed_at as string | null) ?? null,
    sync_cursor: (row.sync_cursor as string | null) ?? null,
    synced_at: (row.synced_at as string | null) ?? null,
  };
}

function toWorkItemRecord(row: Row, runs: WorkItemRecord["runs"]): WorkItemRecord {
  return {
    id: String(row.id),
    project_id: String(row.project_id),
    repo: String(row.repo),
    number: Number(row.number),
    url: String(row.url),
    title: String(row.title),
    body: String(row.body),
    labels: JSON.parse(String(row.labels)) as string[],
    author: String(row.author),
    closed: Number(row.closed) === 1,
    dismissed: Number(row.dismissed) === 1,
    version: Number(row.version),
    triage: row.triage ? (JSON.parse(String(row.triage)) as WorkItemTriage) : null,
    triage_model: (row.triage_model as string | null) ?? null,
    triage_version: row.triage_version === null || row.triage_version === undefined ? null : Number(row.triage_version),
    triage_failures: Number(row.triage_failures),
    triaged_at: (row.triaged_at as string | null) ?? null,
    updated_at: String(row.updated_at),
    runs: runs.map((r) => ({ id: String(r.id), status: r.status })),
  };
}

function toDeviceView(row: Row): DeviceView {
  return {
    id: String(row.id),
    name: String(row.name),
    paired_at: String(row.paired_at),
    last_seen_at: (row.last_seen_at as string | null) ?? null,
    revoked_at: (row.revoked_at as string | null) ?? null,
    push: Number(row.push) === 1,
  };
}

function toRunMessage(row: Row): RunMessage {
  return {
    id: String(row.id),
    run_id: String(row.run_id),
    text: String(row.text),
    task_id: (row.task_id as string | null) ?? null,
    delivery: row.delivery === "now" ? "now" : "next",
    created_at: String(row.created_at),
    delivered: row.delivered_at
      ? { task_id: String(row.delivered_task_id), attempt: Number(row.delivered_attempt), at: String(row.delivered_at) }
      : null,
  };
}

function firstLine(text: string): string {
  return text.split("\n").find((l) => l.trim())?.trim() ?? "";
}
