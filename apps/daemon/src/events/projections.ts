import type { DatabaseSync } from "node:sqlite";
import {
  canTransitionRun,
  canTransitionTask,
  INSTRUCTION_INTERRUPT,
  PAUSE_INTERRUPT,
  isTerminalRun,
  type RunStatus,
  type TaskStatus,
  type NavarchEvent,
} from "@navarch/contracts";

export class ProjectionError extends Error {}

/**
 * Applies one event to the projection tables. Runs inside the same transaction as the event
 * insert, so an invalid transition rejects the event instead of corrupting state.
 */
export function applyEvent(db: DatabaseSync, event: NavarchEvent): void {
  const ts = event.ts;
  switch (event.type) {
    case "run.created": {
      const p = (event as NavarchEvent<"run.created">).payload;
      db.prepare(
        `INSERT INTO runs (id, status, repo_path, base_commit, prompt, budget, adapter, profile, allow_commands, setup_commands, model, work_item, verify, protected_paths, flow, autonomy_level, routing, created_at, updated_at)
         VALUES (?, 'created', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        event.run_id,
        p.repo_path,
        p.base_commit,
        p.prompt,
        p.budget,
        p.adapter,
        p.profile,
        JSON.stringify(p.allow_commands),
        JSON.stringify(p.setup_commands ?? []),
        p.model ?? null,
        p.work_item ? JSON.stringify(p.work_item) : null,
        JSON.stringify(p.verify ?? []),
        JSON.stringify(p.protected_paths ?? []),
        p.flow ? JSON.stringify(p.flow) : null,
        p.autonomy_level ?? null,
        p.routing ?? null,
        ts,
        ts,
      );
      return;
    }
    case "run.status_changed": {
      const p = (event as NavarchEvent<"run.status_changed">).payload;
      const row = db.prepare("SELECT status FROM runs WHERE id = ?").get(event.run_id) as
        | { status: RunStatus }
        | undefined;
      if (!row) throw new ProjectionError(`unknown run ${event.run_id}`);
      if (row.status !== p.from || !canTransitionRun(p.from, p.to)) {
        throw new ProjectionError(`invalid run transition ${row.status} -> ${p.to} (event says from ${p.from})`);
      }
      db.prepare("UPDATE runs SET status = ?, updated_at = ?, ended_at = ? WHERE id = ?").run(
        p.to,
        ts,
        isTerminalRun(p.to) ? ts : null,
        event.run_id,
      );
      return;
    }
    case "task.created": {
      const p = (event as NavarchEvent<"task.created">).payload;
      const run = db.prepare("SELECT adapter, model FROM runs WHERE id = ?").get(event.run_id) as
        | { adapter: string; model: string | null }
        | undefined;
      if (!run) throw new ProjectionError(`unknown run ${event.run_id}`);
      // The run's model belongs to the run's adapter; a routed task gets its own with model.routed.
      const model = p.type === "agent" && p.adapter === run.adapter ? run.model : null;
      db.prepare(
        `INSERT INTO tasks (id, run_id, node_id, type, status, max_attempts, profile, adapter, model, routing, iteration, stage, uses, inputs, updated_at)
         VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        event.task_id,
        event.run_id,
        p.node_id,
        p.type,
        p.max_attempts,
        p.profile,
        p.adapter,
        model,
        p.routing ?? null,
        p.iteration ?? 1,
        p.stage ?? null,
        p.uses ?? null,
        p.inputs ? JSON.stringify(p.inputs) : null,
        ts,
      );
      return;
    }
    case "task.status_changed": {
      const p = (event as NavarchEvent<"task.status_changed">).payload;
      const row = db.prepare("SELECT status FROM tasks WHERE id = ?").get(event.task_id) as
        | { status: TaskStatus }
        | undefined;
      if (!row) throw new ProjectionError(`unknown task ${event.task_id}`);
      if (row.status !== p.from || !canTransitionTask(p.from, p.to)) {
        throw new ProjectionError(`invalid task transition ${row.status} -> ${p.to} (event says from ${p.from})`);
      }
      db.prepare(
        `UPDATE tasks SET status = ?, attempt = ?, error = ?, not_before = ?,
           rate_limit_waits = rate_limit_waits + ?, instruction_interrupts = instruction_interrupts + ?, updated_at = ? WHERE id = ?`,
      ).run(
        p.to,
        p.attempt,
        p.error ? `${p.error.kind}: ${p.error.message}` : null,
        p.not_before ?? null,
        p.not_before ? 1 : 0,
        p.from === "interrupted" && p.to === "ready" && (p.reason === INSTRUCTION_INTERRUPT || p.reason === PAUSE_INTERRUPT) ? 1 : 0,
        ts,
        event.task_id,
      );
      touchRun(db, event.run_id, ts);
      return;
    }
    case "task.resume_token": {
      const p = (event as NavarchEvent<"task.resume_token">).payload;
      db.prepare("UPDATE tasks SET resume_token = ?, updated_at = ? WHERE id = ?").run(p.token, ts, event.task_id);
      return;
    }
    case "model.routed": {
      const p = (event as NavarchEvent<"model.routed">).payload;
      db.prepare("UPDATE tasks SET adapter = ?, model = ?, model_id = ?, resume_token = NULL, updated_at = ? WHERE id = ?").run(
        p.adapter,
        p.model ?? null,
        p.model_id,
        ts,
        event.task_id,
      );
      return;
    }
    case "sandbox.created": {
      const p = (event as NavarchEvent<"sandbox.created">).payload;
      db.prepare("UPDATE tasks SET sandbox_id = ?, sandbox_path = ?, branch = ?, updated_at = ? WHERE id = ?").run(
        p.sandbox_id,
        p.path,
        p.branch,
        ts,
        event.task_id,
      );
      return;
    }
    case "task.completed": {
      const p = (event as NavarchEvent<"task.completed">).payload;
      db.prepare("UPDATE tasks SET summary = ?, outputs = ?, updated_at = ? WHERE id = ?").run(
        p.summary,
        p.outputs ? JSON.stringify(p.outputs) : null,
        ts,
        event.task_id,
      );
      return;
    }
    case "model.call.completed": {
      const p = (event as NavarchEvent<"model.call.completed">).payload;
      db.prepare("UPDATE tasks SET cost = cost + ? WHERE id = ?").run(p.cost, event.task_id);
      db.prepare("UPDATE runs SET cost_total = cost_total + ?, updated_at = ? WHERE id = ?").run(
        p.cost,
        ts,
        event.run_id,
      );
      return;
    }
    case "artifact.created": {
      const p = (event as NavarchEvent<"artifact.created">).payload;
      db.prepare(
        "INSERT INTO artifacts (id, run_id, task_id, kind, uri, sha256, summary, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(p.artifact_id, event.run_id, event.task_id, p.kind, p.uri, p.sha256, p.summary, ts);
      return;
    }
    case "approval.requested": {
      const p = (event as NavarchEvent<"approval.requested">).payload;
      db.prepare(
        `INSERT INTO approvals (id, run_id, task_id, action, resource, reason, summary, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      ).run(p.approval_id, event.run_id, event.task_id, p.action, p.resource, p.reason, p.summary, ts);
      return;
    }
    case "approval.decided": {
      const p = (event as NavarchEvent<"approval.decided">).payload;
      const row = db.prepare("SELECT status FROM approvals WHERE id = ?").get(p.approval_id) as { status: string } | undefined;
      if (!row) throw new ProjectionError(`unknown approval ${p.approval_id}`);
      if (row.status !== "pending") throw new ProjectionError(`approval ${p.approval_id} is already ${row.status}`);
      db.prepare("UPDATE approvals SET status = ?, decision_reason = ?, decided_at = ? WHERE id = ?").run(
        p.decision,
        p.reason ?? null,
        ts,
        p.approval_id,
      );
      return;
    }
    case "github.pr.opened": {
      const p = (event as NavarchEvent<"github.pr.opened">).payload;
      db.prepare("UPDATE runs SET pr_url = ?, updated_at = ? WHERE id = ?").run(p.url, ts, event.run_id);
      return;
    }
    case "flow.node.skipped": {
      const p = (event as NavarchEvent<"flow.node.skipped">).payload;
      db.prepare("INSERT OR REPLACE INTO skipped_nodes (run_id, node_id, reason) VALUES (?, ?, ?)").run(event.run_id, p.node_id, p.reason);
      return;
    }
    case "task.progress": {
      const p = (event as NavarchEvent<"task.progress">).payload;
      const activity = JSON.stringify({ text: p.message, ...(p.tool ? { tool: p.tool } : {}), ts });
      db.prepare("UPDATE tasks SET last_activity = ? WHERE id = ?").run(activity, event.task_id);
      return;
    }
    case "run.message": {
      const p = (event as NavarchEvent<"run.message">).payload;
      db.prepare("INSERT INTO run_messages (id, run_id, task_id, text, delivery, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
        p.message_id,
        event.run_id,
        p.task_id ?? null,
        p.text,
        p.delivery,
        ts,
      );
      touchRun(db, event.run_id, ts);
      return;
    }
    case "run.message.delivered": {
      const p = (event as NavarchEvent<"run.message.delivered">).payload;
      const res = db
        .prepare("UPDATE run_messages SET delivered_task_id = ?, delivered_attempt = ?, delivered_at = ? WHERE id = ? AND delivered_at IS NULL")
        .run(p.task_id, p.attempt, ts, p.message_id);
      if (res.changes !== 1) throw new ProjectionError(`message ${p.message_id} is unknown or already delivered`);
      return;
    }
    case "device.paired": {
      const p = (event as NavarchEvent<"device.paired">).payload;
      db.prepare("INSERT INTO devices (id, name, paired_at) VALUES (?, ?, ?)").run(p.device_id, p.name, ts);
      return;
    }
    case "device.revoked": {
      const p = (event as NavarchEvent<"device.revoked">).payload;
      db.prepare("UPDATE devices SET revoked_at = COALESCE(revoked_at, ?), revoke_reason = COALESCE(revoke_reason, ?), push = 0 WHERE id = ?").run(ts, p.reason, p.device_id);
      return;
    }
    case "device.push_changed": {
      const p = (event as NavarchEvent<"device.push_changed">).payload;
      db.prepare("UPDATE devices SET push = ? WHERE id = ?").run(p.enabled ? 1 : 0, p.device_id);
      return;
    }
    case "workitem.received":
    case "verification.completed":
    case "github.push":
    case "policy.denied":
    case "quota.observed":
    case "concierge.message":
    case "concierge.action.proposed":
    case "concierge.action.decided":
    case "fleet.stopped":
    case "notification.sent":
    case "notification.failed":
      return;
  }
}

function touchRun(db: DatabaseSync, runId: string | null, ts: string): void {
  if (runId) db.prepare("UPDATE runs SET updated_at = ? WHERE id = ?").run(ts, runId);
}
