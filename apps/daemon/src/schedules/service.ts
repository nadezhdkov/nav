import { isTerminalRun, newId, SCHEDULE_DAYS, type Actor, type FlowSummary, type RunView, type SaveScheduleRequest, type ScheduleDay, type ScheduleView } from "@navarch/contracts";
import type { Config } from "../config.ts";
import type { EventStore, ScheduleRecord } from "../events/store.ts";
import type { PolicyEngine } from "../policy/engine.ts";

const system: Actor = { kind: "system", component: "schedule" };
const TICK_MS = 30_000;
const MINUTE_MS = 60_000;

export class ScheduleError extends Error {
  readonly code: "not_found" | "forbidden" | "invalid";

  constructor(code: ScheduleError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

export interface ScheduleDeps {
  config: Config;
  store: EventStore;
  policy: PolicyEngine;
  startRun: (req: { repo_path: string; prompt: string; flow?: string; budget: number }, actor: Actor) => Promise<RunView>;
  /** The Flows a run can be started from, to refuse one that needs an issue or a pull request. */
  flows: () => FlowSummary[];
  now?: () => Date;
}

/** `YYYY-MM-DD HH:MM` in the PC's local time: the name of a slot, sortable as text. */
export function slotName(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const dayOf = (d: Date): ScheduleDay => SCHEDULE_DAYS[(d.getDay() + 6) % 7]!;

/** The slot of `at` on the local day of `day`. */
function slotOn(day: Date, at: string): Date {
  const [h, m] = at.split(":").map(Number);
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), h ?? 0, m ?? 0, 0, 0);
}

/** The latest slot of the timetable that is not after `now`, looking back a week. */
export function latestSlot(days: ScheduleDay[], at: string, now: Date): Date | undefined {
  for (let back = 0; back < 8; back++) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() - back);
    if (!days.includes(dayOf(day))) continue;
    const slot = slotOn(day, at);
    if (slot.getTime() <= now.getTime()) return slot;
  }
  return undefined;
}

/** The first slot after `now`. */
export function nextSlot(days: ScheduleDay[], at: string, now: Date): Date | undefined {
  for (let ahead = 0; ahead < 8; ahead++) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + ahead);
    if (!days.includes(dayOf(day))) continue;
    const slot = slotOn(day, at);
    if (slot.getTime() > now.getTime()) return slot;
  }
  return undefined;
}

/**
 * Scheduled runs (spec §7.4, UC-14, ADR 0064). The user sets a timetable for a prompt in a registered
 * project (`schedule.set` is the user's only, never a phone's or an agent's); at each slot the daemon
 * starts a run with the budget the user gave, through the same `startRun` as any other run, so autonomy
 * levels, approvals and budgets apply. Only the latest slot is considered, so a daemon that was off does
 * not start a backlog, and a slot is started once.
 */
export class ScheduleService {
  private readonly deps: ScheduleDeps;
  private timer: NodeJS.Timeout | undefined;
  private ticking: Promise<void> | undefined;

  constructor(deps: ScheduleDeps) {
    this.deps = deps;
  }

  start(): void {
    if (!this.deps.config.schedules.enabled) return;
    this.timer = setInterval(() => void this.tick().catch(() => {}), TICK_MS);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.ticking?.catch(() => {});
  }

  list(): ScheduleView[] {
    return this.deps.store.schedules().map((s) => this.view(s));
  }

  save(id: string | undefined, req: SaveScheduleRequest, actor: Actor): ScheduleView {
    this.allow(actor, id ?? "new");
    const { store } = this.deps;
    if (id && !store.schedule(id)) throw new ScheduleError("not_found", `schedule ${id} not found`);
    const project = store.getProject(req.project_id);
    if (!project || project.removed_at) throw new ScheduleError("not_found", `project ${req.project_id} not found`);
    const flow = req.flow ?? "task";
    const known = this.deps.flows().find((f) => f.name === flow);
    if (!known) throw new ScheduleError("invalid", `no Flow named ${flow}`);
    if (known.needs !== "prompt") throw new ScheduleError("invalid", `Flow ${flow} needs ${known.needs}; a schedule starts runs from a prompt`);
    if (flow === "compete") throw new ScheduleError("invalid", "Compete is parked and cannot be scheduled");
    const scheduleId = id ?? newId("sch");
    store.append([
      {
        type: "schedule.saved",
        run_id: null,
        task_id: null,
        actor,
        payload: { schedule_id: scheduleId, project_id: req.project_id, name: req.name, prompt: req.prompt, flow: req.flow ?? null, budget: req.budget, at: req.at, days: [...new Set(req.days)], enabled: req.enabled },
      },
    ]);
    return this.view(store.schedule(scheduleId)!);
  }

