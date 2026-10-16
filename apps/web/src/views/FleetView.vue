<script setup lang="ts">
import { reachable } from "../api/client.ts";
import type { FleetRun } from "@navarch/contracts";
import { ChevronsDownUp, ChevronsUpDown, CircleCheck, CircleX, Hand, LayoutGrid, LoaderCircle, Maximize, Network, Ship } from "@lucide/vue";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { useI18n } from "vue-i18n";
import AgentCard from "../components/AgentCard.vue";
import AgentPanel from "../components/AgentPanel.vue";
import FleetTree from "../components/FleetTree.vue";
import KillSwitch from "../components/KillSwitch.vue";
import StatusBadge from "../components/StatusBadge.vue";
import { agentNodeId, runIds } from "../lib/fleetTree.ts";
import { money, runLook, runTitle } from "../lib/status.ts";
import { useFleetStore, useProjectsStore } from "../stores/runs.ts";

/**
 * Every agent at work across runs (ADR 0019): a tree on a canvas on desktop (slice 10) or cards
 * grouped by run, with a panel to follow one agent.
 */
const { t } = useI18n();
const store = useFleetStore();
const projects = useProjectsStore();
/** By node, not task: a fix loop replaces a node's task with the next iteration's, and the panel follows it. */
const selected = ref<{ run: string; node: string } | null>(null);

onMounted(() => void store.load());

// Tree is offered on wide screens only; the choice is remembered per browser.
const LAYOUT_KEY = "navarch.fleet.layout";
const wideQuery = typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia("(min-width: 769px)") : null;
const wide = ref(wideQuery?.matches ?? false);
const onWide = (e: MediaQueryListEvent) => (wide.value = e.matches);
wideQuery?.addEventListener?.("change", onWide);
onBeforeUnmount(() => wideQuery?.removeEventListener?.("change", onWide));
function storedLayout(): "tree" | "cards" {
  try {
    return localStorage.getItem(LAYOUT_KEY) === "cards" ? "cards" : "tree";
  } catch {
    return "tree";
  }
}
const chosen = ref<"tree" | "cards">(storedLayout());
const layout = computed(() => (wide.value ? chosen.value : "cards"));
function setLayout(next: "tree" | "cards") {
  chosen.value = next;
  try {
    localStorage.setItem(LAYOUT_KEY, next);
  } catch {
    // Storage may be unavailable (private window); the choice then lasts for this visit.
  }
}

// `?agent=<task id>` (the sidebar's project tree) opens that agent's panel once the view has it.
const route = useRoute();
let opened: string | null = null;
watch(
  [() => route?.query.agent, () => store.view],
  ([agent]) => {
    if (typeof agent !== "string" || agent === opened) return;
    const run = store.view?.runs.find((r) => r.agents.some((a) => a.id === agent));
    const node = run?.agents.find((a) => a.id === agent)?.node_id;
    if (!run || !node) return;
    opened = agent;
    selected.value = { run: run.id, node };
  },
  { immediate: true },
);

const runs = computed(() => store.view?.runs ?? []);
const current = computed(() => {
  const sel = selected.value;
  const run = sel ? runs.value.find((r) => r.id === sel.run) : undefined;
  const agent = run?.agents.find((a) => a.node_id === sel!.node);
  return run && agent ? { run, agent } : null;
});

function select(run: FleetRun, node: string) {
  selected.value = selected.value?.run === run.id && selected.value.node === node ? null : { run: run.id, node };
}

// Tree folding: runs folded by the user, and lead sub-agent groups opened by the user.
const collapsed = ref(new Set<string>());
const expanded = ref(new Set<string>());
function toggle(id: string) {
  const target = id.startsWith("run:") ? collapsed : expanded;
  const next = new Set(target.value);
  if (!next.delete(id)) next.add(id);
  target.value = next;
}
const allCollapsed = computed(() => runs.value.length > 0 && runIds(store.view).every((id) => collapsed.value.has(id)));
function foldAll() {
  collapsed.value = allCollapsed.value ? new Set() : new Set(runIds(store.view));
  // The tree changes size; refit once it is laid out again.
  void nextTick(() => setTimeout(() => treeRef.value?.fit(), 50));
}
const treeRef = ref<InstanceType<typeof FleetTree> | null>(null);

function openAgent(runId: string, node: string) {
  const run = runs.value.find((r) => r.id === runId);
  if (run?.agents.some((a) => a.node_id === node)) selected.value = { run: runId, node };
}

const counts = computed(() => [
  { key: "running", icon: LoaderCircle, tone: "info", n: store.view?.counts.running ?? 0 },
  { key: "waiting", icon: Hand, tone: "warning", n: store.view?.counts.waiting ?? 0 },
  { key: "failed", icon: CircleX, tone: "danger", n: store.view?.counts.failed ?? 0 },
  { key: "done", icon: CircleCheck, tone: "success", n: store.view?.counts.done ?? 0 },
]);
</script>

