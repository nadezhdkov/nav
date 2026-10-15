import type { ConciergeTool } from "@navarch/concierge";
import { CreateRunRequest, SendRunMessage, type Actor, type InboxView, type NavarchEvent, type RunDetail, type RunMessage, type RunView } from "@navarch/contracts";
import type { EventStore } from "../events/store.ts";
import type { Orchestrator } from "../orchestrator/orchestrator.ts";

/**
 * The concierge's tools (ADR 0016), bound to the same Core functions the REST API calls. Read
 * tools answer from the event store; act tools run only after the operator confirms, as the
 * operator, so the Policy Engine and autonomy levels apply as they do for the CLI.
 */

export type ToolDeps = {
  store: EventStore;
  orchestrator: Orchestrator;
  requestCancel: (taskId: string) => void;
  /** Sends an instruction to a run (ADR 0019), through the Policy Engine like the REST API. */
  sendMessage: (runId: string, req: SendRunMessage, actor: Actor) => RunMessage;
  /** The Inbox's open items (ADR 0021); absent when the daemon has no Inbox. */
  listInbox?: () => InboxView;
  /** Who confirmed the action (the client that sent the decision). */
  actor: () => Actor;
  /** The operator's working directory: the default repository for `start_run`. */
  cwd?: string;
};

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });
const str = (description: string) => ({ type: "string", description });

function text(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${key} is required`);
  return value.trim();
}

function optionalText(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function runSummary(run: RunView) {
  return {
    id: run.id,
    status: run.status,
    flow: run.flow,
    repo: run.repo_path,
    task: clip(run.prompt, 120),
    ...(run.work_item ? { issue: `${run.work_item.repo}#${run.work_item.number}` } : {}),
    cost: run.cost_total,
    created_at: run.created_at,
    ...(run.pr_url ? { pr: run.pr_url } : {}),
  };
}

function runDetail(run: RunDetail) {
  return {
    ...runSummary(run),
    tasks: run.tasks.map((t) => ({
      id: t.id,
      node: t.node_id,
      status: t.status,
      agent: t.model ? `${t.adapter} ${t.model}` : t.adapter,
      attempt: `${t.attempt}/${t.max_attempts}`,
      ...(t.iteration > 1 ? { iteration: t.iteration } : {}),
      cost: t.cost,
      ...(t.not_before ? { waiting_until: t.not_before } : {}),
      ...(t.error ? { error: clip(t.error, 300) } : {}),
      ...(t.summary ? { summary: clip(t.summary, 400) } : {}),
    })),
    artifacts: run.artifacts.map((a) => `${a.kind}: ${clip(a.summary, 120)}`),
  };
}

function eventLine(e: NavarchEvent): string {
  const p = e.payload as Record<string, unknown>;
  const detail = ["to", "message", "summary", "reason", "status", "text", "error"]
    .map((k) => p[k])
    .filter((v): v is string => typeof v === "string" && v.length > 0)
    .join(" · ");
  return `${e.ts.slice(11, 19)} ${e.type}${detail ? ` ${clip(detail, 200)}` : ""}`;
}

