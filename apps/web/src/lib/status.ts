import { isTerminalRun, type RunStatus, type RunView } from "@navarch/contracts";
import {
  Ban,
  CircleCheck,
  CircleDashed,
  CirclePause,
  CircleX,
  Clock,
  GitPullRequestDraft,
  Hand,
  LoaderCircle,
  OctagonAlert,
  RotateCcw,
  SkipForward,
  Coins,
} from "@lucide/vue";
import type { Component } from "vue";
import type { NodeState } from "./graph.ts";

/** Status is never shown by color alone (spec §15.4): every tone comes with an icon and a label. */
export type Tone = "neutral" | "info" | "success" | "danger" | "warning" | "muted";
export type StatusLook = { icon: Component; tone: Tone; spin?: boolean };

export const nodeLook: Record<NodeState, StatusLook> = {
  not_started: { icon: CircleDashed, tone: "muted" },
  pending: { icon: Clock, tone: "neutral" },
  ready: { icon: Clock, tone: "neutral" },
  waiting_approval: { icon: Hand, tone: "warning" },
  blocked: { icon: OctagonAlert, tone: "danger" },
  running: { icon: LoaderCircle, tone: "info", spin: true },
  paused: { icon: CirclePause, tone: "warning" },
  succeeded: { icon: CircleCheck, tone: "success" },
  failed: { icon: CircleX, tone: "danger" },
  interrupted: { icon: RotateCcw, tone: "warning" },
  cancelled: { icon: Ban, tone: "muted" },
  skipped: { icon: SkipForward, tone: "muted" },
};

export const runLook: Record<RunStatus, StatusLook> = {
  created: { icon: Clock, tone: "neutral" },
  planning: { icon: LoaderCircle, tone: "info", spin: true },
  awaiting_approval: { icon: Hand, tone: "warning" },
  executing: { icon: LoaderCircle, tone: "info", spin: true },
  verifying: { icon: LoaderCircle, tone: "info", spin: true },
  reviewing: { icon: LoaderCircle, tone: "info", spin: true },
  ready_for_pr: { icon: GitPullRequestDraft, tone: "info" },
  pr_opened: { icon: GitPullRequestDraft, tone: "success" },
  done: { icon: CircleCheck, tone: "success" },
  failed: { icon: CircleX, tone: "danger" },
  cancelled: { icon: Ban, tone: "muted" },
  paused: { icon: CirclePause, tone: "warning" },
  budget_exceeded: { icon: Coins, tone: "danger" },
};

/** Cancel and Resume are offered exactly where the Orchestrator accepts them. */
export function canCancel(status: RunStatus): boolean {
  return !isTerminalRun(status);
}

export function canResume(status: RunStatus): boolean {
  return status === "paused";
}

/** A run can be paused while it is active (ADR 0020); a budget stop waits for a decision instead. */
export function canPause(status: RunStatus): boolean {
  return !isTerminalRun(status) && status !== "paused" && status !== "budget_exceeded";
}

/** `owner/repo#N` for issue runs, then the first line of the prompt. */
export function runTitle(run: RunView): string {
  const line = run.prompt.split("\n").find((l) => l.trim())?.trim() ?? "";
  if (!run.work_item) return line || run.id;
  const ref = `${run.work_item.repo}#${run.work_item.number}`;
  return line ? `${ref} · ${line}` : ref;
}

export function money(n: number): string {
  return `$${n.toFixed(n < 1 ? 3 : 2)}`;
}

export function ago(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86_400)}d`;
}
