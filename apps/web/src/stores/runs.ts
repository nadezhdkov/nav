import type { ApprovalView, FleetView, FleetWindow, InboxView, NavarchEvent, ProjectView, QuotaView, RunDetail, RunView, UsageView } from "@navarch/contracts";
import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { api } from "../api/client.ts";

/**
 * Stores keep what the Core reports and refetch when the stream says it changed; they never
 * derive run or task state themselves (architecture rule 2: state comes from the event log).
 */

const REFETCH_MS = 250;

function debounced(fn: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return () => {
    clearTimeout(timer);
    timer = setTimeout(fn, REFETCH_MS);
  };
}

export const useRunsStore = defineStore("runs", () => {
  const runs = ref<RunView[]>([]);
  const loaded = ref(false);
  const error = ref<string | null>(null);

  async function load() {
    try {
      runs.value = await api.runs();
      error.value = null;
    } catch (err) {
      error.value = (err as Error).message;
    } finally {
      loaded.value = true;
    }
  }

  const refetch = debounced(() => void load());
  function apply(event: NavarchEvent) {
    if (event.type.startsWith("run.") || event.type === "task.completed" || event.type === "github.pr.opened") refetch();
  }

  return { runs, loaded, error, load, apply };
});

export const useApprovalsStore = defineStore("approvals", () => {
  const approvals = ref<ApprovalView[]>([]);
  const loaded = ref(false);
  const error = ref<string | null>(null);
  const pending = computed(() => approvals.value.filter((a) => a.status === "pending"));

  async function load() {
    try {
      approvals.value = await api.approvals();
      error.value = null;
    } catch (err) {
      error.value = (err as Error).message;
    } finally {
      loaded.value = true;
    }
  }

  async function decide(id: string, decision: "approve" | "reject", reason?: string) {
    await api.decide(id, decision, reason);
    await load();
  }

  const refetch = debounced(() => void load());
  function apply(event: NavarchEvent) {
    if (event.type.startsWith("approval.") || event.type === "run.status_changed") refetch();
  }

  return { approvals, pending, loaded, error, load, decide, apply };
});

const MAX_LOG_LINES = 2_000;

export const useRunStore = defineStore("run", () => {
  const id = ref<string | null>(null);
  const detail = ref<RunDetail | null>(null);
  const events = ref<NavarchEvent[]>([]);
  const logs = ref<{ task_id: string; line: string }[]>([]);
  const error = ref<string | null>(null);

  async function load(runId: string) {
    if (id.value !== runId) {
      id.value = runId;
      detail.value = null;
      events.value = [];
      logs.value = [];
    }
    try {
      const after = events.value.at(-1)?.seq ?? 0;
      const [d, evs] = await Promise.all([api.run(runId), api.runEvents(runId, after)]);
      if (id.value !== runId) return;
      detail.value = d;
      addEvents(evs);
      error.value = null;
    } catch (err) {
      error.value = (err as Error).message;
    }
  }

  function addEvents(evs: readonly NavarchEvent[]) {
    const last = events.value.at(-1)?.seq ?? 0;
    const fresh = evs.filter((e) => e.seq > last);
    if (fresh.length) events.value = [...events.value, ...fresh];
  }

  const refetch = debounced(() => {
    if (id.value) void load(id.value);
  });

  /** `seq` is global, so the timeline always comes from the REST log (`after` the last seq it has). */
  function apply(event: NavarchEvent) {
    if (id.value && event.run_id === id.value) refetch();
  }

  function applyLog(runId: string, taskId: string, line: string) {
    if (runId !== id.value) return;
    const next = [...logs.value, { task_id: taskId, line }];
    logs.value = next.length > MAX_LOG_LINES ? next.slice(-MAX_LOG_LINES) : next;
  }

  /** Nodes the Flow skipped (`when` was false); they have no task. */
  const skipped = computed(() =>
    events.value.filter((e) => e.type === "flow.node.skipped").map((e) => (e.payload as { node_id: string }).node_id),
  );

  return { id, detail, events, logs, error, skipped, load, apply, applyLog };
});

/** The Fleet view (ADR 0019): every agent of recent runs, refetched when the stream reports a change. */
export const useFleetStore = defineStore("fleet", () => {
  const view = ref<FleetView | null>(null);
  const span = ref<FleetWindow>("active");
  const error = ref<string | null>(null);
  const running = computed(() => view.value?.counts.running ?? 0);

  async function load() {
    try {
      view.value = await api.fleet(span.value);
      error.value = null;
    } catch (err) {
      error.value = (err as Error).message;
    }
  }

  function setSpan(next: FleetWindow) {
    span.value = next;
    void load();
  }

  const refetch = debounced(() => void load());
  function apply(event: NavarchEvent) {
    if (/^(run|task|approval|model)\./.test(event.type)) refetch();
  }

  return { view, span, error, running, load, setSpan, apply };
});

/** The Inbox (ADR 0021): every item the API returns; the view filters them. */
export const useInboxStore = defineStore("inbox", () => {
  const view = ref<InboxView | null>(null);
  const error = ref<string | null>(null);
  /** Items that need a decision: new or triaged. */
  const open = computed(() => (view.value?.items ?? []).filter((i) => i.status === "new" || i.status === "triaged"));

  async function load() {
    try {
      view.value = await api.inbox();
      error.value = null;
    } catch (err) {
      error.value = (err as Error).message;
    }
  }

  const refetch = debounced(() => void load());
  function apply(event: NavarchEvent) {
    if (/^(workitem|inbox|project)\./.test(event.type) || event.type === "run.created" || event.type === "run.status_changed") refetch();
  }

  return { view, open, error, load, apply };
});

/** Registered projects and agents' quota windows, for the sidebar and Home. */
export const useProjectsStore = defineStore("projects", () => {
  const projects = ref<ProjectView[]>([]);
  const quotas = ref<QuotaView[]>([]);
  const error = ref<string | null>(null);

  async function load() {
    try {
      [projects.value, quotas.value] = await Promise.all([api.projects(), api.quotas()]);
      error.value = null;
    } catch (err) {
      error.value = (err as Error).message;
    }
  }

  const refetch = debounced(() => void load());
  function apply(event: NavarchEvent) {
    if (/^(project|inbox|workitem)\./.test(event.type) || event.type === "quota.observed" || event.type === "run.created" || event.type === "run.status_changed") refetch();
  }

  return { projects, quotas, error, load, apply };
});

/** Budgets, spend and observed metrics per model (ADR 0023), for Usage and Home's cost card. */
export const useUsageStore = defineStore("usage", () => {
  const view = ref<UsageView | null>(null);
  const days = ref(30);
  const profile = ref<string | null>(null);
  const error = ref<string | null>(null);

  async function load() {
    try {
      view.value = await api.usage(days.value, profile.value ?? undefined);
      error.value = null;
    } catch (err) {
      error.value = (err as Error).message;
    }
  }

  const refetch = debounced(() => void load());
  function apply(event: NavarchEvent) {
    if (/^budget\./.test(event.type) || ["model.call.completed", "task.completed", "quota.observed", "workitem.triaged", "run.created"].includes(event.type)) refetch();
  }

  return { view, days, profile, error, load, apply };
});
