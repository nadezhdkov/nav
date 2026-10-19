<script setup lang="ts">
import type { FleetAgent, FleetRun, NavarchEvent, RunMessage, TaskView, WorktreeFile, WorktreeStatus } from "@navarch/contracts";
import { ArrowLeft, CircleCheck, CircleX, FileText, GitBranch, Hand, MessageSquare, RefreshCw, Users, X } from "@lucide/vue";
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { api } from "../api/client.ts";
import { buildLeadThread, buildThread, iconFor } from "../lib/fleet.ts";
import { money, nodeLook } from "../lib/status.ts";
import InstructionBox from "./InstructionBox.vue";
import StatusBadge from "./StatusBadge.vue";

/**
 * One agent followed closely (ADR 0019, slice 10): a chat with its progress, results and the
 * instructions sent to it (the lead chat for a team's lead), its output, the live state of the
 * run's worktree and its log, with a box to tell it something.
 */
const props = defineProps<{ agent: FleetAgent; run: FleetRun; version: string }>();
const emit = defineEmits<{ close: [] }>();
const { t, locale } = useI18n();

type Tab = "chat" | "output" | "worktree" | "logs";
const tab = ref<Tab>("chat");
const events = ref<NavarchEvent[]>([]);
const messages = ref<RunMessage[]>([]);
const artifacts = ref<{ id: string; task_id: string; kind: string; summary: string }[]>([]);
const tasks = ref<TaskView[]>([]);
const log = ref("");
const open = ref<{ id: string; text: string } | null>(null);
const worktree = ref<WorktreeStatus | null>(null);
const worktreeError = ref<string | null>(null);
const file = ref<{ path: string; text: string } | null>(null);
let lastWorktree = 0;

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
  tasks.value = detail?.tasks ?? [];
  if (tab.value === "worktree") void loadWorktree();
  if (tab.value === "logs") log.value = await api.taskLogs(runId, taskId).catch((err: Error) => err.message);
}

watch(
  () => props.agent.id,
  () => {
    open.value = null;
    log.value = "";
    file.value = null;
    // Another agent may be in another run: its worktree is not this one's.
    worktree.value = null;
    worktreeError.value = null;
    lastWorktree = 0;
    tab.value = "chat";
    void refresh();
  },
  { immediate: true },
);
watch(() => props.version, () => void refresh());
watch(tab, (next) => {
  if (next === "logs") void refresh();
  if (next === "worktree") void loadWorktree(true);
});

// The agent's worktree (the run's, or a parallel member's own), live: read when the tab opens and on the run's events, at most every 5 s.
let pendingWorktree: ReturnType<typeof setTimeout> | null = null;
async function loadWorktree(now = false) {
  const wait = lastWorktree + 5_000 - Date.now();
  if (!now && wait > 0) {
    pendingWorktree ??= setTimeout(() => {
      pendingWorktree = null;
      void loadWorktree();
    }, wait);
    return;
  }
  lastWorktree = Date.now();
  const runId = props.run.id;
  try {
    const status = await api.worktree(runId, props.agent.id);
    if (props.run.id !== runId) return;
    worktree.value = status;
    worktreeError.value = null;
    if (file.value && !status.files.some((f) => f.path === file.value!.path)) file.value = null;
  } catch (err) {
    worktreeError.value = (err as Error).message;
  }
}
onBeforeUnmount(() => {
  if (pendingWorktree) clearTimeout(pendingWorktree);
});
async function showFile(f: WorktreeFile) {
  if (file.value?.path === f.path) return void (file.value = null);
  file.value = { path: f.path, text: "…" };
  const text = await api.worktreeDiff(props.run.id, f.path, props.agent.id).catch((err: Error) => err.message);
  if (file.value?.path === f.path) file.value = { path: f.path, text };
}
const fileLook: Record<WorktreeFile["status"], { letter: string; tone: string }> = {
  added: { letter: "A", tone: "success" },
  untracked: { letter: "U", tone: "success" },
  modified: { letter: "M", tone: "warning" },
  deleted: { letter: "D", tone: "danger" },
  renamed: { letter: "R", tone: "info" },
};