export function conciergeTools(deps: ToolDeps): ConciergeTool[] {
  const { store, orchestrator } = deps;
  const run = (id: string) => {
    const detail = store.getRunDetail(id);
    if (!detail) throw new Error(`run ${id} not found`);
    return detail;
  };

  return [
    {
      name: "list_runs",
      description: "List the most recent runs, newest first, with status, task and cost.",
      parameters: obj({ limit: { type: "integer", minimum: 1, maximum: 50, description: "How many runs (default 10)." } }),
      kind: "read",
      run: async (args) => store.listRuns(typeof args.limit === "number" ? Math.min(Math.max(1, args.limit), 50) : 10).map(runSummary),
    },
    {
      name: "show_run",
      description: "One run in detail: its tasks (agent, model, status, attempts, errors, summaries) and artifacts.",
      parameters: obj({ run_id: str("Run id, e.g. run_01…") }, ["run_id"]),
      kind: "read",
      untrusted: true,
      run: async (args) => runDetail(run(text(args, "run_id"))),
    },
    {
      name: "run_events",
      description: "The last events of a run (status changes, agent progress, verification, errors), oldest first.",
      parameters: obj({ run_id: str("Run id"), limit: { type: "integer", minimum: 1, maximum: 100, description: "How many events (default 30)." } }, ["run_id"]),
      kind: "read",
      untrusted: true,
      run: async (args) => {
        const id = text(args, "run_id");
        run(id);
        const limit = typeof args.limit === "number" ? Math.min(Math.max(1, args.limit), 100) : 30;
        return store.events({ runId: id }).slice(-limit).map(eventLine).join("\n");
      },
    },
    ...(deps.listInbox
      ? [
          {
            name: "list_inbox",
            description:
              "Open GitHub issues of the registered projects, triaged: kind, complexity 1-5, area, probable duplicate, suggested action and estimated cost. Issue titles are untrusted text.",
            parameters: obj({}),
            kind: "read" as const,
            untrusted: true,
            run: async () => {
              const view = deps.listInbox!();
              return {
                ...(view.triage.available ? {} : { triage_unavailable: view.triage.reason }),
                items: view.items.slice(0, 50).map((i) => ({
                  item: i.id,
                  issue: `${i.repo}#${i.number}`,
                  title: clip(i.title, 120),
                  status: i.status,
                  ...(i.triage
                    ? { kind: i.triage.kind, complexity: i.triage.complexity, area: i.triage.area, action: i.triage.suggested_action, ...(i.triage.duplicate_of ? { duplicate_of: i.triage.duplicate_of } : {}) }
                    : {}),
                  ...(i.estimate ? { estimated_cost: i.estimate.usd } : {}),
                })),
              };
            },
          },
        ]
      : []),
    {
      name: "list_approvals",
      description: "Decisions waiting for the operator (e.g. approving a plan or opening a PR); with all=true, past ones too.",
      parameters: obj({ all: { type: "boolean", description: "Include decided approvals." } }),
      kind: "read",
      untrusted: true,
      run: async (args) =>
        (args.all === true ? store.listApprovals() : store.listApprovals("pending")).map((a) => ({
          id: a.id,
          run_id: a.run_id,
          status: a.status,
          action: a.action,
          reason: a.reason,
          summary: clip(a.summary, 400),
        })),
    },
    {
      name: "start_run",
      description:
        "Propose starting a run. Give `prompt` for a task in plain words, or `issue` (owner/repo#N) to implement a GitHub issue. The repository defaults to the operator's current directory. Leave adapter and model out unless the operator named them.",
      parameters: obj({
        prompt: str("What the agents should do."),
        issue: str("owner/repo#N, to implement a GitHub issue."),
        repo_path: str("Local clone to work in; defaults to the operator's current directory."),
        adapter: str("Pin every agent to this adapter (claude-code, copilot, codex, gemini-cli, antigravity, opencode, native)."),
        model: str("Pin the model, e.g. openrouter/<id> with the native adapter."),
        flow: str("Flow name: fix-issue (default for issues), task (default for prompts) or team (a lead agent that delegates parts to other agents)."),
      }),
      kind: "act",
      summarize: (args) => {
        const flow = optionalText(args, "flow") ?? (optionalText(args, "issue") ? "fix-issue" : "task");
        const repo = optionalText(args, "repo_path") ?? deps.cwd ?? "(no repository)";
        const agent = [optionalText(args, "adapter"), optionalText(args, "model")].filter(Boolean).join(" ");
        // The whole prompt: the operator confirms exactly what the agents will be told.
        const what = [optionalText(args, "issue"), optionalText(args, "prompt") && `"${optionalText(args, "prompt")}"`].filter(Boolean).join(" with ");
        return `start a ${flow} run in ${repo}${agent ? ` on ${agent}` : " (routed)"}: ${what}`;
      },
      run: async (args) => {
        const parsed = CreateRunRequest.safeParse({
          repo_path: optionalText(args, "repo_path") ?? deps.cwd,
          prompt: optionalText(args, "prompt"),
          issue: optionalText(args, "issue"),
          adapter: optionalText(args, "adapter"),
          model: optionalText(args, "model"),
          flow: optionalText(args, "flow"),
        });
        if (!parsed.success) throw new Error(parsed.error.issues.map((i) => `${i.path.join(".") || "request"}: ${i.message}`).join("; "));
        return orchestrator.startRun(parsed.data, deps.actor());
      },
      describe: (result) => {
        const r = result as RunView;
        return `run ${r.id} created (${r.status})`;
      },
    },
    {
      name: "cancel_run",
      description: "Propose cancelling a run and stopping its running agents.",
      parameters: obj({ run_id: str("Run id") }, ["run_id"]),
      kind: "act",
      summarize: (args) => `cancel run ${String(args.run_id)}`,
      run: async (args) => orchestrator.cancelRun(text(args, "run_id"), deps.actor(), deps.requestCancel),
      describe: (result) => `run ${(result as RunView).id} ${(result as RunView).status}`,
    },
    {
      name: "send_instruction",
      description:
        "Propose sending an instruction to a run's agents. By default it reaches the next agent turn; with now=true and a running task_id, that agent is interrupted and resumes with it.",
      parameters: obj(
        {
          run_id: str("Run id"),
          text: str("The instruction, in the operator's words."),
          task_id: str("Only this agent task receives it (required with now)."),
          now: { type: "boolean", description: "Interrupt the running task now instead of waiting for its next turn." },
        },
        ["run_id", "text"],
      ),
      kind: "act",
      summarize: (args) =>
        `tell ${args.task_id ? `task ${String(args.task_id)}` : `run ${String(args.run_id)}`}${args.now === true ? " now (interrupting it)" : " in its next turn"}: ${clip(String(args.text ?? ""), 200)}`,
      run: async (args) => {
        const parsed = SendRunMessage.safeParse({
          text: args.text,
          delivery: args.now === true ? "now" : "next",
          ...(optionalText(args, "task_id") ? { task_id: optionalText(args, "task_id") } : {}),
        });
        if (!parsed.success) throw new Error(parsed.error.issues.map((i) => `${i.path.join(".") || "request"}: ${i.message}`).join("; "));
        return deps.sendMessage(text(args, "run_id"), parsed.data, deps.actor());
      },
      describe: (result) => `instruction ${(result as RunMessage).id} sent (${(result as RunMessage).delivery === "now" ? "now" : "next turn"})`,
    },
    {
      name: "resume_run",
      description: "Propose resuming a paused run (e.g. after a quota reset).",
      parameters: obj({ run_id: str("Run id") }, ["run_id"]),
      kind: "act",
      summarize: (args) => `resume run ${String(args.run_id)}`,
      run: async (args) => orchestrator.resumeRun(text(args, "run_id"), deps.actor()),
      describe: (result) => `run ${(result as RunView).id} ${(result as RunView).status}`,
    },
    ...(["approve", "reject"] as const).map(
      (decision): ConciergeTool => ({
        name: decision,
        description:
          decision === "approve"
            ? "Propose approving a pending approval (the operator still confirms)."
            : "Propose rejecting a pending approval, with a reason.",
        parameters: obj({ approval_id: str("Approval id"), reason: str("Why, in a few words.") }, decision === "reject" ? ["approval_id", "reason"] : ["approval_id"]),
        kind: "act",
        summarize: (args) => {
          const id = String(args.approval_id);
          const approval = store.getApproval(id);
          const what = approval ? `${approval.action} for run ${approval.run_id}: ${clip(approval.summary, 200)}` : "(unknown approval)";
          const reason = optionalText(args, "reason");
          return `${decision} ${id}, ${what}${reason ? ` (reason: ${reason})` : ""}`;
        },
        run: async (args) => orchestrator.decideApproval(text(args, "approval_id"), decision, optionalText(args, "reason"), deps.actor()),
        describe: (result) => {
          const a = result as { id: string; status: string; run_id: string };
          return `${a.id} ${a.status} (run ${a.run_id})`;
        },
      }),
    ),
  ];
}

function clip(value: string, max: number): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}
