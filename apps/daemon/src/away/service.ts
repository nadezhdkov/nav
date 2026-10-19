import { NativeAdapter, ModelError, chat } from "@navarch/adapter-native";
import type { AgentRuntime } from "@navarch/agent-runtime";
import type { Actor, ApprovalView, AwayDelegate, AwayView, SetAwayRequest } from "@navarch/contracts";
import type { Config } from "../config.ts";
import type { EventStore, TaskRecord } from "../events/store.ts";
import type { Orchestrator } from "../orchestrator/orchestrator.ts";
import type { PolicyEngine } from "../policy/engine.ts";
import { nativeModels } from "../routing/native-models.ts";
import { parseReview, reviewMessages, type Dossier } from "./review.ts";

export type AwayDeps = {
  config: Config;
  store: EventStore;
  policy: PolicyEngine;
  orchestrator: Orchestrator;
  runtime: AgentRuntime;
  adapters: Map<string, unknown>;
  now?: () => number;
};

export class AwayError extends Error {
  readonly code: "forbidden" | "invalid_request";

  constructor(code: AwayError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

const system: Actor = { kind: "system", component: "away" };
const TICK_MS = 30_000;

/**
 * Away mode (ADR 0039). While the user is away, an approver agent reads the approvals the user
 * handed over (the plan gate, opening the draft PR, starting agents) and approves them, sends a
 * plan back with feedback, or leaves them waiting for the user. It never touches merges, budgets
 * or anything the user did not hand over, and every decision is an event.
 */
export class AwayService {
  private readonly deps: AwayDeps;
  private off: (() => void) | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private work: Promise<void> = Promise.resolve();
  private readonly queued = new Set<string>();
  private unavailable: string | null = null;
  private stopped = false;

  constructor(deps: AwayDeps) {
    this.deps = deps;
  }

  start(): void {
    this.off = this.deps.store.subscribe((event) => {
      if (event.type === "approval.requested") this.enqueue((event.payload as { approval_id: string }).approval_id);
      else if (event.type === "away.enabled") this.sweep();
    });
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.sweep();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.off?.();
    clearInterval(this.timer);
    await this.work;
  }

  view(): AwayView {
    return this.deps.store.awayView(this.unavailable);
  }

  /** Turns the mode on (after the user's explicit yes, `confirm`) or off. */
  set(req: SetAwayRequest, actor: Actor): AwayView {
    const decision = this.deps.policy.decide(actor, "away.set", "away", { autonomyLevel: this.deps.config.autonomy_level });
    if (decision.effect !== "allow") throw new AwayError("forbidden", decision.reason);
    if (req.enabled) {
      const until = req.minutes === null ? null : new Date(this.now() + req.minutes * 60_000).toISOString();
      this.deps.store.append([
        {
          type: "away.enabled",
          run_id: null,
          task_id: null,
          actor,
          payload: { delegate: [...new Set(req.delegate)], until, max_complexity: req.max_complexity, max_revisions: req.max_revisions },
        },
      ]);
    } else if (this.deps.store.awayView().active) {
      this.deps.store.append([{ type: "away.disabled", run_id: null, task_id: null, actor, payload: { reason: "user" } }]);
    }
    return this.view();
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** Turns the mode off when its time is up. True when it is off now. */
  private expire(): boolean {
    const view = this.deps.store.awayView();
    if (!view.active || !view.settings) return true;
    if (view.settings.until !== null && Date.parse(view.settings.until) <= this.now()) {
      this.deps.store.append([{ type: "away.disabled", run_id: null, task_id: null, actor: system, payload: { reason: "expired" } }]);
      return true;
    }
    return false;
  }

  private tick(): void {
    if (this.stopped) return;
    if (!this.expire()) this.sweep();
  }

  /** Approvals already waiting when the mode is turned on, or after a restart. */
  private sweep(): void {
    for (const approval of this.deps.store.listApprovals("pending")) this.enqueue(approval.id);
  }

  private enqueue(approvalId: string): void {
    if (this.stopped || this.queued.has(approvalId)) return;
    const view = this.deps.store.awayView();
    if (!view.active) return;
    this.queued.add(approvalId);
    // One approval at a time: each is a model call, and a run's next step may depend on the last.
    this.work = this.work.then(() => this.consider(approvalId)).catch(() => undefined).finally(() => this.queued.delete(approvalId));
  }

  private async consider(approvalId: string): Promise<void> {
    if (this.stopped || this.expire()) return;
    const { store } = this.deps;
    const view = store.awayView();
    const settings = view.settings!;
    const approval = store.getApproval(approvalId);
    if (!approval || approval.status !== "pending" || store.awayReviewed(approval.id)) return;
    const task = store.getTask(approval.task_id);
    const run = store.getRunRecord(approval.run_id);
    if (!task || !run || task.status !== "waiting_approval") return;
    const subject = subjectOf(approval, task);
    if (!subject || !settings.delegate.includes(subject)) return;
    const actor: Actor = { kind: "agent", profile: "approver", adapter: "native" };
    const allowed = this.deps.policy.decide(actor, "approval.delegate", approval.id, {
      autonomyLevel: this.deps.config.autonomy_level,
      away: { active: true, delegated: true },
    });
    if (allowed.effect !== "allow") return;

    const tasks = store.taskRecordsOfRun(run.id);
    // What no model should weigh: a run the triage rates harder than the user allowed, or a change that did not pass its checks.
    const complexity = tasks.find((t) => t.profile === "triager" && t.status === "succeeded")?.outputs?.complexity;
    if (settings.max_complexity !== null && typeof complexity === "number" && complexity > settings.max_complexity) {
      this.leave(approval, subject, `the triage rates it ${complexity}, above the limit of ${settings.max_complexity} you set`, "rule");
      return;
    }
    if (subject === "pr") {
      const verify = latest(tasks, (t) => t.node_id === "verify" || t.uses === "verification.run");
      if (verify?.outputs?.passed === false) {
        this.leave(approval, subject, "the checks did not pass", "rule");
        return;
      }
    }

    const dossier = this.dossier(subject, approval, run.prompt, tasks, settings.max_revisions);
    const found = this.models();
    if ("reason" in found) {
      // Nobody can read it, so it waits for the user, who is told.
      this.unavailable = found.reason;
      this.leave(approval, subject, "the approver has no model to run on", "none");
      return;
    }
    this.unavailable = null;
    await this.ask(approval, subject, dossier, found.models);
  }

  private models(): { models: string[]; native: NativeAdapter } | { reason: string } {
    const native = this.deps.adapters.get("native");
    if (!(native instanceof NativeAdapter)) return { reason: "the approver needs the native adapter (adapters.native.enabled)" };
    const found = nativeModels(this.deps, "approver", this.deps.config.away.model);
    if ("reason" in found) return { reason: `no API model for the approver: ${found.reason}. Set away.model (e.g. openrouter/<id>) or add native entries to the approver tier (routing.profiles.approver, default standard)` };
    return { models: found.models, native };
  }

  private async ask(approval: ApprovalView, subject: AwayDelegate, dossier: Dossier, models: string[]): Promise<void> {
    const found = this.models();
    if ("reason" in found) return;
    const messages = reviewMessages(dossier);
    let lastError = "no model answered";
    for (const model of models) {
      try {
        const { provider, model: providerModel } = await found.native.connect(model);
        const response = await chat(provider, providerModel, messages, [], new AbortController().signal, 120_000);
        if (this.stopped || this.deps.store.getApproval(approval.id)?.status !== "pending" || this.expire()) return;
        const review = parseReview(response.message.content, dossier.canRevise);
        if ("error" in review) {
          lastError = review.error;
          continue;
        }
        this.decide(approval, subject, review, model, response.usage.cost);
        return;
      } catch (err) {
        lastError = (err as Error).message;
        if (!(err instanceof ModelError) || (err.kind !== "rate_limited" && err.kind !== "transient")) break;
      }
    }
    // No usable answer: the user decides, as if Away mode were off.
    this.leave(approval, subject, `the approver could not decide: ${lastError}`.slice(0, 300), "none");
  }

  /** Records the verdict, then approves, sends the plan back, or leaves the approval to the user. */
  private decide(approval: ApprovalView, subject: AwayDelegate, review: { verdict: "approve" | "revise" | "escalate"; reason: string; feedback?: string }, model: string, cost: number): void {
    this.deps.store.append([
      {
        type: "away.reviewed",
        run_id: approval.run_id,
        task_id: approval.task_id,
        actor: { kind: "agent", profile: "approver", adapter: "native", model },
        payload: { approval_id: approval.id, subject, verdict: review.verdict, reason: review.reason, model, cost_usd: cost },
      },
    ]);
    if (review.verdict === "escalate") return;
    const actor: Actor = { kind: "agent", profile: "approver", adapter: "native", model };
    try {
      if (review.verdict === "revise") this.deps.orchestrator.decideApproval(approval.id, "approve", review.feedback, actor, undefined, true);
      else this.deps.orchestrator.decideApproval(approval.id, "approve", `approved in Away mode: ${review.reason}`, actor);
    } catch {
      // The user decided in the meantime; their decision stands.
    }
  }

  /** The approval waits for the user. `by`: a rule decided it, or nothing could. */
  private leave(approval: ApprovalView, subject: AwayDelegate, reason: string, by: "rule" | "none"): void {
    this.deps.store.append([
      {
        type: "away.reviewed",
        run_id: approval.run_id,
        task_id: approval.task_id,
        actor: system,
        payload: { approval_id: approval.id, subject, verdict: "escalate", reason, model: by === "rule" ? "rule" : "none", cost_usd: 0 },
      },
    ]);
  }

  private dossier(subject: AwayDelegate, approval: ApprovalView, prompt: string, tasks: TaskRecord[], maxRevisions: number): Dossier {
    const summary = (match: (t: TaskRecord) => boolean) => {
      const t = latest(tasks, match);
      const text = t?.outputs?.summary;
      return typeof text === "string" ? text : (t?.summary ?? undefined);
    };
    const revisions = this.deps.store.revisionsOf(approval.run_id);
    return {
      subject,
      summary: approval.summary,
      prompt,
      ...optional("triage", summary((t) => t.profile === "triager")),
      ...optional("plan", summary((t) => t.profile === "planner" || t.profile === "lead")),
      ...(subject === "pr" ? optional("implementation", summary((t) => t.profile === "implementer")) : {}),
      ...(subject === "pr" ? optional("verification", summary((t) => t.node_id === "verify" || t.uses === "verification.run")) : {}),
      ...(subject === "pr" ? optional("review", summary((t) => t.profile === "reviewer")) : {}),
      canRevise: subject === "plan" && revisions < maxRevisions,
      revisions,
    };
  }
}

/** What an approval is about, when the user can hand it over (ADR 0039); never budgets, merges or picks. */
export function subjectOf(approval: ApprovalView, task: TaskRecord): AwayDelegate | undefined {
  switch (approval.action) {
    case "flow.approval":
      return /(^|\.)approve_plan$/.test(task.node_id) ? "plan" : undefined;
    case "github.pr.create":
      // The approver reviews code changes against an issue; a PR of specs stays with the user (ADR 0048).
      return task.uses === "pr.specs" ? undefined : "pr";
    case "task.start":
    case "team.turn":
    case "team.delegate":
      return "start";
    default:
      return undefined;
  }
}

function latest(tasks: TaskRecord[], match: (t: TaskRecord) => boolean): TaskRecord | undefined {
  return tasks.filter((t) => t.status === "succeeded" && match(t)).sort((a, b) => a.iteration - b.iteration).at(-1);
}

function optional<K extends string>(key: K, value: string | undefined): { [P in K]?: string } {
  return value ? ({ [key]: value } as { [P in K]?: string }) : {};
}
