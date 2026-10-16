<script setup lang="ts">
import type { NavarchEvent, RunDetail } from "@navarch/contracts";
import { FileText, X } from "@lucide/vue";
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { api } from "../api/client.ts";
import type { GraphNode } from "../lib/graph.ts";
import { money, nodeLook } from "../lib/status.ts";
import StatusBadge from "./StatusBadge.vue";

/** The selected node's "passport": agent, model and why, cost, output, artifacts (spec §15.2). */
const props = defineProps<{ node: GraphNode; run: RunDetail; events: NavarchEvent[] }>();
const emit = defineEmits<{ close: [] }>();
const { t, locale } = useI18n();

const task = computed(() => props.node.task);
const taskIds = computed(() => new Set(props.node.tasks.map((x) => x.id)));
const artifacts = computed(() => props.run.artifacts.filter((a) => taskIds.value.has(a.task_id)));
const routing = computed(() => {
  const id = task.value?.id;
  const routed = props.events.filter((e) => e.type === "model.routed" && e.task_id === id);
  return routed.at(-1)?.payload as { model_id: string; tier: string; reason: string; fallback_from?: string } | undefined;
});

const open = ref<{ id: string; text: string } | null>(null);
async function show(id: string) {
  open.value = { id, text: "…" };
  try {
    open.value = { id, text: await api.artifact(id) };
  } catch (err) {
    open.value = { id, text: (err as Error).message };
  }
}
watch(
  () => props.node.id,
  () => (open.value = null),
);
</script>

<template>
  <aside class="flex h-full min-h-0 flex-col" :aria-label="t('node.panel')">
    <header class="flex items-start gap-2 border-b border-line px-4 py-3">
      <div class="min-w-0">
        <p class="text-xs tracking-wide text-muted uppercase">{{ t(`node.kind.${node.kind}`) }}</p>
        <h2 class="truncate text-base font-semibold">{{ node.label }}</h2>
      </div>
      <button class="ml-auto grid size-8 place-items-center rounded-md text-muted hover:bg-surface-2" :aria-label="t('node.close')" @click="emit('close')">
        <X :size="16" aria-hidden="true" />
      </button>
    </header>
    <div class="min-h-0 flex-1 space-y-4 overflow-auto px-4 py-3 text-sm">
      <StatusBadge :look="nodeLook[node.state]" :status="node.state" size="md" />
      <p v-if="!task" class="text-muted">{{ t("node.noTask") }}</p>
      <dl v-else class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5">
        <template v-if="node.kind === 'agent'">
          <dt class="text-muted">{{ t("node.profile") }}</dt><dd>{{ task.profile }}</dd>
          <dt class="text-muted">{{ t("node.adapter") }}</dt><dd class="font-mono text-xs">{{ task.adapter }}</dd>
          <dt class="text-muted">{{ t("node.model") }}</dt><dd class="font-mono text-xs break-all">{{ task.model ?? "—" }}</dd>
        </template>
        <dt class="text-muted">{{ t("node.attempt") }}</dt><dd>{{ task.attempt }} / {{ task.max_attempts }}</dd>
        <template v-if="node.parent"><dt class="text-muted">{{ t("node.iteration") }}</dt><dd>{{ task.iteration }}</dd></template>
        <dt class="text-muted">{{ t("node.cost") }}</dt><dd class="font-mono text-xs">{{ money(node.tasks.reduce((s, x) => s + x.cost, 0)) }}</dd>
        <template v-if="task.not_before"><dt class="text-muted">{{ t("node.retryAt") }}</dt><dd><time :datetime="task.not_before">{{ new Date(task.not_before).toLocaleString(locale) }}</time></dd></template>
      </dl>
      <section v-if="node.kind === 'parallel' && node.tasks.length">
        <h3 class="mb-1 text-xs font-medium tracking-wide text-muted uppercase">{{ t("node.branches") }}</h3>
        <ul class="space-y-1">
          <li v-for="x in node.tasks" :key="x.id" class="flex items-center gap-2">
            <span class="text-xs text-muted">{{ node.branchOf?.[x.node_id] }}</span>
            <span class="font-mono text-xs">{{ x.node_id }}</span>
            <span class="ml-auto"><StatusBadge :look="nodeLook[x.status]" :status="x.status" /></span>
          </li>
        </ul>
      </section>
      <section v-if="node.kind === 'subflow' && node.tasks.length">
        <h3 class="mb-1 text-xs font-medium tracking-wide text-muted uppercase">{{ t("node.steps") }}</h3>
        <ul class="space-y-1">
          <li v-for="x in node.tasks" :key="x.id" class="flex items-center gap-2">
            <span class="font-mono text-xs">{{ x.node_id.slice(node.id.length + 1) }}</span>
            <span v-if="x.iteration > 1" class="font-mono text-[11px] text-muted">×{{ x.iteration }}</span>
            <span class="ml-auto"><StatusBadge :look="nodeLook[x.status]" :status="x.status" /></span>
          </li>
        </ul>
      </section>
      <section v-if="routing">
        <h3 class="mb-1 text-xs font-medium tracking-wide text-muted uppercase">{{ t("node.routing") }}</h3>
        <p class="font-mono text-xs">{{ routing.model_id }} · {{ routing.tier }}<template v-if="routing.fallback_from"> ← {{ routing.fallback_from }}</template></p>
        <p class="mt-1 text-muted">{{ routing.reason }}</p>
      </section>
      <section v-if="task?.error">
        <h3 class="mb-1 text-xs font-medium tracking-wide text-muted uppercase">{{ t("node.error") }}</h3>
        <pre class="tone-danger rounded-md border border-line bg-bg p-2 font-mono text-xs whitespace-pre-wrap" style="color: var(--tone)">{{ task.error }}</pre>
      </section>
      <section v-if="task?.summary">
        <h3 class="mb-1 text-xs font-medium tracking-wide text-muted uppercase">{{ t("node.summary") }}</h3>
        <pre class="max-h-72 overflow-auto rounded-md border border-line bg-bg p-2 font-mono text-xs whitespace-pre-wrap">{{ task.summary }}</pre>
      </section>
      <section v-if="artifacts.length">
        <h3 class="mb-1 text-xs font-medium tracking-wide text-muted uppercase">{{ t("node.artifacts") }}</h3>
        <ul class="space-y-1">
          <li v-for="a in artifacts" :key="a.id">
            <button class="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left hover:bg-surface-2" :aria-expanded="open?.id === a.id" @click="open?.id === a.id ? (open = null) : show(a.id)">
              <FileText :size="14" class="mt-0.5 shrink-0 text-muted" aria-hidden="true" />
              <span class="min-w-0"><span class="font-mono text-xs text-muted">{{ a.kind }}</span><br />{{ a.summary }}</span>
            </button>
            <pre v-if="open?.id === a.id" class="mt-1 max-h-96 overflow-auto rounded-md border border-line bg-bg p-2 font-mono text-xs whitespace-pre-wrap">{{ open.text }}</pre>
          </li>
        </ul>
      </section>
    </div>
  </aside>
</template>
