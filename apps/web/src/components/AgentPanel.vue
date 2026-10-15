<script setup lang="ts">
import type { FleetAgent, FleetRun, NavarchEvent, RunMessage } from "@navarch/contracts";
import { ArrowLeft, FileText, GitBranch, MessageSquare, X } from "@lucide/vue";
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { api } from "../api/client.ts";
import { buildThread, iconFor } from "../lib/fleet.ts";
import { money, nodeLook } from "../lib/status.ts";
import InstructionBox from "./InstructionBox.vue";
import StatusBadge from "./StatusBadge.vue";

/**
 * One agent followed closely (ADR 0019): its activity and the instructions sent to it, its output,
 * its worktree and its log, with a box to tell it something.
 */
const props = defineProps<{ agent: FleetAgent; run: FleetRun; version: string }>();
const emit = defineEmits<{ close: [] }>();
const { t, locale } = useI18n();

type Tab = "activity" | "output" | "worktree" | "logs";
const tab = ref<Tab>("activity");
const events = ref<NavarchEvent[]>([]);
const messages = ref<RunMessage[]>([]);
const artifacts = ref<{ id: string; task_id: string; kind: string; summary: string }[]>([]);
const log = ref("");
const open = ref<{ id: string; text: string } | null>(null);

async function refresh() {
  const runId = props.run.id;
  const taskId = props.agent.id;
  const [evs, msgs, detail] = await Promise.all([
    api.runEvents(runId).catch(() => []),
    api.messages(runId).catch(() => []),
    api.run(runId).catch(() => null),
  ]);
  if (props.agent.id !== taskId) return;
  events.value = evs;
  messages.value = msgs;
  artifacts.value = detail?.artifacts ?? [];
  if (tab.value === "logs") log.value = await api.taskLogs(runId, taskId).catch((err: Error) => err.message);
}

watch(
  () => props.agent.id,
  () => {
    open.value = null;
    log.value = "";
    void refresh();
  },
  { immediate: true },
);
watch(() => props.version, () => void refresh());
watch(tab, (next) => {
  if (next === "logs") void refresh();
});

const look = computed(() => nodeLook[props.agent.status]);
const thread = computed(() => buildThread(events.value, messages.value, props.agent, !["succeeded", "failed", "cancelled", "skipped"].includes(props.agent.status)));
const own = computed(() => artifacts.value.filter((a) => a.task_id === props.agent.id));
const diff = computed(() => artifacts.value.filter((a) => a.kind === "diff").at(-1) ?? null);
const time = (iso: string) => new Date(iso).toLocaleTimeString(locale.value);

async function show(id: string) {
  open.value = { id, text: "…" };
  open.value = { id, text: await api.artifact(id).catch((err: Error) => err.message) };
}

function onSent(message: RunMessage) {
  messages.value = [...messages.value, message];
}
</script>

