import type { ScheduleView, ApprovalView, AwayView, CiFailureView, MorningSummary, SetAwayRequest, FleetView, FleetWindow, InboxView, NavarchEvent, ProjectView, QuotaView, RunDetail, RunView, UsageView, MetricsView, SpecRunView, SpecAddendumRunView, PrinciplesView } from "@navarch/contracts";
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

  async function decide(id: string, decision: "approve" | "reject", reason?: string, choice?: string) {
    await (choice === undefined ? api.decide(id, decision, reason) : api.decide(id, decision, reason, choice));
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

/** CI failures noticed on open pull requests (ADR 0041): the open ones, for Home. */
export const useCiStore = defineStore("ci", () => {
  const failures = ref<CiFailureView[]>([]);
  const error = ref<string | null>(null);

  async function load() {
    try {
      failures.value = await api.ciFailures();
      error.value = null;
    } catch (err) {
      error.value = (err as Error).message;
    }
  }

  const refetch = debounced(() => void load());
  function apply(event: NavarchEvent) {
    if (event.type.startsWith("ci.failure.")) refetch();
  }

  return { failures, error, load, apply };
});

/** The latest morning summary (ADR 0059), for Home. */
export const useSummaryStore = defineStore("summary", () => {
  const summary = ref<MorningSummary | null>(null);
  const error = ref<string | null>(null);

  async function load() {
    try {
      summary.value = await api.summary();
      error.value = null;
    } catch (err) {
      error.value = (err as Error).message;
    }
  }

  async function make() {
    summary.value = await api.makeSummary();
  }

  function apply(event: NavarchEvent) {
    if (event.type === "summary.generated") summary.value = (event as NavarchEvent<"summary.generated">).payload;
  }

  return { summary, error, load, make, apply };
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
/**
 * The cost and quality panels (ADR 0037). Nothing is fetched before the Usage screen opens their
 * tab (`open`); after that, `load` and events keep the view fresh like the other stores.
 */
export const useMetricsStore = defineStore("metrics", () => {
  const view = ref<MetricsView | null>(null);
  const days = ref(30);
  const error = ref<string | null>(null);
  let wanted = false;

  async function open() {
    wanted = true;
    await load();
  }

  async function load() {
    if (!wanted) return;
    try {
      view.value = await api.metrics(days.value);
      error.value = null;
    } catch (err) {
      error.value = (err as Error).message;
    }
  }

  const refetch = debounced(() => void load());
  function apply(event: NavarchEvent) {
    if (/^github\.pr\./.test(event.type) || ["model.call.completed", "task.completed", "workitem.triaged"].includes(event.type)) refetch();
  }

  return { view, days, error, open, load, apply };
});

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

/** Specs (ADR 0053): what `reverse-spec` runs wrote and the addenda `spec-sync` runs added after merges. */
export const useSpecsStore = defineStore("specs", () => {
  const extractions = ref<SpecRunView[]>([]);
  const addenda = ref<SpecAddendumRunView[]>([]);
  const loaded = ref(false);
  const error = ref<string | null>(null);

  async function load() {
    try {
      [extractions.value, addenda.value] = await Promise.all([api.specs(), api.specAddenda()]);
      error.value = null;
    } catch (err) {
      error.value = (err as Error).message;
    } finally {
      loaded.value = true;
    }
  }

  const refetch = debounced(() => void load());
  function apply(event: NavarchEvent) {
    if (event.type === "spec.generated" || event.type === "spec.addendum.written") refetch();
  }

  return { extractions, addenda, loaded, error, load, apply };
});

/** Project rules and the ones agents proposed (ADR 0047, 0056, 0057), per project. */
export const usePrinciplesStore = defineStore("principles", () => {
  const byProject = ref<Record<string, PrinciplesView>>({});
  const loaded = ref(false);
  const error = ref<string | null>(null);

  async function load() {
    try {
      const projects = await api.projects();
      const views = await Promise.all(projects.map((p) => api.principles(p.id)));
      byProject.value = Object.fromEntries(views.map((v) => [v.project_id, v]));
      error.value = null;
    } catch (err) {
      error.value = (err as Error).message;
    } finally {
      loaded.value = true;
    }
  }

  async function decide(projectId: string, proposalId: string, decision: "accept" | "dismiss") {
    let refused: string | null = null;
    try {
      if (decision === "accept") await api.acceptProposal(projectId, proposalId);
      else await api.dismissProposal(projectId, proposalId);
    } catch (err) {
      refused = (err as Error).message;
    }
    await load();
    if (refused) error.value = refused;
  }

  const pending = computed(() => Object.values(byProject.value).reduce((n, v) => n + v.proposals.length, 0));
  const refetch = debounced(() => void load());
  function apply(event: NavarchEvent) {
    if (/^(principle|project)\./.test(event.type)) refetch();
  }

  return { byProject, loaded, error, pending, load, decide, apply };
});

/** Away mode (ADR 0039): whether an approver agent decides approvals, and what it did. */
export const useAwayStore = defineStore("away", () => {
  const view = ref<AwayView | null>(null);
  const error = ref<string | null>(null);

  async function load() {
    try {
      view.value = await api.away();
      error.value = null;
    } catch (err) {
      error.value = (err as Error).message;
    }
  }

  async function set(body: SetAwayRequest) {
    view.value = await api.setAway(body);
  }

  const refetch = debounced(() => void load());
  function apply(event: NavarchEvent) {
    if (event.type.startsWith("away.")) refetch();
  }

  const active = computed(() => view.value?.active === true);
  return { view, error, active, load, set, apply };
});

export const useSchedulesStore = defineStore("schedules", () => {
  const list = ref<ScheduleView[]>([]);
  const loaded = ref(false);
  const error = ref<string | null>(null);

  async function load() {
    try {
      list.value = await api.schedules();
      error.value = null;
    } catch (err) {
      error.value = (err as Error).message;
    } finally {
      loaded.value = true;
    }
  }

  const refetch = debounced(() => void load());
  function apply(event: NavarchEvent) {
    if (event.type.startsWith("schedule.")) refetch();
  }

  return { list, loaded, error, load, apply };
});