<template>
  <div class="flex h-full min-h-0">
    <div class="flex min-w-0 flex-1 flex-col" :class="{ 'max-md:hidden': current, 'overflow-auto': layout === 'cards' }">
      <header class="sticky top-0 z-10 flex flex-wrap items-center gap-x-6 gap-y-3 border-b border-line bg-bg/90 px-6 py-4 backdrop-blur max-md:px-4">
        <h1 class="flex items-center gap-2 text-xl font-semibold"><Ship :size="20" class="text-accent" aria-hidden="true" />{{ t("fleet.title") }}</h1>
        <ul class="flex flex-wrap gap-x-4 gap-y-1 text-sm" :aria-label="t('fleet.summary')">
          <li v-for="c in counts" :key="c.key" class="inline-flex items-center gap-1.5" :class="`tone-${c.tone}`">
            <component :is="c.icon" :size="14" style="color: var(--tone)" aria-hidden="true" />
            <span class="font-semibold">{{ c.n }}</span><span class="text-muted">{{ t(`fleet.count.${c.key}`) }}</span>
          </li>
        </ul>
        <div class="ml-auto flex flex-wrap items-center gap-2">
          <div v-if="wide" class="inline-flex rounded-md border border-line p-0.5 text-sm" role="radiogroup" :aria-label="t('tree.layout')">
            <button
              v-for="l in [{ key: 'tree', icon: Network }, { key: 'cards', icon: LayoutGrid }] as const"
              :key="l.key"
              role="radio"
              :aria-checked="layout === l.key"
              class="inline-flex min-h-8 items-center gap-1.5 rounded px-3"
              :class="layout === l.key ? 'bg-surface-2 text-fg' : 'text-muted hover:text-fg'"
              @click="setLayout(l.key)"
            ><component :is="l.icon" :size="14" aria-hidden="true" />{{ t(`tree.layouts.${l.key}`) }}</button>
          </div>
          <div class="inline-flex rounded-md border border-line p-0.5 text-sm" role="radiogroup" :aria-label="t('fleet.span')">
            <button
              v-for="s in ['active', '24h'] as const"
              :key="s"
              role="radio"
              :aria-checked="store.span === s"
              class="min-h-8 rounded px-3"
              :class="store.span === s ? 'bg-surface-2 text-fg' : 'text-muted hover:text-fg'"
              @click="store.setSpan(s)"
            >{{ t(`fleet.spans.${s}`) }}</button>
          </div>
        </div>
      </header>

      <div v-if="layout === 'tree' && runs.length" class="flex flex-wrap items-center gap-2 border-b border-line px-6 py-2 text-sm" role="toolbar" :aria-label="t('tree.actions')">
        <button type="button" class="inline-flex min-h-8 items-center gap-1.5 rounded-md border border-line px-3 hover:bg-surface-2" @click="treeRef?.fit()">
          <Maximize :size="14" aria-hidden="true" />{{ t("tree.fit") }}
        </button>
        <button type="button" class="inline-flex min-h-8 items-center gap-1.5 rounded-md border border-line px-3 hover:bg-surface-2" @click="foldAll">
          <component :is="allCollapsed ? ChevronsUpDown : ChevronsDownUp" :size="14" aria-hidden="true" />{{ allCollapsed ? t("tree.expandAll") : t("tree.collapseAll") }}
        </button>
        <span class="text-xs text-muted max-lg:hidden">{{ t("tree.keys") }}</span>
        <KillSwitch compact class="ml-auto [&_button]:min-h-8 [&_button]:px-3" />
      </div>

      <template v-if="store.error">
        <!-- Unreachable: App shows why; repeating the raw error here would only add noise. -->
        <p v-if="reachable" class="tone-danger px-6 py-3 text-sm" style="color: var(--tone)" role="alert">{{ store.error }}</p>
      </template>
      <p v-else-if="!store.view" class="px-6 py-6 text-muted">{{ t("fleet.loading") }}</p>
      <p v-else-if="!runs.length" class="px-6 py-6 text-muted">{{ t("fleet.empty") }}</p>

      <div v-else-if="layout === 'tree'" class="min-h-0 flex-1">
        <FleetTree
          ref="treeRef"
          :view="store.view"
          :projects="projects.projects"
          :collapsed="collapsed"
          :expanded="expanded"
          :selected="current ? agentNodeId(current.run.id, current.agent.node_id) : null"
          @toggle="toggle"
          @open="openAgent"
          @close="selected = null"
        />
      </div>

      <template v-else>
        <section v-for="run in runs" :key="run.id" class="border-b border-line px-6 py-5 max-md:px-4" :aria-labelledby="`fleet-${run.id}`">
          <div class="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <RouterLink :id="`fleet-${run.id}`" :to="`/runs/${run.id}`" class="min-w-0 truncate font-semibold hover:text-accent" :title="run.prompt">{{ runTitle(run) }}</RouterLink>
            <StatusBadge :look="runLook[run.status]" :status="run.status" />
            <span class="text-xs text-muted">{{ run.flow ?? "–" }} · {{ run.repo_path.split("/").pop() }}<template v-if="run.progress"> · {{ t("tree.progress", { done: run.progress.done, total: run.progress.total }) }}</template></span>
            <span class="ml-auto font-mono text-xs">{{ money(run.cost_total) }} <span class="text-muted">{{ t("run.budget", { budget: money(run.budget) }) }}</span></span>
          </div>
          <p v-if="!run.agents.length" class="text-sm text-muted">{{ t("fleet.noAgents") }}</p>
          <div class="grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-3">
            <AgentCard
              v-for="agent in run.agents"
              :key="agent.id"
              :agent="agent"
              :selected="current?.agent.id === agent.id"
              @select="select(run, agent.node_id)"
            />
          </div>
        </section>
      </template>
    </div>

    <div v-if="current" class="w-[26rem] shrink-0 border-l border-line bg-surface max-md:w-full max-md:border-l-0">
      <AgentPanel :agent="current.agent" :run="current.run" :version="store.view?.generated_at ?? ''" @close="selected = null" />
    </div>
  </div>
</template>