<template>
  <aside class="flex h-full min-h-0 flex-col" :aria-label="t('fleet.panel')">
    <header class="flex items-start gap-3 border-b border-line px-4 py-3">
      <button class="grid size-9 place-items-center rounded-md text-muted hover:bg-surface-2 md:hidden" :aria-label="t('fleet.back')" @click="emit('close')">
        <ArrowLeft :size="18" aria-hidden="true" />
      </button>
      <span class="grid size-9 shrink-0 place-items-center rounded-md bg-surface-2" :class="`tone-${look.tone}`" style="color: var(--tone)">
        <component :is="iconFor(agent.profile)" :size="18" aria-hidden="true" />
      </span>
      <div class="min-w-0 flex-1">
        <p class="flex flex-wrap items-center gap-2">
          <span class="truncate font-semibold">{{ agent.node_id }}</span>
          <StatusBadge :look="look" :status="agent.status" />
        </p>
        <p class="truncate text-xs text-muted">{{ agent.profile }} · {{ agent.adapter }}<template v-if="agent.model"> · {{ agent.model }}</template> · {{ money(agent.cost) }}</p>
      </div>
      <button class="grid size-9 place-items-center rounded-md text-muted hover:bg-surface-2 max-md:hidden" :aria-label="t('node.close')" @click="emit('close')">
        <X :size="16" aria-hidden="true" />
      </button>
    </header>

    <div class="flex gap-1 border-b border-line px-3" role="tablist">
      <button
        v-for="name in ['activity', 'output', 'worktree', 'logs'] as const"
        :key="name"
        role="tab"
        :aria-selected="tab === name"
        class="min-h-10 border-b-2 px-2.5 text-sm"
        :class="tab === name ? 'border-accent text-fg' : 'border-transparent text-muted hover:text-fg'"
        @click="tab = name"
      >{{ t(`fleet.tab.${name}`) }}</button>
    </div>

    <div class="min-h-0 flex-1 overflow-auto px-4 py-3 text-sm">
      <ol v-if="tab === 'activity'" class="space-y-2" aria-live="polite">
        <li v-if="!thread.length" class="text-muted">{{ t("fleet.noActivity") }}</li>
        <li
          v-for="item in thread"
          :key="item.id"
          :class="item.kind === 'message' ? 'tone-info ml-6 rounded-lg border p-2' : 'flex gap-2'"
          :style="item.kind === 'message' ? 'border-color: color-mix(in srgb, var(--tone) 40%, transparent); background: color-mix(in srgb, var(--tone) 8%, transparent)' : ''"
        >
          <template v-if="item.kind === 'progress'">
            <time :datetime="item.ts" class="shrink-0 font-mono text-xs text-muted">{{ time(item.ts) }}</time>
            <span class="min-w-0 break-words"><span v-if="item.tool" class="font-mono text-xs text-accent">{{ item.tool }} · </span>{{ item.text }}</span>
          </template>
          <template v-else>
            <p class="flex items-center gap-1.5 text-xs" style="color: var(--tone)">
              <MessageSquare :size="12" aria-hidden="true" />{{ t("fleet.you") }} · {{ item.delivery === "now" ? t("instruct.now") : t("instruct.next") }}
              · {{ item.delivered ? t("fleet.delivered") : t("fleet.waiting") }}
              <time :datetime="item.ts" class="ml-auto font-mono text-muted">{{ time(item.ts) }}</time>
            </p>
            <p class="mt-1 whitespace-pre-wrap">{{ item.text }}</p>
          </template>
        </li>
      </ol>

      <div v-else-if="tab === 'output'" class="space-y-3">
        <section v-if="agent.error">
          <h3 class="mb-1 text-xs tracking-wide text-muted uppercase">{{ t("node.error") }}</h3>
          <pre class="tone-danger rounded-md border border-line bg-bg p-2 font-mono text-xs whitespace-pre-wrap" style="color: var(--tone)">{{ agent.error }}</pre>
        </section>
        <section v-if="agent.summary">
          <h3 class="mb-1 text-xs tracking-wide text-muted uppercase">{{ t("node.summary") }}</h3>
          <pre class="max-h-72 overflow-auto rounded-md border border-line bg-bg p-2 font-mono text-xs whitespace-pre-wrap">{{ agent.summary }}</pre>
        </section>
        <section v-if="own.length">
          <h3 class="mb-1 text-xs tracking-wide text-muted uppercase">{{ t("node.artifacts") }}</h3>
          <ul class="space-y-1">
            <li v-for="a in own" :key="a.id">
              <button class="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left hover:bg-surface-2" :aria-expanded="open?.id === a.id" @click="open?.id === a.id ? (open = null) : show(a.id)">
                <FileText :size="14" class="mt-0.5 shrink-0 text-muted" aria-hidden="true" />
                <span><span class="font-mono text-xs text-muted">{{ a.kind }}</span><br />{{ a.summary }}</span>
              </button>
              <pre v-if="open?.id === a.id" class="mt-1 max-h-96 overflow-auto rounded-md border border-line bg-bg p-2 font-mono text-xs whitespace-pre-wrap">{{ open.text }}</pre>
            </li>
          </ul>
        </section>
        <p v-if="!agent.error && !agent.summary && !own.length" class="text-muted">{{ t("node.noTask") }}</p>
      </div>

      <div v-else-if="tab === 'worktree'" class="space-y-3">
      <dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-2">
        <dt class="text-muted">{{ t("fleet.branch") }}</dt>
        <dd class="flex items-center gap-1 font-mono text-xs break-all"><GitBranch :size="12" class="shrink-0" aria-hidden="true" />{{ agent.branch ?? "–" }}</dd>
        <dt class="text-muted">{{ t("fleet.path") }}</dt>
        <dd class="font-mono text-xs break-all">{{ agent.sandbox_path ?? "–" }}</dd>
        <dt class="text-muted">{{ t("fleet.lastDiff") }}</dt>
        <dd>
          <button v-if="diff" class="text-left text-accent hover:underline" :aria-expanded="open?.id === diff.id" @click="open?.id === diff.id ? (open = null) : show(diff.id)">{{ diff.summary }}</button>
          <span v-else>–</span>
        </dd>
      </dl>
      <pre v-if="diff && open?.id === diff.id" class="max-h-96 overflow-auto rounded-md border border-line bg-bg p-2 font-mono text-xs whitespace-pre">{{ open.text }}</pre>
      </div>

      <pre v-else class="font-mono text-xs whitespace-pre-wrap">{{ log || t("run.noLogs") }}</pre>
    </div>

    <footer class="border-t border-line px-4 py-3">
      <InstructionBox :run-id="run.id" :agent="agent" @sent="onSent" />
    </footer>
  </aside>
</template>
