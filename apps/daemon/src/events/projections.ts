import type { DatabaseSync } from "node:sqlite";
import {
  canTransitionRun,
  canTransitionTask,
  isTerminalRun,
  type RunStatus,
  type TaskStatus,
  type VectrEvent,
} from "@vectr/contracts";

export class ProjectionError extends Error {}

/**
 * Applies one event to the projection tables. Runs inside the same transaction as the event
 * insert, so an invalid transition rejects the event instead of corrupting state.
 */
export function applyEvent(db: DatabaseSync, event: VectrEvent): void {
  const ts = event.ts;
  switch (event.type) {
    case "run.created": {
      const p = (event as VectrEvent<"run.created">).payload;
      db.prepare(
        `INSERT INTO runs (id, status, repo_path, base_commit, prompt, budget, adapter, profile, allow_commands, model, created_at, updated_at)
         VALUES (?, 'created', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        event.run_id,
        p.repo_path,
        p.base_commit,
        p.prompt,
        p.budget,
        p.adapter,
        p.profile,
        JSON.stringify(p.allow_commands),
        p.model ?? null,
        ts,
        ts,
      );
      return;
    }
    case "run.status_changed": {
      const p = (event as VectrEvent<"run.status_changed">).payload;
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
      const p = (event as VectrEvent<"task.created">).payload;
      const run = db.prepare("SELECT profile FROM runs WHERE id = ?").get(event.run_id);
      if (!run) throw new ProjectionError(`unknown run ${event.run_id}`);
      db.prepare(
        `INSERT INTO tasks (id, run_id, node_id, type, status, max_attempts, profile, adapter, updated_at)
         VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
      ).run(event.task_id, event.run_id, p.node_id, p.type, p.max_attempts, p.profile, p.adapter, ts);
      return;
    }
    case "task.status_changed": {
      const p = (event as VectrEvent<"task.status_changed">).payload;
      const row = db.prepare("SELECT status FROM tasks WHERE id = ?").get(event.task_id) as
        | { status: TaskStatus }
        | undefined;
      if (!row) throw new ProjectionError(`unknown task ${event.task_id}`);
      if (row.status !== p.from || !canTransitionTask(p.from, p.to)) {
        throw new ProjectionError(`invalid task transition ${row.status} -> ${p.to} (event says from ${p.from})`);
      }
      db.prepare(
        `UPDATE tasks SET status = ?, attempt = ?, error = ?, not_before = ?,
           rate_limit_waits = rate_limit_waits + ?, updated_at = ? WHERE id = ?`,
      ).run(
        p.to,
        p.attempt,
        p.error ? `${p.error.kind}: ${p.error.message}` : null,
        p.not_before ?? null,
        p.not_before ? 1 : 0,
        ts,
        event.task_id,
      );
      touchRun(db, event.run_id, ts);
      return;
    }
    case "task.resume_token": {
      const p = (event as VectrEvent<"task.resume_token">).payload;
      db.prepare("UPDATE tasks SET resume_token = ?, updated_at = ? WHERE id = ?").run(p.token, ts, event.task_id);
      return;
    }
    case "sandbox.created": {
      const p = (event as VectrEvent<"sandbox.created">).payload;
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
      const p = (event as VectrEvent<"task.completed">).payload;
      db.prepare("UPDATE tasks SET summary = ?, updated_at = ? WHERE id = ?").run(p.summary, ts, event.task_id);
      return;
    }
    case "model.call.completed": {
      const p = (event as VectrEvent<"model.call.completed">).payload;
      db.prepare("UPDATE tasks SET cost = cost + ? WHERE id = ?").run(p.cost, event.task_id);
      db.prepare("UPDATE runs SET cost_total = cost_total + ?, updated_at = ? WHERE id = ?").run(
        p.cost,
        ts,
        event.run_id,
      );
      return;
    }
    case "artifact.created": {
      const p = (event as VectrEvent<"artifact.created">).payload;
      db.prepare(
        "INSERT INTO artifacts (id, run_id, task_id, kind, uri, sha256, summary, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(p.artifact_id, event.run_id, event.task_id, p.kind, p.uri, p.sha256, p.summary, ts);
      return;
    }
    case "task.progress":
    case "run.message":
    case "policy.denied":
    case "quota.observed":
      return;
  }
}

function touchRun(db: DatabaseSync, runId: string | null, ts: string): void {
  if (runId) db.prepare("UPDATE runs SET updated_at = ? WHERE id = ?").run(ts, runId);
}
