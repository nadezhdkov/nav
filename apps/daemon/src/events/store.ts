import { DatabaseSync } from "node:sqlite";
import {
  newId,
  parsePayload,
  type ApprovalStatus,
  type RunFlow,
  type ApprovalView,
  type NewEvent,
  type RunDetail,
  type RunView,
  type TaskView,
  type NavarchEvent,
  type QuotaObservation,
  type VerifyCommand,
} from "@navarch/contracts";
import { applyEvent } from "./projections.ts";
import { dropProjections, eventsTable, projectionTables } from "./schema.ts";

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
    // Projections are derived data: when a column was added, rebuild them from the log.
    const has = (table: string, column: string) =>
      (this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === column);
    if (!has("tasks", "not_before") || !has("runs", "protected_paths") || !has("tasks", "outputs") || !has("runs", "autonomy_level") || !has("tasks", "model_id")) {
      this.rebuildProjections();
    }
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
    return {
      ...run,
      flow_definition: flow ? (JSON.parse(flow) as RunFlow) : null,
      tasks: this.tasksOfRun(id),
      artifacts: artifacts.map((a) => ({ ...a })),
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

  /** True when a human approved this task's pending side effect. */
  taskApproved(taskId: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM approvals WHERE task_id = ? AND status = 'approved'").get(taskId));
  }

  getArtifact(id: string): { id: string; run_id: string; kind: string; uri: string; summary: string } | undefined {
    const row = this.db.prepare("SELECT id, run_id, kind, uri, summary FROM artifacts WHERE id = ?").get(id) as
      | { id: string; run_id: string; kind: string; uri: string; summary: string }
      | undefined;
    return row ? { ...row } : undefined;
  }
}


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
  stage: RunView["status"] | null;
  uses: string | null;
  inputs: Record<string, string>;
  outputs: Record<string, unknown> | null;
  /** Catalog id the Model Router chose; null until routed (or for pinned tasks). */
  model_id: string | null;
  routing: "auto" | null;
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
    status: row.status as RunView["status"],
    repo_path: String(row.repo_path),
    base_commit: String(row.base_commit),
    prompt: String(row.prompt),
    budget: Number(row.budget),
    cost_total: Number(row.cost_total),
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
    stage: (row.stage as RunView["status"] | null) ?? null,
    uses: (row.uses as string | null) ?? null,
    inputs: row.inputs ? (JSON.parse(String(row.inputs)) as Record<string, string>) : {},
    outputs: row.outputs ? (JSON.parse(String(row.outputs)) as Record<string, unknown>) : null,
    model_id: (row.model_id as string | null) ?? null,
    routing: row.routing === "auto" ? "auto" : null,
  };
}
