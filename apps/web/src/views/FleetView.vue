<script setup lang="ts">
import type { FleetRun } from "@navarch/contracts";
import { CircleCheck, CircleX, Hand, LoaderCircle, Ship } from "@lucide/vue";
import { computed, onMounted, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { useI18n } from "vue-i18n";
import AgentCard from "../components/AgentCard.vue";
import AgentPanel from "../components/AgentPanel.vue";
import StatusBadge from "../components/StatusBadge.vue";
import { money, runLook, runTitle } from "../lib/status.ts";
import { useFleetStore } from "../stores/runs.ts";

/** Every agent at work across runs (ADR 0019), grouped by run, with a panel to follow one. */
const { t } = useI18n();
const store = useFleetStore();
/** By node, not task: a fix loop replaces a node's task with the next iteration's, and the panel follows it. */
const selected = ref<{ run: string; node: string } | null>(null);

onMounted(() => void store.load());

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

const counts = computed(() => [
  { key: "running", icon: LoaderCircle, tone: "info", n: store.view?.counts.running ?? 0 },
  { key: "waiting", icon: Hand, tone: "warning", n: store.view?.counts.waiting ?? 0 },
  { key: "failed", icon: CircleX, tone: "danger", n: store.view?.counts.failed ?? 0 },
  { key: "done", icon: CircleCheck, tone: "success", n: store.view?.counts.done ?? 0 },
]);
</script>

<template>
  <div class="flex h-full min-h-0">
    <div class="min-w-0 flex-1 overflow-auto" :class="{ 'max-md:hidden': current }">
      <header class="sticky top-0 z-10 flex flex-wrap items-center gap-x-6 gap-y-3 border-b border-line bg-bg/90 px-6 py-4 backdrop-blur max-md:px-4">
        <h1 class="flex items-center gap-2 text-xl font-semibold"><Ship :size="20" class="text-accent" aria-hidden="true" />{{ t("fleet.title") }}</h1>
        <ul class="flex flex-wrap gap-x-4 gap-y-1 text-sm" :aria-label="t('fleet.summary')">
          <li v-for="c in counts" :key="c.key" class="inline-flex items-center gap-1.5" :class="`tone-${c.tone}`">
            <component :is="c.icon" :size="14" style="color: var(--tone)" aria-hidden="true" />
            <span class="font-semibold">{{ c.n }}</span><span class="text-muted">{{ t(`fleet.count.${c.key}`) }}</span>
          </li>
        </ul>
        <div class="ml-auto inline-flex rounded-md border border-line p-0.5 text-sm" role="radiogroup" :aria-label="t('fleet.span')">
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
      </header>

      <p v-if="store.error" class="tone-danger px-6 py-3 text-sm" style="color: var(--tone)" role="alert">{{ store.error }}</p>
      <p v-else-if="!store.view" class="px-6 py-6 text-muted">{{ t("fleet.loading") }}</p>
      <p v-else-if="!runs.length" class="px-6 py-6 text-muted">{{ t("fleet.empty") }}</p>

      <section v-for="run in runs" :key="run.id" class="border-b border-line px-6 py-5 max-md:px-4" :aria-labelledby="`fleet-${run.id}`">
        <div class="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <RouterLink :id="`fleet-${run.id}`" :to="`/runs/${run.id}`" class="min-w-0 truncate font-semibold hover:text-accent" :title="run.prompt">{{ runTitle(run) }}</RouterLink>
          <StatusBadge :look="runLook[run.status]" :status="run.status" />
          <span class="text-xs text-muted">{{ run.flow ?? "–" }} · {{ run.repo_path.split("/").pop() }}</span>
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
    </div>

    <div v-if="current" class="w-[26rem] shrink-0 border-l border-line bg-surface max-md:w-full max-md:border-l-0">
      <AgentPanel :agent="current.agent" :run="current.run" :version="store.view?.generated_at ?? ''" @close="selected = null" />
    </div>
  </div>
</template>
