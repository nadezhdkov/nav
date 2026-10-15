import type { FleetAgent, NavarchEvent, RunMessage } from "@navarch/contracts";
import { Bot, ClipboardList, Hammer, ScanSearch, SearchCheck } from "@lucide/vue";
import type { Component } from "vue";

/** One icon per agent profile; unknown profiles get a generic agent. */
export const profileIcon: Record<string, Component> = {
  triager: ScanSearch,
  planner: ClipboardList,
  implementer: Hammer,
  reviewer: SearchCheck,
};

export function iconFor(profile: string): Component {
  return profileIcon[profile] ?? Bot;
}

export type ThreadItem =
  | { kind: "progress"; id: string; ts: string; text: string; tool?: string }
  | { kind: "message"; id: string; ts: string; text: string; delivery: RunMessage["delivery"]; delivered: boolean };

/**
 * An agent's activity as one thread in time order: its progress lines and the instructions that
 * were sent to it or reached it (ADR 0019). Untargeted instructions show once they were delivered
 * to this task, or, while they wait, on every agent that has not ended.
 */
export function buildThread(events: readonly NavarchEvent[], messages: readonly RunMessage[], agent: Pick<FleetAgent, "id" | "status">, open: boolean): ThreadItem[] {
  const items: ThreadItem[] = [];
  for (const e of events) {
    if (e.type !== "task.progress" || e.task_id !== agent.id) continue;
    const p = e.payload as { message: string; tool?: string };
    items.push({ kind: "progress", id: e.id, ts: e.ts, text: p.message, ...(p.tool ? { tool: p.tool } : {}) });
  }
  for (const m of messages) {
    const mine = m.delivered ? m.delivered.task_id === agent.id : m.task_id === agent.id || (m.task_id === null && open);
    if (mine) items.push({ kind: "message", id: m.id, ts: m.created_at, text: m.text, delivery: m.delivery, delivered: m.delivered !== null });
  }
  return items.sort((a, b) => a.ts.localeCompare(b.ts));
}

/** `navarch/<run>/<flow>` is long; the flow part is what tells branches apart at a glance. */
export function shortBranch(branch: string | null): string | null {
  if (!branch) return null;
  const parts = branch.split("/");
  return parts.length === 3 ? `${parts[0]}/…/${parts[2]}` : branch;
}