const look = computed(() => nodeLook[props.agent.status]);
const lead = computed(() => props.agent.team_role === "lead" && !props.agent.team_sub && props.run.team !== null);
const thread = computed(() =>
  lead.value && props.run.team
    ? buildLeadThread(events.value, messages.value, tasks.value, props.run.team)
    : buildThread(events.value, messages.value, props.agent, !["succeeded", "failed", "cancelled", "skipped"].includes(props.agent.status)),
);
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
        v-for="name in ['chat', 'output', 'worktree', 'logs'] as const"
        :key="name"
        role="tab"
        :aria-selected="tab === name"
        class="min-h-10 border-b-2 px-2.5 text-sm"
        :class="tab === name ? 'border-accent text-fg' : 'border-transparent text-muted hover:text-fg'"
        @click="tab = name"
      >{{ name === "chat" && lead ? t("fleet.tab.leadChat") : t(`fleet.tab.${name}`) }}</button>
    </div>

    <div class="min-h-0 flex-1 overflow-auto px-4 py-3 text-sm">
      <ol v-if="tab === 'chat'" class="space-y-2" aria-live="polite">
        <li v-if="!thread.length" class="text-muted">{{ t("fleet.noActivity") }}</li>
        <li
          v-for="item in thread"
          :key="item.id"
          :class="
            item.kind === 'message'
              ? 'tone-info ml-6 rounded-lg border p-2'
              : item.kind === 'progress'
                ? 'flex gap-2'
                : item.kind === 'question'
                  ? 'tone-warning mr-6 rounded-lg border p-2'
                  : item.kind === 'result'
                    ? `${item.ok ? 'tone-success' : 'tone-danger'} mr-6 rounded-lg border p-2`
                    : 'tone-neutral mr-6 rounded-lg border p-2'
          "
          :style="item.kind === 'progress' ? '' : 'border-color: color-mix(in srgb, var(--tone) 40%, transparent); background: color-mix(in srgb, var(--tone) 8%, transparent)'"
        >
          <template v-if="item.kind === 'progress'">
            <time :datetime="item.ts" class="shrink-0 font-mono text-xs text-muted">{{ time(item.ts) }}</time>
            <span class="min-w-0 break-words"><span v-if="item.tool" class="font-mono text-xs text-accent">{{ item.tool }} · </span>{{ item.text }}</span>
          </template>
          <template v-else-if="item.kind === 'result'">
            <p class="flex items-center gap-1.5 text-xs" style="color: var(--tone)">
              <component :is="item.ok ? CircleCheck : CircleX" :size="12" aria-hidden="true" />
              {{ item.turn ? t("fleet.turnAnswer", { turn: item.turn }) : item.ok ? t("fleet.finished") : t("fleet.failedResult") }}
              <time :datetime="item.ts" class="ml-auto font-mono text-muted">{{ time(item.ts) }}</time>
            </p>
            <p class="mt-1 max-h-60 overflow-auto whitespace-pre-wrap">{{ item.text }}</p>
          </template>
          <template v-else-if="item.kind === 'members'">
            <p class="flex items-center gap-1.5 text-xs" style="color: var(--tone)"><Users :size="12" aria-hidden="true" />{{ t("fleet.membersAdded", { turn: item.turn }) }}</p>
            <ul class="mt-1 space-y-0.5">
              <li v-for="m in item.members" :key="m.key" class="flex items-center gap-1.5">
                <component :is="iconFor(m.profile)" :size="12" class="text-muted" aria-hidden="true" />{{ m.title }} <span class="text-xs text-muted">{{ m.profile }}</span>
              </li>
            </ul>
          </template>
          <template v-else-if="item.kind === 'question'">
            <p class="flex items-center gap-1.5 text-xs font-semibold" style="color: var(--tone)"><Hand :size="12" aria-hidden="true" />{{ t("tree.waitingForYou") }}</p>
            <p class="mt-1 whitespace-pre-wrap">{{ item.text }}</p>
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
          <dd class="flex items-center gap-1 font-mono text-xs break-all"><GitBranch :size="12" class="shrink-0" aria-hidden="true" />{{ worktree?.branch ?? agent.branch ?? "–" }}</dd>
          <dt class="text-muted">{{ t("fleet.path") }}</dt>
          <dd class="font-mono text-xs break-all">{{ worktree?.path ?? agent.sandbox_path ?? "–" }}</dd>
        </dl>
        <p v-if="worktreeError" class="tone-danger text-xs" style="color: var(--tone)" role="alert">{{ worktreeError }}</p>
        <template v-if="worktree?.exists">
          <div class="flex items-center gap-2 text-xs">
            <span class="font-semibold">{{ t("fleet.changedFiles", { n: worktree.totals.files }) }}</span>
            <span class="tone-success font-mono" style="color: var(--tone)">+{{ worktree.totals.added }}</span>
            <span class="tone-danger font-mono" style="color: var(--tone)">−{{ worktree.totals.removed }}</span>
            <button type="button" class="ml-auto grid size-8 place-items-center rounded-md text-muted hover:bg-surface-2" :aria-label="t('fleet.refresh')" :title="t('fleet.refresh')" @click="loadWorktree(true)">
              <RefreshCw :size="14" aria-hidden="true" />
            </button>
          </div>
          <p v-if="!worktree.files.length" class="text-muted">{{ t("fleet.noChanges") }}</p>
          <ul class="space-y-0.5">
            <li v-for="f in worktree.files" :key="f.path">
              <button
                type="button"
                class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-surface-2"
                :aria-expanded="file?.path === f.path"
                @click="showFile(f)"
              >
                <span class="w-4 shrink-0 font-mono text-xs font-semibold" :class="`tone-${fileLook[f.status].tone}`" style="color: var(--tone)" :title="t(`fleet.fileStatus.${f.status}`)">{{ fileLook[f.status].letter }}</span>
                <span class="sr-only">{{ t(`fleet.fileStatus.${f.status}`) }}</span>
                <span class="min-w-0 flex-1 truncate font-mono text-xs" :title="f.old_path ? `${f.old_path} → ${f.path}` : f.path">{{ f.path }}</span>
                <span v-if="f.added === null" class="shrink-0 text-xs text-muted">{{ t("fleet.binary") }}</span>
                <span v-else class="shrink-0 font-mono text-xs"><span class="tone-success" style="color: var(--tone)">+{{ f.added }}</span> <span class="tone-danger" style="color: var(--tone)">−{{ f.removed }}</span></span>
              </button>
              <pre v-if="file?.path === f.path" class="mt-1 max-h-96 overflow-auto rounded-md border border-line bg-bg p-2 font-mono text-xs whitespace-pre">{{ file.text }}</pre>
            </li>
          </ul>
        </template>
        <template v-else-if="worktree">
          <p class="text-muted">{{ worktree.path ? t("fleet.worktreeGone") : t("fleet.worktreeNotYet") }}</p>
          <p v-if="diff">
            <span class="text-muted">{{ t("fleet.lastDiff") }}: </span>
            <button class="text-left text-accent hover:underline" :aria-expanded="open?.id === diff.id" @click="open?.id === diff.id ? (open = null) : show(diff.id)">{{ diff.summary }}</button>
          </p>
          <pre v-if="diff && open?.id === diff.id" class="max-h-96 overflow-auto rounded-md border border-line bg-bg p-2 font-mono text-xs whitespace-pre">{{ open.text }}</pre>
        </template>
        <p v-else-if="!worktreeError" class="text-muted">{{ t("fleet.loadingWorktree") }}</p>
      </div>

      <pre v-else class="font-mono text-xs whitespace-pre-wrap">{{ log || t("run.noLogs") }}</pre>
    </div>

    <footer class="border-t border-line px-4 py-3">
      <InstructionBox :run-id="run.id" :agent="agent" @sent="onSent" />
    </footer>
  </aside>
</template>
