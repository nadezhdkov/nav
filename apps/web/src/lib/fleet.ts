import type { FleetAgent, NavarchEvent, RunMessage, TaskView, TeamView } from "@navarch/contracts";
import { Bot, ClipboardList, Compass, Container, FlaskConical, Hammer, Palette, ScanSearch, SearchCheck, Server } from "@lucide/vue";
import type { Component } from "vue";

/** One icon per agent profile; unknown profiles get a generic agent. */
export const profileIcon: Record<string, Component> = {
  triager: ScanSearch,
  planner: ClipboardList,
  implementer: Hammer,
  architecture: Compass,
  frontend: Palette,
  backend: Server,
  devops: Container,
  qa: FlaskConical,
  reviewer: SearchCheck,
};

export function iconFor(profile: string): Component {
  return profileIcon[profile] ?? Bot;
}

export type ThreadItem =
  | { kind: "progress"; id: string; ts: string; text: string; tool?: string }
  | { kind: "message"; id: string; ts: string; text: string; delivery: RunMessage["delivery"]; delivered: boolean }
  /** An attempt's final summary or error; `turn` for a lead's turns. */
  | { kind: "result"; id: string; ts: string; text: string; ok: boolean; turn?: number }
  /** Members a lead turn added (lead chat). */
  | { kind: "members"; id: string; ts: string; turn: number; members: { key: string; title: string; profile: string }[] }
  | { kind: "question"; id: string; ts: string; text: string };

/** A lead's answer without its `navarch-team` plan block, which the chat shows as members instead. */
export function withoutPlan(text: string): string {
  return text.replace(/```navarch-team[\s\S]*?(```|$)/g, "").trim();
}

function resultOf(e: NavarchEvent, turn?: number): ThreadItem | null {
  if (e.type !== "task.completed") return null;
  const p = e.payload as { status: string; summary: string };
  const text = turn === undefined ? p.summary : withoutPlan(p.summary);
  if (!text) return null;
  return { kind: "result", id: e.id, ts: e.ts, text, ok: p.status === "succeeded", ...(turn !== undefined ? { turn } : {}) };
}

/**
 * An agent's activity as one thread in time order: its progress lines and the instructions that
 * were sent to it or reached it (ADR 0019). Untargeted instructions show once they were delivered
 * to this task, or, while they wait, on every agent that has not ended.
 */
export function buildThread(events: readonly NavarchEvent[], messages: readonly RunMessage[], agent: Pick<FleetAgent, "id" | "status">, open: boolean): ThreadItem[] {
  const items: ThreadItem[] = [];
  for (const e of events) {
    if (e.task_id !== agent.id) continue;
    const result = resultOf(e);
    if (result) items.push(result);
    if (e.type !== "task.progress") continue;
    const p = e.payload as { message: string; tool?: string };
    items.push({ kind: "progress", id: e.id, ts: e.ts, text: p.message, ...(p.tool ? { tool: p.tool } : {}) });
  }
  for (const m of messages) {
    const mine = m.delivered ? m.delivered.task_id === agent.id : m.task_id === agent.id || (m.task_id === null && open);
    if (mine) items.push({ kind: "message", id: m.id, ts: m.created_at, text: m.text, delivery: m.delivery, delivered: m.delivered !== null });
  }
  return items.sort((a, b) => a.ts.localeCompare(b.ts));
}

/**
 * The lead chat of a team run (slice 10): every lead turn's progress and answer, the members each
 * turn added, the open question, and the user's instructions to the run or to the lead, in one
 * conversation across turns.
 */
export function buildLeadThread(events: readonly NavarchEvent[], messages: readonly RunMessage[], tasks: readonly TaskView[], team: TeamView): ThreadItem[] {
  const leadTurns = new Map(tasks.filter((t) => t.node_id === `${team.node_id}.lead`).map((t) => [t.id, t.iteration]));
  const items: ThreadItem[] = [];
  const turnEnd = new Map<number, string>();
  for (const e of events) {
    const turn = e.task_id ? leadTurns.get(e.task_id) : undefined;
    if (turn === undefined) continue;
    const result = resultOf(e, turn);
    if (result) {
      items.push(result);
      turnEnd.set(turn, e.ts);
    } else if (e.type === "task.progress") {
      const p = e.payload as { message: string; tool?: string };
      items.push({ kind: "progress", id: e.id, ts: e.ts, text: p.message, ...(p.tool ? { tool: p.tool } : {}) });
    }
  }
  const turns = [...new Set(team.members.map((m) => m.turn))];
  for (const turn of turns) {
    const ts = turnEnd.get(turn);
    if (!ts) continue;
    const members = team.members.filter((m) => m.turn === turn).map((m) => ({ key: m.key, title: m.title, profile: m.profile }));
    // Right after the turn's answer: the same timestamp sorts after it (stable sort).
    items.push({ kind: "members", id: `members-${turn}`, ts, turn, members });
  }
  if (team.question) items.push({ kind: "question", id: "question", ts: [...turnEnd.values()].sort().at(-1) ?? "", text: team.question });
  for (const m of messages) {
    const toLead = m.delivered ? leadTurns.has(m.delivered.task_id) : m.task_id === null || leadTurns.has(m.task_id);
    if (toLead) items.push({ kind: "message", id: m.id, ts: m.created_at, text: m.text, delivery: m.delivery, delivered: m.delivered !== null });
  }
  return items.sort((a, b) => a.ts.localeCompare(b.ts));
}

/** `navarch/<run>/<flow>` is long; the flow part is what tells branches apart at a glance. */
export function shortBranch(branch: string | null): string | null {
  if (!branch) return null;
  const parts = branch.split("/");
  return parts.length === 3 ? `${parts[0]}/…/${parts[2]}` : branch;
}
