import type { InboxItemView, QuotaView, SuggestedAction, WorkItemStatus } from "@navarch/contracts";
import { Ban, CircleCheck, CircleDashed, CircleHelp, Copy, GitPullRequestDraft, LoaderCircle, Play, SkipForward, Sparkles } from "@lucide/vue";
import type { StatusLook } from "./status.ts";

/** Inbox helpers (ADR 0021, spec §15.3). Status and action are shown with an icon and a label. */

export const itemLook: Record<WorkItemStatus, StatusLook> = {
  new: { icon: Sparkles, tone: "info" },
  triaged: { icon: CircleDashed, tone: "neutral" },
  in_run: { icon: LoaderCircle, tone: "info", spin: true },
  done: { icon: GitPullRequestDraft, tone: "success" },
  dismissed: { icon: Ban, tone: "muted" },
  closed: { icon: CircleCheck, tone: "muted" },
};

export const actionLook: Record<SuggestedAction, StatusLook> = {
  start_run: { icon: Play, tone: "success" },
  needs_info: { icon: CircleHelp, tone: "warning" },
  duplicate: { icon: Copy, tone: "muted" },
  skip: { icon: SkipForward, tone: "muted" },
};

const ACTION_ORDER: SuggestedAction[] = ["start_run", "needs_info", "duplicate", "skip"];

/** Default order (spec §15.3): by suggested action, then simplest first; untriaged items last. */
export function sortItems(items: InboxItemView[]): InboxItemView[] {
  const rank = (i: InboxItemView) => (i.triage ? ACTION_ORDER.indexOf(i.triage.suggested_action) : ACTION_ORDER.length);
  return [...items].sort((a, b) => rank(a) - rank(b) || (a.triage?.complexity ?? 9) - (b.triage?.complexity ?? 9) || b.updated_at.localeCompare(a.updated_at));
}

export type InboxFilter = { project: string; status: "open" | WorkItemStatus | "all"; kind: string; action: string; text: string };

export function filterItems(items: InboxItemView[], f: InboxFilter): InboxItemView[] {
  const text = f.text.trim().toLowerCase();
  return items.filter(
    (i) =>
      (!f.project || i.project_id === f.project) &&
      (f.status === "all" || (f.status === "open" ? i.status === "new" || i.status === "triaged" : i.status === f.status)) &&
      (!f.kind || i.triage?.kind === f.kind) &&
      (!f.action || i.triage?.suggested_action === f.action) &&
      (!text || i.title.toLowerCase().includes(text) || `#${i.number}` === text),
  );
}

/** The sum of the known estimates and how many items have none (the start dialog's total). */
export function totalEstimate(items: InboxItemView[]): { usd: number; known: number; unknown: number } {
  const known = items.filter((i) => i.estimate);
  return { usd: known.reduce((sum, i) => sum + i.estimate!.usd, 0), known: known.length, unknown: items.length - known.length };
}

/** Items a run can start from: not in a run already, and not closed. */
export function startable(item: InboxItemView): boolean {
  return item.status !== "in_run" && item.status !== "closed";
}

/** Quota rows for Home: one per adapter, its windows in a stable order. */
export function quotaRows(quotas: QuotaView[]): { adapter: string; windows: QuotaView[] }[] {
  const rows = new Map<string, QuotaView[]>();
  for (const q of quotas) rows.set(q.adapter, [...(rows.get(q.adapter) ?? []), q]);
  return [...rows.entries()].map(([adapter, windows]) => ({ adapter, windows }));
}