  setEnabled(id: string, enabled: boolean, actor: Actor): ScheduleView {
    const s = this.deps.store.schedule(id);
    if (!s) throw new ScheduleError("not_found", `schedule ${id} not found`);
    return this.save(id, { name: s.name, project_id: s.project_id, prompt: s.prompt, ...(s.flow ? { flow: s.flow } : {}), budget: s.budget, at: s.at, days: s.days, enabled }, actor);
  }

  remove(id: string, actor: Actor): void {
    this.allow(actor, id);
    if (!this.deps.store.schedule(id)) throw new ScheduleError("not_found", `schedule ${id} not found`);
    this.deps.store.append([{ type: "schedule.removed", run_id: null, task_id: null, actor, payload: { schedule_id: id } }]);
  }

  /** Looks at every enabled schedule once; one at a time. */
  tick(): Promise<void> {
    this.ticking ??= this.look().finally(() => (this.ticking = undefined));
    return this.ticking;
  }

  private async look(): Promise<void> {
    const now = this.deps.now?.() ?? new Date();
    for (const s of this.deps.store.schedules()) {
      if (!s.enabled) continue;
      const slot = latestSlot(s.days, s.at, now);
      if (!slot) continue;
      const name = slotName(slot);
      // Never a slot before the user last saved it, and never one already looked at.
      if (slot.getTime() <= Date.parse(s.saved_at)) continue;
      if (s.last_slot !== null && s.last_slot >= name) continue;
      if (now.getTime() - slot.getTime() > this.deps.config.schedules.grace_minutes * MINUTE_MS) {
        this.skip(s, name, "missed", "the daemon was not running at that time");
        continue;
      }
      await this.fire(s, name, now);
    }
  }

  private async fire(s: ScheduleRecord, slot: string, now: Date): Promise<void> {
    const { store, config, policy } = this.deps;
    const project = store.getProject(s.project_id);
    if (!project || project.removed_at) return this.skip(s, slot, "project_removed", "the project is no longer registered");
    const last = s.last_run_id ? store.getRun(s.last_run_id) : undefined;
    if (last && !isTerminalRun(last.status)) return this.skip(s, slot, "still_running", `the run of the previous slot (${last.name}) has not finished`);
    const since = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const decision = policy.decide(system, "schedule.run", s.id, {
      autonomyLevel: config.autonomy_level,
      usage: { items: store.scheduleRunsSince(since), usd: 0 },
      cap: { items: config.schedules.daily_runs, usd: 0 },
    });
    if (decision.effect !== "allow") return this.skip(s, slot, "daily_cap", decision.reason);
    try {
      const run = await this.deps.startRun({ repo_path: project.path, prompt: s.prompt, ...(s.flow ? { flow: s.flow } : {}), budget: s.budget }, system);
      store.append([{ type: "schedule.fired", run_id: run.id, task_id: null, actor: system, payload: { schedule_id: s.id, slot, run_id: run.id } }]);
    } catch (err) {
      this.skip(s, slot, "failed", (err as Error).message.slice(0, 300));
    }
  }

  private skip(s: ScheduleRecord, slot: string, reason: "missed" | "still_running" | "daily_cap" | "refused" | "failed" | "project_removed", message: string): void {
    this.deps.store.append([{ type: "schedule.skipped", run_id: null, task_id: null, actor: system, payload: { schedule_id: s.id, slot, reason, message } }]);
  }

  private allow(actor: Actor, resource: string): void {
    const decision = this.deps.policy.decide(actor, "schedule.set", resource, { autonomyLevel: this.deps.config.autonomy_level });
    if (decision.effect !== "allow") throw new ScheduleError("forbidden", decision.reason);
  }

  private view(s: ScheduleRecord): ScheduleView {
    const project = this.deps.store.getProject(s.project_id);
    const next = s.enabled ? nextSlot(s.days, s.at, this.deps.now?.() ?? new Date()) : undefined;
    return {
      id: s.id,
      name: s.name,
      project_id: s.project_id,
      repo: project?.repo ?? null,
      prompt: s.prompt,
      flow: s.flow,
      budget: s.budget,
      at: s.at,
      days: s.days,
      enabled: s.enabled,
      next_at: next ? next.toISOString() : null,
      last_slot: s.last_slot,
      last_outcome: s.last_outcome as ScheduleView["last_outcome"],
      last_run_id: s.last_run_id,
      last_message: s.last_message,
    };
  }
}
