import type { ApprovalView, RunDetail, RunView, NavarchEvent } from "@navarch/contracts";

const usd = (n: number) => `$${n > 0 && n < 1 ? n.toFixed(4) : n.toFixed(2)}`;
const time = (iso: string) => iso.slice(11, 19);

export function formatRunList(runs: RunView[]): string {
  if (!runs.length) return "no runs yet";
  const rows = runs.map((r) => [r.id, r.status, `${usd(r.cost_total)}/${usd(r.budget)}`, r.created_at.slice(0, 16).replace("T", " "), truncate(runTitle(r), 50)]);
  return table(["RUN", "STATUS", "COST", "CREATED", "PROMPT"], rows);
}

export function formatRunDetail(run: RunDetail): string {
  const lines = [
    `run      ${run.id}`,
    `status   ${run.status}`,
    `repo     ${run.repo_path} @ ${run.base_commit.slice(0, 10)}`,
    `cost     ${usd(run.cost_total)} of ${usd(run.budget)}`,
    ...(run.work_item ? [`issue    ${run.work_item.repo}#${run.work_item.number}  ${run.work_item.url}`] : []),
    ...(run.pr_url ? [`pr       ${run.pr_url}`] : []),
    `prompt   ${truncate(oneLine(run.prompt), 200)}`,
    "",
    "tasks:",
  ];
  for (const t of run.tasks) {
    lines.push(`  ${t.id}  ${t.node_id}  ${t.adapter}  ${t.status}  attempt ${t.attempt}/${t.max_attempts}  ${usd(t.cost)}`);
    if (t.branch) lines.push(`    branch   ${t.branch}`);
    if (t.sandbox_path) lines.push(`    worktree ${t.sandbox_path}`);
    if (t.error) lines.push(`    error    ${truncate(t.error, 300)}`);
    if (t.not_before && t.status === "ready") lines.push(`    waiting  until ${t.not_before} (quota reset)`);
    if (t.summary) lines.push(`    summary  ${truncate(t.summary.replace(/\s+/g, " "), 300)}`);
  }
  if (run.artifacts.length) {
    lines.push("", "artifacts:");
    for (const a of run.artifacts) lines.push(`  ${a.id}  ${a.kind}  ${a.summary}`);
  }
  return lines.join("\n");
}

export function formatEvent(e: NavarchEvent): string {
  const p = e.payload as Record<string, unknown>;
  let detail: string;
  switch (e.type) {
    case "run.status_changed":
    case "task.status_changed":
      detail = `${p.from} → ${p.to}${p.reason ? ` (${truncate(oneLine(String(p.reason)), 200)})` : ""}`;
      break;
    case "task.progress":
      detail = truncate(String(p.message).replace(/\s+/g, " "), 160);
      break;
    case "task.completed":
      detail = `${p.status} in ${Math.round(Number(p.duration_ms) / 1000)}s, ${usd(Number(p.cost))}`;
      break;
    case "model.call.completed":
      detail = `${p.model} in=${p.tokens_in} out=${p.tokens_out} ${usd(Number(p.cost))}`;
      break;
    case "sandbox.created":
      detail = `${p.branch} at ${p.path}${p.reused ? " (reused)" : ""}`;
      break;
    case "sandbox.setup":
      detail = `${p.command} → ${p.exit_code === null ? "timed out" : `exit ${p.exit_code}`} in ${Math.round(Number(p.duration_ms) / 1000)}s`;
      break;
    case "artifact.created":
      detail = `${p.kind} ${p.artifact_id}: ${p.summary}`;
      break;
    case "policy.denied":
      detail = `${p.action}: ${p.reason}`;
      break;
    case "workitem.received":
      detail = `${p.repo}#${p.number} by ${p.author}: ${truncate(oneLine(String(p.title)), 120)}`;
      break;
    case "verification.completed": {
      const checks = (p.checks as unknown[]).length;
      const failures = p.blocking_failures as string[];
      const warnings = p.warnings as string[];
      detail = p.passed ? `passed (${checks} check(s))` : `failed: ${truncate(oneLine(failures.join("; ")), 200)}`;
      if (warnings.length) detail += `; ${warnings.length} warning(s)`;
      break;
    }
    case "approval.requested":
      detail = `${p.approval_id} ${p.action}: ${truncate(oneLine(String(p.summary)), 160)}`;
      break;
    case "approval.decided":
      detail = `${p.approval_id} ${p.decision}${p.reason ? ` (${truncate(oneLine(String(p.reason)), 120)})` : ""}`;
      break;
    case "github.push":
      detail = `${p.branch} @ ${String(p.commit).slice(0, 10)} → ${p.repo}`;
      break;
    case "github.pr.opened":
      detail = `${p.draft ? "draft " : ""}${p.url}`;
      break;
    case "quota.observed":
      detail = `${p.adapter} ${p.window}${p.utilization !== undefined ? ` ${Math.round(Number(p.utilization) * 100)}% used` : ""}${p.exhausted ? " (exhausted)" : ""}${p.resets_at ? `, resets ${p.resets_at}` : ""}`;
      break;
    default:
      detail = "";
  }
  return `${time(e.ts)}  ${e.type.padEnd(20)} ${detail}`;
}

export function formatApprovals(approvals: ApprovalView[]): string {
  if (!approvals.length) return "no pending approvals";
  const lines: string[] = [];
  for (const a of approvals) {
    lines.push(`${a.id}  ${a.action}  run ${a.run_id}  (${a.status})`, `  ${oneLine(a.summary)}`, `  why: ${a.reason}`);
    if (a.status === "pending") lines.push(`  decide: navarch approve ${a.id} | navarch reject ${a.id} [--reason <text>]`);
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

function runTitle(run: RunView): string {
  return run.work_item ? `issue ${run.work_item.repo}#${run.work_item.number}` : promptTitle(run.prompt);
}

/** One line naming the run: an Agent Brief's Summary, else the first non-empty line. */
function promptTitle(prompt: string): string {
  const summary = /^\*\*Summary:\*\*\s*(.+)$/m.exec(prompt)?.[1];
  if (summary) return summary.trim();
  const first = prompt.split("\n").find((l) => l.trim()) ?? "";
  return first.replace(/^#+\s*/, "").trim();
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function table(header: string[], rows: string[][]): string {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join("  ").trimEnd();
  return [line(header), ...rows.map(line)].join("\n");
}
