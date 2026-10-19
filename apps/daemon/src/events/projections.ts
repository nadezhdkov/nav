import type { DatabaseSync } from "node:sqlite";
import { codename } from "../orchestrator/names.ts";
import {
  canTransitionRun,
  canTransitionTask,
  INSTRUCTION_INTERRUPT,
  PAUSE_INTERRUPT,
  isTerminalRun,
  type RunStatus,
  type TaskStatus,
  type NavarchEvent,
  workItemId,
} from "@navarch/contracts";

export class ProjectionError extends Error {}

type UsageRow = { model: string; billing: string; tokens_in: number; tokens_out: number; cached_tokens: number; cost: number };

/** An agent attempt ended: its usage is what the task recorded since its previous attempt ended. */
function insertAttempt(db: DatabaseSync, event: NavarchEvent, p: NavarchEvent<"task.completed">["payload"]): void {
  const task = db.prepare("SELECT type, profile, adapter, model, model_id FROM tasks WHERE id = ?").get(event.task_id) as
    | { type: string; profile: string; adapter: string; model: string | null; model_id: string | null }
    | undefined;
  if (!task || task.type !== "agent" || !event.run_id || !event.task_id) return;
  const previous = db.prepare("SELECT MAX(seq) AS seq FROM attempts WHERE task_id = ?").get(event.task_id) as { seq: number | null };
  const u = db
    .prepare(
      `SELECT COALESCE(SUM(tokens_in), 0) AS tokens_in, COALESCE(SUM(tokens_out), 0) AS tokens_out, COALESCE(SUM(cached_tokens), 0) AS cached_tokens,
              COALESCE(SUM(CASE WHEN billing = 'plan' THEN 0 ELSE cost END), 0) AS cost, COALESCE(SUM(CASE WHEN billing = 'plan' THEN cost ELSE 0 END), 0) AS plan_cost
       FROM usage WHERE task_id = ? AND seq > ?`,
    )
    .get(event.task_id, previous.seq ?? 0) as { tokens_in: number; tokens_out: number; cached_tokens: number; cost: number; plan_cost: number };
  db.prepare(
    `INSERT INTO attempts (seq, ts, run_id, task_id, profile, adapter, model, model_id, status, error_kind, duration_ms, tokens_in, tokens_out, cached_tokens, cost, plan_cost)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    event.seq,
    event.ts,
    event.run_id,
    event.task_id,
    task.profile,
    task.adapter,
    task.model,
    task.model_id,
    p.status,
    p.error?.kind ?? null,
    p.duration_ms,
    u.tokens_in,
    u.tokens_out,
    u.cached_tokens,
    u.cost,
    u.plan_cost,
  );
}

function insertUsage(db: DatabaseSync, event: NavarchEvent, u: UsageRow): void {
  db.prepare(
    "INSERT INTO usage (seq, ts, run_id, task_id, model, billing, tokens_in, tokens_out, cached_tokens, cost) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(event.seq, event.ts, event.run_id, event.task_id, u.model, u.billing, u.tokens_in, u.tokens_out, u.cached_tokens, u.cost);
}

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
        `INSERT INTO runs (id, name, status, repo_path, base_commit, prompt, budget, adapter, profile, allow_commands, setup_commands, model, work_item, verify, protected_paths, isolation, flow, autonomy_level, routing, work_item_id, created_at, updated_at)
         VALUES (?, ?, 'created', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        event.run_id,
        p.name ?? codename(event.run_id!),
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
        p.isolation ? JSON.stringify(p.isolation) : null,
        p.flow ? JSON.stringify(p.flow) : null,
        p.autonomy_level ?? null,
        p.routing ?? null,
        p.work_item ? workItemId(p.work_item.repo, p.work_item.number) : null,
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
        `INSERT INTO tasks (id, run_id, node_id, type, status, max_attempts, profile, adapter, model, routing, iteration, stage, uses, inputs, team, prefer, compete, parallel, choices, updated_at)
         VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        p.team ? JSON.stringify(p.team) : null,
        p.prefer ?? null,
        p.compete ? JSON.stringify(p.compete) : null,
        p.parallel ? JSON.stringify(p.parallel) : null,
        p.choices ? JSON.stringify(p.choices) : null,
        ts,
      );
      return;
    }
    case "task.subagent": {
      const p = (event as NavarchEvent<"task.subagent">).payload;
      const row = db.prepare("SELECT subagents FROM tasks WHERE id = ?").get(event.task_id) as { subagents: string | null } | undefined;
      if (!row) return;
      const list = (row.subagents ? JSON.parse(row.subagents) : []) as { tool_use_id: string; description: string; status: string }[];
      const found = list.find((x) => x.tool_use_id === p.tool_use_id);
      if (found) found.status = p.status;
      else list.push({ ...p });
      db.prepare("UPDATE tasks SET subagents = ? WHERE id = ?").run(JSON.stringify(list), event.task_id);
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
      insertAttempt(db, event, p);
      return;
    }
    case "model.call.completed": {
      const p = (event as NavarchEvent<"model.call.completed">).payload;
      // Budgets count billed use only; plan use keeps its API-equivalent figure apart (ADR 0023).
      const billing = p.billing ?? "metered";
      const taskColumn = billing === "plan" ? "plan_cost" : "cost";
      const runColumn = billing === "plan" ? "plan_cost" : "cost_total";
      db.prepare(`UPDATE tasks SET ${taskColumn} = ${taskColumn} + ? WHERE id = ?`).run(p.cost, event.task_id);
      db.prepare(`UPDATE runs SET ${runColumn} = ${runColumn} + ?, updated_at = ? WHERE id = ?`).run(
        p.cost,
        ts,
        event.run_id,
      );
      insertUsage(db, event, { model: p.model, billing, tokens_in: p.tokens_in, tokens_out: p.tokens_out, cached_tokens: p.cached_tokens, cost: p.cost });
      return;
    }
    case "budget.set": {
      const p = (event as NavarchEvent<"budget.set">).payload;
      if (p.scope === "run") {
        db.prepare("UPDATE runs SET budget = ?, updated_at = ? WHERE id = ?").run(p.usd, ts, p.target);
        return;
      }
      db.prepare(
        "INSERT INTO budget_overrides (scope, target, usd, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (scope, target) DO UPDATE SET usd = excluded.usd, updated_at = excluded.updated_at",
      ).run(p.scope, p.target ?? "", p.usd, ts);
      return;
    }
    case "flow.draft.saved": {
      const p = (event as NavarchEvent<"flow.draft.saved">).payload;
      db.prepare(
        `INSERT INTO studio_flows (name, draft_yaml, draft_revision, draft_saved_at, based_on, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (name) DO UPDATE SET draft_yaml = excluded.draft_yaml, draft_revision = excluded.draft_revision, draft_saved_at = excluded.draft_saved_at, based_on = excluded.based_on, updated_at = excluded.updated_at`,
      ).run(p.name, p.yaml, p.revision, ts, p.based_on, ts);
      return;
    }
    case "flow.draft.discarded": {
      const p = (event as NavarchEvent<"flow.draft.discarded">).payload;
      db.prepare("UPDATE studio_flows SET draft_yaml = NULL, draft_revision = NULL, draft_saved_at = NULL, based_on = NULL, updated_at = ? WHERE name = ?").run(ts, p.name);
      // A Flow that was never published is gone with its draft.
      db.prepare("DELETE FROM studio_flows WHERE name = ? AND published_version IS NULL").run(p.name);
      return;
    }
    case "flow.published": {
      const p = (event as NavarchEvent<"flow.published">).payload;
      db.prepare("INSERT INTO flow_versions (name, version, yaml, sha256, actor, published_at) VALUES (?, ?, ?, ?, ?, ?)").run(p.name, p.version, p.yaml, p.sha256, actorLabel(event.actor), ts);
      db.prepare("UPDATE studio_flows SET draft_yaml = NULL, draft_revision = NULL, draft_saved_at = NULL, based_on = NULL, published_version = ?, updated_at = ? WHERE name = ?").run(p.version, ts, p.name);
      return;
    }
    case "budget.threshold": {
      const p = (event as NavarchEvent<"budget.threshold">).payload;
      db.prepare("INSERT OR IGNORE INTO budget_alerts (scope, target, period, ratio) VALUES (?, ?, ?, ?)").run(p.scope, p.target ?? "", p.period, p.ratio);
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
        `INSERT INTO approvals (id, run_id, task_id, action, resource, reason, summary, status, choices, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      ).run(p.approval_id, event.run_id, event.task_id, p.action, p.resource, p.reason, p.summary, p.choices ? JSON.stringify(p.choices) : null, ts);
      return;
    }
    case "approval.decided": {
      const p = (event as NavarchEvent<"approval.decided">).payload;
      const row = db.prepare("SELECT status FROM approvals WHERE id = ?").get(p.approval_id) as { status: string } | undefined;
      if (!row) throw new ProjectionError(`unknown approval ${p.approval_id}`);
      if (row.status !== "pending") throw new ProjectionError(`approval ${p.approval_id} is already ${row.status}`);
      db.prepare("UPDATE approvals SET status = ?, decision_reason = ?, choice = ?, decided_at = ? WHERE id = ?").run(
        p.decision,
        p.reason ?? null,
        p.choice ?? null,
        ts,
        p.approval_id,
      );
      return;
    }
    case "github.pr.opened": {
      const p = (event as NavarchEvent<"github.pr.opened">).payload;
      db.prepare("UPDATE runs SET pr_url = ?, updated_at = ? WHERE id = ?").run(p.url, ts, event.run_id);
      // Navarch's last push to the branch, which the PR's outcome is compared with (ADR 0037).
      const push = db
        .prepare("SELECT payload FROM events WHERE type = 'github.push' AND run_id = ? AND seq < ? ORDER BY seq DESC LIMIT 1")
        .get(event.run_id, event.seq) as { payload: string } | undefined;
      const commit = push ? (JSON.parse(push.payload) as { commit: string }).commit : null;
      db.prepare(
        "INSERT OR IGNORE INTO pull_requests (repo, number, run_id, url, branch, commit_sha, opened_at, state) VALUES (?, ?, ?, ?, ?, ?, ?, 'open')",
      ).run(p.repo, p.number, event.run_id, p.url, p.branch, commit, ts);
      return;
    }
    case "github.push": {
      const p = (event as NavarchEvent<"github.push">).payload;
      db.prepare("UPDATE pull_requests SET commit_sha = ? WHERE repo = ? AND branch = ? AND state = 'open'").run(p.commit, p.repo, p.branch);
      return;
    }
    case "github.pr.lost": {
      const p = (event as NavarchEvent<"github.pr.lost">).payload;
      db.prepare("UPDATE pull_requests SET state = 'gone', closed_at = ? WHERE repo = ? AND number = ?").run(ts, p.repo, p.number);
      return;
    }
    case "github.pr.closed": {
      const p = (event as NavarchEvent<"github.pr.closed">).payload;
      db.prepare("UPDATE pull_requests SET state = ?, closed_at = ?, commits_after = ? WHERE repo = ? AND number = ?").run(
        p.merged ? "merged" : "closed",
        p.closed_at,
        p.commits_after,
        p.repo,
        p.number,
      );
      return;
    }
    case "ci.failure.detected": {
      const p = (event as NavarchEvent<"ci.failure.detected">).payload;
      // A newer head of the same pull request makes the earlier failure moot.
      db.prepare("UPDATE ci_failures SET status = 'resolved', resolved_reason = 'moved' WHERE repo = ? AND number = ? AND status = 'open' AND head_sha != ?").run(p.repo, p.number, p.head_sha);
      db.prepare(
        "INSERT OR IGNORE INTO ci_failures (id, project_id, repo, number, title, author, url, head_ref, head_sha, checks, status, detected_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)",
      ).run(p.failure_id, p.project_id, p.repo, p.number, p.title, p.author, p.url, p.head_ref, p.head_sha, JSON.stringify(p.checks), ts);
      return;
    }
    case "ci.failure.resolved": {
      const p = (event as NavarchEvent<"ci.failure.resolved">).payload;
      db.prepare("UPDATE ci_failures SET status = 'resolved', resolved_reason = ? WHERE id = ? AND status = 'open'").run(p.reason, p.failure_id);
      return;
    }
    case "ci.failure.started": {
      const p = (event as NavarchEvent<"ci.failure.started">).payload;
      db.prepare("UPDATE ci_failures SET status = 'started', run_id = ?, auto = ?, started_at = ? WHERE id = ?").run(p.run_id, p.auto ? 1 : 0, ts, p.failure_id);
      return;
    }
    case "ci.failure.dismissed": {
      const p = (event as NavarchEvent<"ci.failure.dismissed">).payload;
      db.prepare("UPDATE ci_failures SET status = 'dismissed' WHERE id = ? AND status = 'open'").run(p.failure_id);
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
    case "project.added": {
      const p = (event as NavarchEvent<"project.added">).payload;
      db.prepare("INSERT INTO projects (id, name, repo, path, added_at) VALUES (?, ?, ?, ?, ?)").run(p.project_id, p.name, p.repo, p.path, ts);
      return;
    }
    case "project.removed": {
      const p = (event as NavarchEvent<"project.removed">).payload;
      db.prepare("UPDATE projects SET removed_at = COALESCE(removed_at, ?) WHERE id = ?").run(ts, p.project_id);
      return;
    }
    case "principle.added": {
      const p = (event as NavarchEvent<"principle.added">).payload;
      db.prepare("INSERT OR IGNORE INTO principles (id, project_id, text, run_id, added_at) VALUES (?, ?, ?, ?, ?)").run(p.principle_id, p.project_id, p.text, p.run_id, ts);
      return;
    }
    case "principle.proposed": {
      const p = (event as NavarchEvent<"principle.proposed">).payload;
      db.prepare("INSERT OR IGNORE INTO principle_proposals (id, project_id, text, reason, run_id, task_id, status, proposed_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)").run(p.proposal_id, p.project_id, p.text, p.reason, p.run_id, p.task_id, ts);
      break;
    }
    case "principle.proposal.decided": {
      const p = (event as NavarchEvent<"principle.proposal.decided">).payload;
      db.prepare("UPDATE principle_proposals SET status = ?, decided_at = ? WHERE id = ? AND project_id = ? AND status = 'pending'").run(p.decision, ts, p.proposal_id, p.project_id);
      break;
    }
    case "principle.removed": {
      const p = (event as NavarchEvent<"principle.removed">).payload;
      db.prepare("UPDATE principles SET removed_at = COALESCE(removed_at, ?) WHERE id = ? AND project_id = ?").run(ts, p.principle_id, p.project_id);
      return;
    }
    case "inbox.synced": {
      const p = (event as NavarchEvent<"inbox.synced">).payload;
      db.prepare("UPDATE projects SET synced_at = ?, sync_cursor = COALESCE(?, sync_cursor) WHERE id = ?").run(ts, p.cursor ?? null, p.project_id);
      return;
    }
    case "workitem.received": {
      // Runs read their issue too; only a project's sync puts it in the Inbox (ADR 0021).
      const p = (event as NavarchEvent<"workitem.received">).payload;
      if (!p.project_id) return;
      const id = workItemId(p.repo, p.number);
      db.prepare(
        `INSERT INTO work_items (id, project_id, repo, number, url, title, body, labels, author, received_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET project_id = excluded.project_id, url = excluded.url, title = excluded.title, body = excluded.body,
           labels = excluded.labels, author = excluded.author, closed = 0, version = version + 1, triage_failures = 0, updated_at = excluded.updated_at`,
      ).run(id, p.project_id, p.repo, p.number, p.url, p.title, p.body, JSON.stringify(p.labels), p.author, ts, ts);
      return;
    }
    case "workitem.closed": {
      const p = (event as NavarchEvent<"workitem.closed">).payload;
      db.prepare("UPDATE work_items SET closed = 1, updated_at = ? WHERE id = ?").run(ts, p.item_id);
      return;
    }
    case "workitem.triaged": {
      const p = (event as NavarchEvent<"workitem.triaged">).payload;
      // Inbox triage runs on an API model outside any run: billed, counted in the global month.
      insertUsage(db, event, { model: p.model, billing: "metered", tokens_in: 0, tokens_out: 0, cached_tokens: 0, cost: p.cost_usd });
      db.prepare("UPDATE work_items SET triage = ?, triage_model = ?, triage_version = version, triage_failures = 0, triaged_at = ? WHERE id = ?").run(
        JSON.stringify(p.triage),
        p.model,
        ts,
        p.item_id,
      );
      return;
    }
    case "workitem.triage_failed": {
      const p = (event as NavarchEvent<"workitem.triage_failed">).payload;
      db.prepare("UPDATE work_items SET triage_failures = triage_failures + 1 WHERE id = ?").run(p.item_id);
      return;
    }
    case "workitem.dismissed":
    case "workitem.restored": {
      const p = (event as NavarchEvent<"workitem.dismissed">).payload;
      db.prepare("UPDATE work_items SET dismissed = ?, updated_at = ? WHERE id = ?").run(event.type === "workitem.dismissed" ? 1 : 0, ts, p.item_id);
      return;
    }
    case "verification.completed":
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

/** Who did something, in a few words, for views that show it. */
function actorLabel(actor: NavarchEvent["actor"]): string {
  return actor.kind === "user" ? `user via ${actor.via}` : actor.kind === "system" ? actor.component : actor.kind;
}
