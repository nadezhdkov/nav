import { isTerminalRun, type WorkItemStatus } from "@navarch/contracts";
import type { WorkItemRecord } from "../events/store.ts";
import { parseComplexity } from "../orchestrator/profiles.ts";

/** Fewer finished runs than this give no estimate: nothing is priced by hand. */
export const MIN_ESTIMATE_RUNS = 3;
const SAMPLE = 20;

/**
 * Cost estimates per complexity (spec §15.3, §19 idea 1): the median cost of the last 20
 * finished `fix-issue` runs whose own triage gave that complexity. `runs` is newest first.
 */
export function estimatesByComplexity(runs: { cost: number; triage: string | null }[]): Map<number, { usd: number; runs: number }> {
  const costs = new Map<number, number[]>();
  for (const run of runs) {
    const complexity = run.triage ? parseComplexity(run.triage) : undefined;
    if (complexity === undefined) continue;
    const list = costs.get(complexity) ?? [];
    if (list.length < SAMPLE) list.push(run.cost);
    costs.set(complexity, list);
  }
  const out = new Map<number, { usd: number; runs: number }>();
  for (const [complexity, list] of costs) {
    if (list.length >= MIN_ESTIMATE_RUNS) out.set(complexity, { usd: round(median(list)), runs: list.length });
  }
  return out;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function round(usd: number): number {
  return Math.round(usd * 10_000) / 10_000;
}

/** An Inbox item's status (spec §8.2), derived from its events and its runs. */
export function itemStatus(item: Pick<WorkItemRecord, "closed" | "dismissed" | "version" | "triage_version" | "runs">): WorkItemStatus {
  if (item.runs.some((r) => r.status === "pr_opened" || r.status === "done")) return "done";
  if (item.runs.some((r) => !isTerminalRun(r.status))) return "in_run";
  if (item.dismissed) return "dismissed";
  if (item.closed) return "closed";
  return item.triage_version === item.version ? "triaged" : "new";
}
