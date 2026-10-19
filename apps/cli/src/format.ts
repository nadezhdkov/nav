import type { CodeSymbol, RepoMap, SearchHit, ApprovalView, AwayView, BudgetView, CiFailureView, MorningSummary, AuditVerifyView, RunAudit, DeviceView, FlowProblem, FlowSummary, GitHubRepoView, InboxView, KnowledgePanel, MetricsView, ProjectSyncResult, ProjectView, RemoteStatus, RunDetail, RunView, NavarchEvent, SpecRunView, UsageView, PrinciplesView, TraceabilityView, AutoMergeStatus } from "@navarch/contracts";

const usd = (n: number) => `$${n > 0 && n < 1 ? n.toFixed(4) : n.toFixed(2)}`;
const time = (iso: string) => iso.slice(11, 19);

export function formatRunList(runs: RunView[]): string {
  if (!runs.length) return "no runs yet";
  const rows = runs.map((r) => [r.name, r.id, r.status, `${usd(r.cost_total)}/${usd(r.budget)}`, r.created_at.slice(0, 16).replace("T", " "), truncate(runTitle(r), 50)]);
  return table(["NAME", "RUN", "STATUS", "COST", "CREATED", "PROMPT"], rows);
}

export function formatRunDetail(run: RunDetail): string {
  const lines = [
    `run      ${run.name} (${run.id})`,
    `status   ${run.status}`,
    `repo     ${run.repo_path} @ ${run.base_commit.slice(0, 10)}`,
    `cost     ${usd(run.cost_total)} of ${usd(run.budget)}${run.plan_cost > 0 ? ` (plus ${usd(run.plan_cost)} plan-equivalent, not billed)` : ""}`,
    ...(run.flow
      ? [`flow     ${run.flow}${run.flow_definition?.version ? ` v${run.flow_definition.version} (Flow Studio)` : ""}${run.autonomy_level !== null ? ` (autonomy level ${run.autonomy_level})` : ""}`]
      : []),
    ...(run.work_item ? [`issue    ${run.work_item.repo}#${run.work_item.number}  ${run.work_item.url}`] : []),
    ...(run.pr_url ? [`pr       ${run.pr_url}`] : []),
    `prompt   ${truncate(oneLine(run.prompt), 200)}`,
    "",
    "tasks:",
  ];
  for (const t of run.tasks) {
    const node = t.iteration > 1 ? `${t.node_id}#${t.iteration}` : t.node_id;
    lines.push(`  ${t.id}  ${node}  ${t.adapter}${t.model ? `/${t.model}` : ""}  ${t.status}  attempt ${t.attempt}/${t.max_attempts}  ${usd(t.cost)}`);
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
      const sandbox = p.sandbox as { image: string } | undefined;
      if (sandbox) detail += ` in container ${sandbox.image}`;
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
    case "github.pr.closed":
      detail = `${p.repo}#${p.number} ${p.merged ? "merged" : "closed without merging"}${p.commits_after === null ? "" : `, ${p.commits_after} commit(s) after Navarch's`}`;
      break;
    case "github.pr.lost":
      detail = `${p.repo}#${p.number} no longer followed: ${p.reason}`;
      break;
    case "flow.node.skipped":
      detail = `${p.node_id} skipped: ${p.reason}`;
      break;
    case "run.message":
      detail = `${p.message_id} ${p.delivery === "now" ? "now" : "next turn"}${p.task_id ? ` → ${p.task_id}` : ""}: ${truncate(oneLine(String(p.text)), 160)}`;
      break;
    case "run.message.delivered":
      detail = `${p.message_id} → ${p.task_id} attempt ${p.attempt}`;
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
    // Pending approvals show the whole summary (a plan is read before it is approved); decided ones one line.
    const summary = a.status === "pending" ? a.summary.trim().split("\n").map((l) => `  ${l}`.trimEnd()) : [`  ${truncate(oneLine(a.summary), 200)}`];
    lines.push(`${a.id}  ${a.action}  run ${a.run_id}  (${a.status})`, ...summary, `  why: ${a.reason}`);
    if (a.status === "pending" && a.choices.length) {
      lines.push(`  choices: ${a.choices.join(", ")} (default ${a.choices[0]})`, `  decide: navarch approve ${a.id} [--pick <choice>] | navarch reject ${a.id} [--reason <text>]`);
    } else if (a.status === "pending") {
      lines.push(`  decide: navarch approve ${a.id} | navarch reject ${a.id} [--reason <text>]`);
    }
    if (a.choice) lines.push(`  picked: ${a.choice}`);
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

/** Cells may be missing when the daemon is older than the CLI (a new field it does not send yet). */
function table(header: string[], rows: (string | undefined)[][]): string {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (cells: (string | undefined)[]) => cells.map((c, i) => (c ?? "").padEnd(widths[i] ?? 0)).join("  ").trimEnd();
  return [line(header), ...rows.map(line)].join("\n");
}

/** `navarch remote status`: what the phone opens and what is missing (ADR 0020). */
export function formatRemote(s: RemoteStatus): string {
  if (s.mode === "off") return "remote access is off (daemon.remote.mode: off in config.yaml)";
  const lines = [
    `tailscale: ${!s.installed ? "not installed (https://tailscale.com/download)" : s.running ? "running" : "installed, not logged in (run: tailscale up)"}`,
    `phone URL: ${s.url ?? "unknown (set daemon.remote.url, or log in to Tailscale)"}`,
    `tailscale serve: ${s.serving ? "proxies to this daemon" : `not set up; run: ${s.setup_command}`}`,
  ];
  if (s.url && s.serving) lines.push("pair a phone from the Web UI: Settings → Devices → Pair a phone");
  return lines.join("\n");
}

export function formatDevices(devices: DeviceView[]): string {
  if (!devices.length) return "no paired devices; pair a phone from the Web UI: Settings → Devices";
  return devices
    .map((d) => {
      const state = d.revoked_at ? `revoked ${d.revoked_at.slice(0, 16).replace("T", " ")}` : `last seen ${d.last_seen_at?.slice(0, 16).replace("T", " ") ?? "never"}`;
      return `${d.id}  ${d.name}  paired ${d.paired_at.slice(0, 10)}  ${state}  push ${d.push ? "on" : "off"}`;
    })
    .join("\n");
}

/** `navarch project list` (ADR 0021). */
export function formatProjects(projects: ProjectView[]): string {
  if (!projects.length) return "no projects; add one with: navarch project add <clone>";
  return table(
    ["ID", "NAME", "REPOSITORY", "ACTIVE", "INBOX", "SYNCED", "PATH"],
    projects.map((p) => [
      p.id,
      p.name,
      p.repo,
      String(p.active_runs),
      `${p.inbox.new} new, ${p.inbox.triaged} triaged`,
      p.synced_at ? p.synced_at.slice(0, 16).replace("T", " ") : "never",
      p.path,
    ]),
  );
}

export function formatGitHubRepos(repos: GitHubRepoView[]): string {
  if (!repos.length) return "the GitHub token reaches no repositories; give it access to some (ADR 0026)";
  return table(
    ["REPOSITORY", "VISIBILITY", "PUSH", "PROJECT", "DESCRIPTION"],
    repos.map((r) => [r.repo, r.private ? "private" : "public", r.can_push ? "yes" : "no", r.project_id ?? "-", (r.description ?? "").slice(0, 60)]),
  );
}

export function formatSync(results: ProjectSyncResult[]): string {
  if (!results.length) return "no projects to sync; add one with: navarch project add <clone>";
  return results
    .map((r) =>
      r.error
        ? `${r.project_id}: failed: ${r.error}`
        : r.not_modified
          ? `${r.project_id}: no changes`
          : `${r.project_id}: ${r.new} new, ${r.changed} changed, ${r.closed} closed`,
    )
    .join("\n");
}

/** `navarch ci`: one line per failure; titles and check names are untrusted text, kept on one line. */
export function formatCiFailures(failures: CiFailureView[]): string {
  if (!failures.length) return "no CI failures; they are noticed when navarchd syncs (navarch sync)";
  return [
    table(
      ["FAILURE", "PULL REQUEST", "STATUS", "FAILED CHECKS", "TITLE"],
      failures.map((f) => [f.id, `${f.repo}#${f.number}`, f.status, truncate(oneLine(f.checks.map((c) => c.name).join(", ")), 40), truncate(oneLine(f.title), 50)]),
    ),
    "",
    "fix it: navarch ci fix <failure> · dismiss: navarch ci dismiss <failure>",
  ].join("\n");
}

/** `navarch audit`: whether the log's hash chain holds, and the head to keep. */
export function formatAudit(r: AuditVerifyView): string {
  const lines = [
    r.ok ? "the event log's hash chain holds" : `the hash chain is BROKEN at event ${r.broken?.seq} (${r.broken?.id}): ${r.broken?.reason}`,
    `${r.events} events: ${r.chained} chained, ${r.legacy} from before the chain (not covered)`,
  ];
  if (r.head) lines.push(`head: ${r.head}`, "keep the head somewhere the daemon cannot write; --expect <hash> later shows whether the log was rewritten");
  if (r.expected) lines.push(r.expected.found ? "the head you gave is in the log: nothing before it was changed" : `the head you gave is NOT in the log (${r.expected.hash})`);
  return lines.join("\n");
}

/** `navarch audit export`: one line per event with its actor and short hash; the full export is the JSON. */
export function formatRunAudit(a: RunAudit): string {
  const actor = (x: unknown): string => {
    const o = x as { kind?: string; component?: string; profile?: string; via?: string };
    return o.kind === "system" ? `system:${o.component}` : o.kind === "agent" ? `agent:${o.profile}` : `user:${o.via ?? "?"}`;
  };
  return [
    `Audit of ${a.run.name} (${a.run.id}), ${a.run.status}; ${a.events.length} events; log chain ${a.chain.ok ? "holds" : `BROKEN at ${a.chain.broken?.seq}`}`,
    ...a.events.map((e) => `${String(e.seq).padStart(6)}  ${e.ts}  ${truncate(actor(e.actor), 22).padEnd(22)}  ${e.type.padEnd(28)}  ${e.hash ? e.hash.slice(0, 10) : "unchained"}`),
  ].join("\n");
}

/** The conditions the user reads before turning auto-merge on (spec §11.1). */
export function formatAutoMergeConditions(status: AutoMergeStatus): string {
  return ["Auto-merge merges a pull request of Navarch's without asking you, only when all of these hold:", ...status.conditions.map((c) => `  - ${c}`), "Release and deploy are never automatic. Turn it off at any time (navarch automerge off) or with the kill switch."].join("\n");
}

/** `navarch automerge`: each project's state and why its open PRs are waiting; reasons may carry untrusted text. */
export function formatAutoMerge(status: AutoMergeStatus): string {
  if (!status.projects.length) return "no projects; add one with navarch project add";
  const lines = [formatAutoMergeConditions(status), ""];
  for (const p of status.projects) {
    lines.push(`${p.repo}  ${p.project_id}  auto-merge ${p.enabled ? `ON (${p.strategy}) since ${p.since}` : "off"}`);
    for (const w of p.waiting) lines.push(`    #${w.number} waiting: ${truncate(oneLine(w.reason), 100)}`);
  }
  return lines.join("\n");
}

/** `navarch summary`: the morning summary; titles are untrusted text, kept on one line. */
export function formatSummary(s: MorningSummary | null): string {
  if (!s) return "no summary yet; make one with: navarch summary --now (or turn on summary.enabled)";
  const item = (i: MorningSummary["new_items"][number]) =>
    `  ${i.repo}#${i.number} ${truncate(oneLine(i.title), 60)}` +
    (i.complexity === null ? " (not triaged)" : ` [${i.kind}, complexity ${i.complexity}${i.estimate_usd === null ? "" : `, ~$${i.estimate_usd.toFixed(2)}`}]`);
  const lines = [`Morning summary · ${s.generated_at} (since ${s.since})`, ""];
  lines.push(`New or changed issues: ${s.new_total}${s.duplicates ? ` · ${s.duplicates} possible duplicates` : ""}`, ...s.new_items.map(item));
  if (s.ci_failures.length) lines.push("", `CI failing: ${s.ci_failures.length}`, ...s.ci_failures.map((f) => `  ${f.repo}#${f.number} ${truncate(oneLine(f.title), 60)}  (navarch ci fix ${f.id})`));
  if (s.stalled_prs.length) lines.push("", `Stalled draft PRs: ${s.stalled_prs.length}`, ...s.stalled_prs.map((p) => `  ${p.repo}#${p.number} open ${p.days} days`));
  lines.push("", `Approvals waiting: ${s.approvals_waiting} · runs finished: ${s.runs_finished} (${s.runs_failed} failed) · billed $${s.billed_usd.toFixed(2)}`);
  if (s.suggestions.length) lines.push("", `Worth a run (estimate $${s.suggestions_estimate_usd.toFixed(2)}):`, ...s.suggestions.map(item), "  start with: navarch inbox start <item>...");
  return lines.join("\n");
}

/** `navarch inbox`: one line per item; titles are untrusted text, kept on one line. */
export function formatInbox(view: InboxView): string {
  const lines: string[] = [];
  if (!view.triage.available && view.triage.reason) lines.push(`triage: ${view.triage.reason}`, "");
  if (!view.items.length) {
    lines.push("the Inbox is empty; sync with: navarch sync");
    return lines.join("\n");
  }
  lines.push(
    table(
      ["ITEM", "ISSUE", "STATUS", "KIND", "CPLX", "AREA", "ACTION", "EST.", "TITLE"],
      view.items.map((i) => [
        i.id,
        `${i.repo}#${i.number}`,
        i.status,
        i.triage?.kind ?? "—",
        i.triage ? String(i.triage.complexity) : "—",
        i.triage?.area || "—",
        i.triage ? (i.triage.duplicate_of ? `duplicate of #${i.triage.duplicate_of}` : i.triage.suggested_action.replace("_", " ")) : "—",
        i.estimate ? usd(i.estimate.usd) : "—",
        truncate(oneLine(i.title), 60),
      ]),
    ),
  );
  lines.push("", "start runs: navarch inbox start <item>... · dismiss: navarch inbox dismiss <item>");
  return lines.join("\n");
}

/** `navarch away`: whether the approver is deciding, what was handed over, and what it did. */
export function formatAway(view: AwayView): string {
  const s = view.settings;
  const lines: string[] = [];
  if (!view.active) {
    lines.push("Away mode is off. Approvals wait for you.");
  } else if (s) {
    lines.push(
      `AWAY MODE IS ON since ${view.since!.slice(0, 16).replace("T", " ")}${s.until ? `, until ${s.until.slice(0, 16).replace("T", " ")}` : ", until you turn it off"}.`,
      `An approver agent decides for you: ${s.delegate.join(", ")}. Runs rated above complexity ${s.max_complexity ?? "(no limit)"} wait for you. It may send a plan back up to ${s.max_revisions} time(s).`,
    );
    if (view.unavailable) lines.push(`Not working now: ${view.unavailable}`);
  }
  if (s) lines.push("", `Since it was turned on: ${view.counts.approved} approved, ${view.counts.revised} sent back, ${view.counts.escalated} left to you.`);
  const rows = view.reviews.slice(0, 20).map((r) => [r.at.slice(11, 16), r.run_name ?? r.run_id ?? "-", r.subject, r.verdict, truncate(r.reason, 70)]);
  if (rows.length) lines.push("", table(["TIME", "RUN", "WHAT", "VERDICT", "WHY"], rows));
  if (view.active) lines.push("", "Turn it off with: navarch away off");
  return lines.join("\n");
}

/** `navarch budget`: each scope's billed use against its limit (ADR 0023). */
export function formatBudgets(budgets: BudgetView[]): string {
  const scope = (b: BudgetView) => (b.scope === "run" ? `run ${b.target}` : b.scope === "project_daily" ? `project ${b.label} (${b.target}) · ${b.period}` : `global · ${b.period}`);
  const state = (b: BudgetView) => (b.state === "exceeded" ? "EXCEEDED" : b.state === "warning" ? "warning" : "ok");
  const rows = budgets.map((b) => [
    scope(b),
    b.limit === null ? `${usd(b.used)} (no limit)` : `${usd(b.used)} of ${usd(b.limit)} · ${Math.round((b.ratio ?? 0) * 100)} %`,
    b.limit === null ? "-" : state(b),
    b.plan_equivalent > 0 ? usd(b.plan_equivalent) : "-",
    b.source,
  ]);
  return [
    table(["SCOPE", "BILLED", "STATE", "PLAN-EQUIVALENT", "LIMIT FROM"], rows),
    "",
    "only billed (API key) use counts; plan use is limited by quotas. Change a limit with:",
    "  navarch budget set --monthly <usd|none> | --project <id> --daily <usd|none> | --run <id> <usd>",
  ].join("\n");
}

/** `navarch usage`: spend and observed metrics per model (ADR 0023). */
export function formatUsage(u: UsageView): string {
  const tokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  const pct = (n: number | null) => (n === null ? "-" : `${Math.round(n * 100)} %`);
  const lines = [
    `today       ${usd(u.today.cost)} billed · ${usd(u.today.plan_cost)} plan-equivalent · ${tokens(u.today.tokens)} tokens`,
    `this month  ${usd(u.month.cost)} billed · ${usd(u.month.plan_cost)} plan-equivalent · ${tokens(u.month.tokens)} tokens`,
    "",
  ];
  if (!u.models.length) lines.push(`no agent tasks in the last ${u.window_days} days`);
  else {
    lines.push(`agents and models, last ${u.window_days} days${u.models[0]?.profile ? ` (profile ${u.models[0].profile})` : ""}:`);
    lines.push(
      table(
        ["MODEL", "BILLING", "TASKS", "OK", "ERR 24H", "LIMITED", "TOKENS IN/OUT", "TOKENS/OK", "COST/OK", "BILLED", "P50"],
        u.models.map((m) => [
          m.id,
          m.billing,
          String(m.tasks),
          pct(m.success_rate),
          pct(m.error_rate_24h),
          String(m.rate_limited),
          `${tokens(m.tokens_in)}/${tokens(m.tokens_out)}`,
          m.median_tokens_per_success === null ? "-" : tokens(m.median_tokens_per_success),
          m.median_cost_per_success === null ? "-" : usd(m.median_cost_per_success),
          usd(m.cost),
          m.p50_duration_ms === null ? "-" : `${Math.round(m.p50_duration_ms / 1000)}s`,
        ]),
      ),
    );
  }
  const quotas = u.quotas.filter((q) => q.utilization !== null || q.exhausted);
  if (quotas.length) {
    lines.push("", "quotas:");
    for (const q of quotas) {
      lines.push(`  ${q.adapter}${q.model_prefix ? `/${q.model_prefix}` : ""} ${q.window}: ${q.exhausted ? "exhausted" : pct(q.utilization)}${q.resets_at ? `, resets ${q.resets_at.slice(0, 16).replace("T", " ")}` : ""}`);
    }
  }
  return lines.join("\n");
}

/** `navarch metrics`: the cost and quality panels (ADR 0037). */
export function formatMetrics(m: MetricsView): string {
  const tokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  const pct = (n: number | null) => (n === null ? "-" : `${Math.round(n * 100)} %`);
  const spend = (s: { cost: number; plan_cost: number; tokens: number }) => [usd(s.cost), usd(s.plan_cost), tokens(s.tokens)];
  const c = m.cost;
  const pr = m.quality.pull_requests;
  const lines = [`cost, last ${m.window_days} days: ${usd(c.total.cost)} billed · ${usd(c.total.plan_cost)} plan-equivalent · ${tokens(c.total.tokens)} tokens`, ""];
  const used = c.days.filter((d) => d.cost || d.plan_cost || d.tokens);
  if (used.length) lines.push("by day:", table(["DAY", "BILLED", "PLAN-EQ", "TOKENS"], used.map((d) => [d.day, ...spend(d)])), "");
  if (c.projects.length) lines.push("by project:", table(["PROJECT", "RUNS", "BILLED", "PLAN-EQ", "TOKENS"], c.projects.map((p) => [p.label, String(p.runs), ...spend(p)])), "");
  if (c.profiles.length) lines.push("by profile:", table(["PROFILE", "TASKS", "BILLED", "PLAN-EQ", "TOKENS"], c.profiles.map((p) => [p.profile ?? "(outside runs)", String(p.tasks), ...spend(p)])), "");
  if (c.models.length) lines.push("by model:", table(["MODEL", "CALLS", "BILLED", "PLAN-EQ", "TOKENS"], c.models.map((x) => [x.model, String(x.calls), ...spend(x)])), "");
  lines.push(
    `pull requests opened: ${pr.opened} · open ${pr.open} · merged ${pr.merged} · closed ${pr.closed}${pr.gone ? ` · lost ${pr.gone}` : ""}`,
    `  accepted ${pct(pr.acceptance_rate)} · as is ${pr.accepted_as_is} · rework (> 2 commits after Navarch's) ${pr.rework}, ${pct(pr.rework_rate)} · cost per merged PR ${pr.cost_per_merged === null ? "-" : usd(pr.cost_per_merged)}`,
  );
  const profiles = m.quality.profiles;
  if (profiles.length) {
    lines.push("", "success by profile:", table(["PROFILE", "TASKS", "OK", "LIMITED"], profiles.map((p) => [p.profile, String(p.tasks), pct(p.success_rate), String(p.rate_limited)])));
  }
  if (m.quality.models.length) {
    lines.push("", "success by model:", table(["MODEL", "TASKS", "OK", "ERR 24H"], m.quality.models.map((x) => [x.id, String(x.tasks), pct(x.success_rate), pct(x.error_rate_24h)])));
  }
  lines.push("", ...formatKnowledge(m.knowledge, tokens, pct));
  return lines.join("\n");
}

/** `navarch specs`: what each reverse-spec run wrote and how much of it is 🟢 after the evidence check (ADR 0045). */
export function formatSpecs(runs: SpecRunView[]): string {
  if (!runs.length) return "no specs written yet; run `navarch run --flow reverse-spec \"<scope>\"`";
  const pct = (n: number | null) => (n === null ? "-" : `${Math.round(n * 100)} %`);
  return table(
    ["RUN", "WHEN", "COMPONENTS", "CLAIMS", "🟢", "🟡", "🔴", "🟢 SHARE", "LOWERED", "BRANCH"],
    runs.map((r) => [r.run_name ?? r.run_id, r.ts.slice(0, 16).replace("T", " "), String(r.components), String(r.claims), String(r.confirmed), String(r.inferred), String(r.gap), pct(r.green_rate), String(r.downgraded), r.branch]),
  );
}

/** `navarch trace`: the matrices of a project's specs (ADR 0054); test links are inferred from names and imports. */
export function formatTraceability(t: TraceabilityView): string {
  if (!t.has_specs) return "no specs in this project yet; run `navarch run --flow reverse-spec \"<scope>\"` and merge its pull request";
  const pct = (n: number | null) => (n === null ? "-" : `${Math.round(n * 100)} %`);
  const out = [
    `code ↔ spec: ${t.totals.cited_files} of ${t.totals.source_files} source files are cited by a claim (${pct(t.totals.cited_share)}); ${t.uncovered_total} are not`,
    `spec ↔ test: ${t.totals.claims_with_tests} of ${t.totals.claims_with_files} claims that cite a file have a test tied to it (${pct(t.totals.tested_share)}); links are inferred, a test with the same name or importing the file`,
    "",
    table(["COMPONENT", "CLAIMS", "WITH FILES", "WITH TESTS", "FILES"], t.components.map((c) => [c.component, String(c.claims), String(c.claims_with_files), String(c.claims_with_tests), String(c.files)])),
  ];
  const untested = t.code_spec.filter((r) => !r.tests.length);
  if (untested.length) out.push("", "cited files with no test tied to them:", ...untested.slice(0, 20).map((r) => `  ${r.file} (${r.claims.map((c) => `${c.component}/${c.claim}`).join(", ")})`), ...(untested.length > 20 ? [`  … and ${untested.length - 20} more`] : []));
  if (t.broken.length) out.push("", "citations that no longer match the code:", ...t.broken.slice(0, 20).map((b) => `  ${b.component}/${b.claim} → ${b.file}:${b.line}`));
  if (t.uncovered.length) out.push("", "source files no claim cites:", ...t.uncovered.slice(0, 20).map((f) => `  ${f}`), ...(t.uncovered_total > 20 ? [`  … and ${t.uncovered_total - 20} more`] : []));
  return out.join("\n");
}

/** `navarch principles`: the rules agents get in this project's runs (ADR 0047). */
export function formatPrinciples(view: PrinciplesView): string {
  const out: string[] = [];
  if (!view.principles.length) out.push("no rules yet; add one with `navarch principles add \"<rule>\"` or list bullets in .navarch/principles.md");
  else out.push(table(["ID", "FROM", "RULE"], view.principles.map((p) => [p.id, p.source === "user" ? "you" : "repository file", p.text])));
  if (view.truncated) out.push("(only the first rules reach agents)");
  if (view.proposals.length) {
    out.push("", "proposed by agents (not applied until you accept; the reasons are the agents' own words):");
    out.push(table(["ID", "RUN", "RULE", "REASON"], view.proposals.map((p) => [p.id, p.run_id ?? "-", p.text, truncate(p.reason, 70)])));
    out.push("accept one with `navarch principles accept <id>`, or `navarch principles dismiss <id>`");
  }
  return out.join("\n");
}

/** The Phase 3 token goal: input tokens with and without the compiled context (ADR 0044). */
function formatKnowledge(k: KnowledgePanel, tokens: (n: number) => string, pct: (n: number | null) => string): string[] {
  const num = (n: number | null) => (n === null ? "-" : tokens(n));
  const red = (n: number | null) => (n === null ? "-" : `${n >= 0 ? "-" : "+"}${Math.abs(Math.round(n * 100))} %`);
  const verdict = { met: "met", not_met: "not met", insufficient: `not enough data yet (${k.min_attempts} attempts on each side)` }[k.verdict];
  const row = (label: string, w: KnowledgePanel["overall"]) => [label, `${w.with.attempts}/${w.without.attempts}`, num(w.with.median_input_tokens), num(w.without.median_input_tokens), red(w.reduction), `${pct(w.with.success_rate)}/${pct(w.without.success_rate)}`];
  const pr = k.pull_requests;
  return [
    `context compiler: input tokens per attempt with / without the block, target -${Math.round(k.target_reduction * 100)} % · ${verdict}`,
    ...(k.context.attempts ? [`  ${k.context.attempts} attempts carried a block of about ${num(k.context.median_est_tokens)} tokens`] : []),
    table(["PROFILE", "ATTEMPTS", "WITH", "WITHOUT", "CHANGE", "OK"], [...k.profiles.map((p) => row(p.profile, p)), row("all", k.overall)]),
    `  PRs accepted: with ${pct(pr.with.acceptance_rate)} (${pr.with.merged}/${pr.with.closed}) · without ${pct(pr.without.acceptance_rate)} (${pr.without.merged}/${pr.without.closed})`,
  ];
}

/** `navarch flow list`: built-in and Studio Flows (ADR 0033). */
export function formatFlows(flows: FlowSummary[]): string {
  const state = (f: FlowSummary) => {
    if (f.source === "builtin") return "built-in";
    const parts = [f.published_version ? `v${f.published_version}` : "unpublished", ...(f.draft ? [`draft r${f.draft.revision}`] : []), ...(f.shadowed ? ["shadowed by a built-in"] : [])];
    return parts.join(" · ");
  };
  return table(["NAME", "VERSION", "DESCRIPTION"], flows.map((f) => [f.name, state(f), f.description ?? "-"]));
}

/** `navarch flow validate`: one line per problem, `file:line: severity: message`. */
export function formatProblems(file: string, problems: FlowProblem[]): string {
  if (!problems.length) return `${file}: valid`;
  const lines = problems.map((p) => `${file}${p.line ? `:${p.line}` : ""}: ${p.severity}: ${p.message}`);
  const errors = problems.filter((p) => p.severity === "error").length;
  return [...lines, `${errors} error(s), ${problems.length - errors} warning(s)`].join("\n");
}

/** `navarch map` (ADR 0042). Everything printed comes from the repository. */
export function formatRepoMap(map: RepoMap): string {
  const list = (items: string[]) => (items.length ? items.join(", ") : "none found");
  return [
    `${map.files} files`,
    "",
    "Languages",
    table(["LANGUAGE", "FILES", "LINES"], map.languages.map((l) => [l.lang, String(l.files), String(l.lines)])),
    "",
    `Frameworks and tools: ${list(map.frameworks)}`,
    `Entry points: ${list(map.entry_points)}`,
    `Manifests: ${list(map.manifests)}`,
    "",
    "Directories",
    table(["PATH", "FILES"], map.directories.map((d) => [d.path, String(d.files)])),
  ].join("\n");
}

/** `navarch symbols` (ADR 0042). */
export function formatSymbols(symbols: CodeSymbol[]): string {
  if (!symbols.length) return "no symbols found";
  return table(["SYMBOL", "KIND", "LOCATION", "EXPORTED"], symbols.map((s) => [s.name, s.kind, `${s.file}:${s.line}`, s.exported ? "yes" : "no"]));
}

/** `navarch where` (ADR 0042). */
export function formatHits(hits: SearchHit[]): string {
  return hits.length ? hits.map((h) => `${h.file}:${h.line}: ${h.text}`).join("\n") : "no matches";
}
