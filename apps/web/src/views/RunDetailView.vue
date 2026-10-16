<script setup lang="ts">
import { ArrowLeft, Ban, CirclePause, ExternalLink, FileText, Play, TriangleAlert } from "@lucide/vue";
import type { TaskStatus } from "@navarch/contracts";
import { computed, onUnmounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { api } from "../api/client.ts";
import { onEvent, onLog, onReconnect, subscribe } from "../api/stream.ts";
import FlowGraph from "../components/FlowGraph.vue";
import InstructionBox from "../components/InstructionBox.vue";
import NodePanel from "../components/NodePanel.vue";
import StatusBadge from "../components/StatusBadge.vue";
import { buildGraph } from "../lib/graph.ts";
import { canCancel, canPause, canResume, money, nodeLook, runLook, runTitle } from "../lib/status.ts";
import { useRunStore } from "../stores/runs.ts";

const props = defineProps<{ id: string }>();
const { t, locale } = useI18n();
const store = useRunStore();
const selected = ref<string | null>(null);
const tab = ref<"timeline" | "logs" | "instruct">("timeline");
const filter = ref("");
const busy = ref(false);
const actionError = ref<string | null>(null);
/** Warnings New run got when it registered this run's repository as a project, passed in the history state. */
const projectWarnings = ref<string[]>([]);

let offs: (() => void)[] = [];
function open(id: string) {
  offs.forEach((off) => off());
  selected.value = null;
  const state = window.history.state as { warnings?: unknown } | null;
  projectWarnings.value = Array.isArray(state?.warnings) ? state.warnings.filter((w): w is string => typeof w === "string") : [];
  offs = [
    subscribe(`run:${id}`),
    onEvent((e) => store.apply(e)),
    onLog((runId, taskId, line) => store.applyLog(runId, taskId, line)),
    onReconnect(() => void store.load(id)),
  ];
  void store.load(id);
  void api.runLogs(id).then(
    (text) => {
      if (store.id === id && !store.logs.length) for (const line of text.split("\n").filter(Boolean)) store.applyLog(id, "", line);
    },
    () => {},
  );
}
watch(() => props.id, open, { immediate: true });
onUnmounted(() => offs.forEach((off) => off()));

const run = computed(() => (store.detail?.id === props.id ? store.detail : null));
const flow = computed(() => run.value?.flow_definition?.definition ?? null);
const params = computed(() => run.value?.flow_definition?.params ?? {});
const selectedNode = computed(() => {
  if (!run.value || !flow.value || !selected.value) return null;
  return buildGraph(flow.value, run.value.tasks, store.skipped, params.value).nodes.find((n) => n.id === selected.value) ?? null;
});
/** Instructions only make sense while the run can still act on them. */
const tabs = computed(() => (run.value && canCancel(run.value.status) ? (["timeline", "logs", "instruct"] as const) : (["timeline", "logs"] as const)));
const eventTypes = computed(() => [...new Set(store.events.map((e) => e.type))].sort());
const shownEvents = computed(() => {
  const list = filter.value ? store.events.filter((e) => e.type === filter.value) : store.events;
  return [...list].reverse();
});

const taskLook = (status: TaskStatus) => nodeLook[status];

function describe(payload: Record<string, unknown>): string {
  const p = payload as { from?: string; to?: string; reason?: string; summary?: string; text?: string; model_id?: string; node_id?: string };
  if (p.from && p.to) return `${p.from} → ${p.to}${p.reason ? ` · ${p.reason}` : ""}`;
  return p.summary ?? p.text ?? p.reason ?? p.model_id ?? p.node_id ?? "";
}

async function act(kind: "cancel" | "resume" | "pause") {
  if (kind === "cancel" && !window.confirm(t("run.confirmCancel"))) return;
  if (kind === "pause" && !window.confirm(t("run.confirmPause"))) return;
  busy.value = true;
  actionError.value = null;
  try {
    await (kind === "cancel" ? api.cancel(props.id) : kind === "pause" ? api.pause(props.id) : api.resume(props.id));
    await store.load(props.id);
  } catch (err) {
    actionError.value = (err as Error).message;
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="flex h-full min-h-0 flex-col">
    <header class="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line bg-surface px-6 py-3 max-md:px-4">
      <RouterLink to="/runs" class="inline-flex items-center gap-1 text-sm text-muted hover:text-fg">
        <ArrowLeft :size="15" aria-hidden="true" />{{ t("run.back") }}
      </RouterLink>
      <template v-if="run">
        <h1 class="min-w-0 flex-1 truncate text-lg font-semibold max-md:order-first max-md:basis-full" :title="run.prompt">{{ runTitle(run) }}</h1>
        <StatusBadge :look="runLook[run.status]" :status="run.status" size="md" />
        <span class="font-mono text-sm" :title="t('run.cost')">{{ money(run.cost_total) }} <span class="text-muted">{{ t("run.budget", { budget: money(run.budget) }) }}</span></span>
        <a v-if="run.pr_url" :href="run.pr_url" target="_blank" rel="noopener noreferrer" class="inline-flex items-center gap-1 text-sm text-accent hover:underline">
          {{ t("run.pr") }}<ExternalLink :size="13" aria-hidden="true" />
        </a>
        <button v-if="canResume(run.status)" :disabled="busy" class="inline-flex min-h-9 items-center gap-1.5 rounded-md border border-line px-3 text-sm hover:bg-surface-2 disabled:opacity-60" @click="act('resume')">
          <Play :size="14" aria-hidden="true" />{{ t(run.status === "failed" ? "run.retry" : "run.resume") }}
        </button>
        <button v-if="canPause(run.status)" :disabled="busy" class="tone-warning inline-flex min-h-9 items-center gap-1.5 rounded-md border px-3 text-sm disabled:opacity-60 max-md:min-h-11" style="color: var(--tone); border-color: color-mix(in srgb, var(--tone) 45%, transparent)" @click="act('pause')">
          <CirclePause :size="14" aria-hidden="true" />{{ t("run.pause") }}
        </button>
        <button v-if="canCancel(run.status)" :disabled="busy" class="tone-danger inline-flex min-h-9 items-center gap-1.5 rounded-md border px-3 text-sm disabled:opacity-60" style="color: var(--tone); border-color: color-mix(in srgb, var(--tone) 45%, transparent)" @click="act('cancel')">
          <Ban :size="14" aria-hidden="true" />{{ t("run.cancel") }}
        </button>
        <ul v-if="run.attachments?.length" class="flex w-full flex-wrap items-center gap-1.5" :aria-label="t('run.attachments')">
          <li v-for="a in run.attachments" :key="a.name" class="inline-flex items-center gap-1 rounded-md border border-line px-2 py-0.5 text-xs text-muted" :title="t('run.attachmentHint')">
            <FileText :size="12" aria-hidden="true" />{{ a.name }}
          </li>
        </ul>
      </template>
      <p v-if="actionError || store.error" class="tone-danger w-full text-sm" style="color: var(--tone)" role="alert">{{ actionError ?? store.error }}</p>
      <p v-for="(w, i) in projectWarnings" :key="i" class="tone-warning flex w-full items-start gap-2 text-sm" role="status">
        <TriangleAlert :size="16" class="mt-0.5 shrink-0" style="color: var(--tone)" aria-hidden="true" />
        <span><strong>{{ t("run.projectWarning") }}</strong> {{ w }}</span>
      </p>
    </header>

    <p v-if="!run" class="p-6 text-muted">{{ t("run.loading") }}</p>
    <template v-else>
      <div class="flex min-h-0 flex-1 max-lg:flex-col max-md:hidden">
        <div class="relative min-h-80 min-w-0 flex-1">
          <FlowGraph v-if="flow" :flow="flow" :params="params" :tasks="run.tasks" :skipped="store.skipped" :selected="selected" @select="selected = $event" />
          <p v-else class="grid-canvas grid h-full place-items-center text-muted">{{ t("run.noFlow") }}</p>
          <p v-if="flow && !selectedNode" class="pointer-events-none absolute top-3 left-4 text-xs text-muted">{{ t("node.select") }}</p>
        </div>
        <div v-if="selectedNode" class="w-96 shrink-0 border-l border-line bg-surface max-lg:h-96 max-lg:w-full max-lg:border-t max-lg:border-l-0">
          <NodePanel :node="selectedNode" :run="run" :events="store.events" @close="selected = null" />
        </div>
      </div>

      <!-- Phones: the tasks as a list (agent, model, cost) instead of the graph. -->
      <ul class="divide-y divide-line border-b border-line bg-surface md:hidden" :aria-label="t('run.graph')">
        <li v-for="task in run.tasks" :key="task.id" class="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-sm">
          <span class="font-medium">{{ task.node_id }}<template v-if="task.iteration > 1"> · {{ task.iteration }}</template></span>
          <StatusBadge :look="taskLook(task.status)" :status="task.status" />
          <span class="w-full truncate font-mono text-xs text-muted">{{ task.adapter }}<template v-if="task.model"> · {{ task.model }}</template> · {{ money(task.cost) }}</span>
        </li>
      </ul>

      <section class="flex h-64 shrink-0 flex-col border-t border-line bg-surface max-md:h-auto max-md:min-h-0 max-md:flex-1 max-md:border-t-0">
        <div class="flex items-center gap-1 border-b border-line px-4 max-md:px-2" role="tablist">
          <button
            v-for="name in tabs"
            :key="name"
            role="tab"
            :aria-selected="tab === name"
            class="min-h-9 shrink-0 border-b-2 px-3 text-sm max-md:min-h-11 max-md:px-2"
            :class="tab === name ? 'border-accent text-fg' : 'border-transparent text-muted hover:text-fg'"
            @click="tab = name"
          >{{ t(`run.${name}`) }}</button>
          <select v-if="tab === 'timeline'" v-model="filter" :aria-label="t('run.filter')" class="ml-auto min-h-8 min-w-0 rounded-md border border-line bg-bg px-2 text-xs max-md:max-w-28">
            <option value="">{{ t("run.allEvents") }}</option>
            <option v-for="type in eventTypes" :key="type" :value="type">{{ type }}</option>
          </select>
        </div>
        <ol v-if="tab === 'timeline'" class="min-h-0 flex-1 overflow-auto px-4 py-2 font-mono text-xs" aria-live="polite">
          <li v-if="!shownEvents.length" class="text-muted">{{ t("run.noEvents") }}</li>
          <li v-for="e in shownEvents" :key="e.id" class="flex gap-3 py-0.5">
            <time :datetime="e.ts" class="shrink-0 text-muted">{{ new Date(e.ts).toLocaleTimeString(locale) }}</time>
            <span class="w-44 shrink-0 truncate text-accent max-md:w-28">{{ e.type }}</span>
            <span class="min-w-0 truncate">{{ describe(e.payload as Record<string, unknown>) }}</span>
          </li>
        </ol>
        <div v-else-if="tab === 'instruct'" class="min-h-0 flex-1 overflow-auto px-4 py-3">
          <InstructionBox :run-id="run.id" />
          <p class="mt-2 text-xs text-muted">{{ t("instruct.fleetHint") }}</p>
        </div>
        <pre v-else class="min-h-0 flex-1 overflow-auto px-4 py-2 font-mono text-xs whitespace-pre-wrap"><template v-if="!store.logs.length">{{ t("run.noLogs") }}</template><template v-for="(l, i) in store.logs" :key="i">{{ l.line }}
</template></pre>
      </section>
    </template>
  </div>
</template>
