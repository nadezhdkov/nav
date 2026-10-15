<script setup lang="ts">
import type { InboxItemDetail, InboxItemView, WorkItemStatus } from "@navarch/contracts";
import { Ban, CircleAlert, ExternalLink, Inbox, Play, RefreshCw, RotateCcw, X } from "@lucide/vue";
import { computed, reactive, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useRouter } from "vue-router";
import { api, client } from "../api/client.ts";
import StatusBadge from "../components/StatusBadge.vue";
import { actionLook, filterItems, itemLook, sortItems, startable, totalEstimate, type InboxFilter } from "../lib/inbox.ts";
import { money } from "../lib/status.ts";
import { useInboxStore, useProjectsStore } from "../stores/runs.ts";

/** Inbox (spec §15.3, ADR 0021): open issues of the registered projects, triaged, and runs started from them. */
const { t } = useI18n();
const router = useRouter();
const store = useInboxStore();
const projects = useProjectsStore();
const mobile = computed(() => client() === "mobile");

const filter = reactive<InboxFilter>({ project: "", status: "open", kind: "", action: "", text: "" });
const items = computed(() => sortItems(filterItems(store.view?.items ?? [], filter)));
const selected = ref(new Set<string>());
const chosen = computed(() => (store.view?.items ?? []).filter((i) => selected.value.has(i.id)));
const total = computed(() => totalEstimate(chosen.value));
const projectName = (id: string) => projects.projects.find((p) => p.id === id)?.name ?? id;

function toggle(item: InboxItemView) {
  const next = new Set(selected.value);
  if (next.has(item.id)) next.delete(item.id);
  else next.add(item.id);
  selected.value = next;
}
const allShown = computed(() => items.value.filter(startable));
function toggleAll() {
  selected.value = selected.value.size === allShown.value.length ? new Set() : new Set(allShown.value.map((i) => i.id));
}
// Items that leave the list (started, dismissed) leave the selection too.
watch(items, (list) => {
  const ids = new Set(list.filter(startable).map((i) => i.id));
  const kept = [...selected.value].filter((id) => ids.has(id));
  if (kept.length !== selected.value.size) selected.value = new Set(kept);
});

const syncing = ref(false);
const notice = ref<{ tone: "success" | "danger"; text: string } | null>(null);
async function sync() {
  syncing.value = true;
  notice.value = null;
  try {
    const { results } = await api.syncInbox();
    const failed = results.filter((r) => r.error);
    const sum = (k: "new" | "changed" | "closed") => results.reduce((n, r) => n + r[k], 0);
    notice.value = failed.length
      ? { tone: "danger", text: failed.map((r) => `${projectName(r.project_id)}: ${r.error}`).join(" · ") }
      : { tone: "success", text: t("inbox.synced", { new: sum("new"), changed: sum("changed"), closed: sum("closed") }) };
    await store.load();
  } catch (err) {
    notice.value = { tone: "danger", text: (err as Error).message };
  } finally {
    syncing.value = false;
  }
}

// The start dialog (§15.3: "Start run with Flow X" with the total estimate).
const dialog = ref<HTMLDialogElement | null>(null);
const budget = ref<number | null>(null);
/** Start the items as team runs (ADR 0022) instead of fix-issue; desktop only, like the budget. */
const team = ref(false);
const starting = ref(false);
const startErrors = ref<{ item_id: string; message: string }[]>([]);
function openStart() {
  startErrors.value = [];
  dialog.value?.showModal?.();
}
async function start() {
  starting.value = true;
  try {
    const result = await api.startInbox({ item_ids: [...selected.value], ...(budget.value && !mobile.value ? { budget: budget.value } : {}), ...(team.value && !mobile.value ? { flow: "team" } : {}) });
    startErrors.value = result.errors;
    selected.value = new Set(result.errors.map((e) => e.item_id).filter((id) => selected.value.has(id)));
    await store.load();
    if (!result.errors.length) {
      dialog.value?.close?.();
      if (result.runs.length === 1) void router?.push(`/runs/${result.runs[0]!.run_id}`);
    }
  } catch (err) {
    startErrors.value = [{ item_id: "", message: (err as Error).message }];
  } finally {
    starting.value = false;
  }
}

// The item panel: the issue text as plain text (untrusted, T1), its triage and its runs.
const current = ref<InboxItemDetail | null>(null);
async function open(item: InboxItemView) {
  try {
    current.value = await api.inboxItem(item.id);
  } catch (err) {
    notice.value = { tone: "danger", text: (err as Error).message };
  }
}
async function dismiss(restore = false) {
  if (!current.value) return;
  current.value = restore ? await api.restoreItem(current.value.id) : await api.dismissItem(current.value.id);
  await store.load();
}
const duplicateOf = (item: InboxItemView) => (store.view?.items ?? []).find((o) => o.project_id === item.project_id && o.number === item.triage?.duplicate_of);
const statuses: ("open" | "all" | WorkItemStatus)[] = ["open", "new", "triaged", "in_run", "done", "dismissed", "closed", "all"];
</script>

<template>
  <div class="flex h-full min-h-0">
    <div class="min-w-0 flex-1 overflow-auto" :class="{ 'max-md:hidden': current }">
      <header class="sticky top-0 z-10 space-y-3 border-b border-line bg-bg/90 px-6 py-4 backdrop-blur max-md:px-4">
        <div class="flex flex-wrap items-center gap-3">
          <h1 class="flex items-center gap-2 text-xl font-semibold"><Inbox :size="20" class="text-accent" aria-hidden="true" />{{ t("inbox.title") }}</h1>
          <span class="text-sm text-muted">{{ t("inbox.count", { n: store.open.length }) }}</span>
          <button
            type="button"
            class="ml-auto inline-flex min-h-9 items-center gap-2 rounded-md border border-line px-3 text-sm hover:bg-surface-2 disabled:opacity-60"
            :disabled="syncing"
            @click="sync"
          >
            <RefreshCw :size="15" :class="{ spin: syncing }" aria-hidden="true" />{{ syncing ? t("inbox.syncing") : t("inbox.sync") }}
          </button>
        </div>
        <p v-if="notice" :class="`tone-${notice.tone}`" class="text-sm" style="color: var(--tone)" role="status">{{ notice.text }}</p>
        <p
          v-if="store.view && !store.view.triage.available"
          class="tone-warning flex items-start gap-2 rounded-md border px-3 py-2 text-sm"
          style="border-color: color-mix(in srgb, var(--tone) 45%, transparent)"
          role="status"
        >
          <CircleAlert :size="16" class="mt-0.5 shrink-0" style="color: var(--tone)" aria-hidden="true" />
          <span><span class="font-medium">{{ t("inbox.triageOff") }}</span> <span class="text-muted">{{ store.view.triage.reason }}</span></span>
        </p>
        <div class="flex flex-wrap gap-2 text-sm">
          <input v-model="filter.text" type="search" :placeholder="t('inbox.search')" :aria-label="t('inbox.search')" class="min-h-9 min-w-48 flex-1 rounded-md border border-line bg-surface px-3" />
          <select v-model="filter.project" :aria-label="t('inbox.filters.project')" class="min-h-9 rounded-md border border-line bg-surface px-2">
            <option value="">{{ t("inbox.filters.allProjects") }}</option>
            <option v-for="p in projects.projects" :key="p.id" :value="p.id">{{ p.name }}</option>
          </select>
          <select v-model="filter.status" :aria-label="t('inbox.filters.status')" class="min-h-9 rounded-md border border-line bg-surface px-2">
            <option v-for="s in statuses" :key="s" :value="s">{{ t(`inbox.statuses.${s}`) }}</option>
          </select>
          <select v-model="filter.kind" :aria-label="t('inbox.filters.kind')" class="min-h-9 rounded-md border border-line bg-surface px-2">
            <option value="">{{ t("inbox.filters.allKinds") }}</option>
            <option v-for="k in ['bug', 'feature', 'chore', 'docs', 'question']" :key="k" :value="k">{{ t(`inbox.kinds.${k}`) }}</option>
          </select>
          <select v-model="filter.action" :aria-label="t('inbox.filters.action')" class="min-h-9 rounded-md border border-line bg-surface px-2">
            <option value="">{{ t("inbox.filters.allActions") }}</option>
            <option v-for="a in ['start_run', 'needs_info', 'duplicate', 'skip']" :key="a" :value="a">{{ t(`inbox.actions.${a}`) }}</option>
          </select>
        </div>
      </header>

      <p v-if="store.error" class="tone-danger px-6 py-3 text-sm" style="color: var(--tone)" role="alert">{{ store.error }}</p>
      <p v-else-if="!store.view" class="px-6 py-6 text-muted">{{ t("inbox.loading") }}</p>
      <div v-else-if="!projects.projects.length" class="m-6 rounded-lg border border-dashed border-line p-6 text-center text-muted max-md:m-4">
        <p>{{ t("inbox.noProjects") }}</p>
        <code class="mt-2 inline-block rounded bg-surface-2 px-2 py-1 font-mono text-xs text-fg">navarch project add &lt;clone&gt;</code>
      </div>
      <p v-else-if="!items.length" class="px-6 py-6 text-muted">{{ t("inbox.empty") }}</p>

      <table v-if="items.length" class="w-full border-collapse text-sm">
        <caption class="sr-only">{{ t("inbox.title") }}</caption>
        <thead class="text-left text-xs tracking-wide whitespace-nowrap text-muted uppercase max-lg:hidden">
          <tr class="border-b border-line">
            <th scope="col" class="py-2 pr-3 pl-6">
              <input type="checkbox" :checked="selected.size > 0 && selected.size === allShown.length" :aria-label="t('inbox.selectAll')" class="size-4" @change="toggleAll" />
            </th>
            <th scope="col" class="w-full py-2 pr-3 font-medium">{{ t("inbox.cols.issue") }}</th>
            <th scope="col" class="py-2 pr-3 font-medium">{{ t("inbox.cols.kind") }}</th>
            <th scope="col" class="py-2 pr-3 text-center font-medium">{{ t("inbox.cols.complexity") }}</th>
            <th scope="col" class="py-2 pr-3 font-medium">{{ t("inbox.cols.area") }}</th>
            <th scope="col" class="py-2 pr-3 font-medium">{{ t("inbox.cols.action") }}</th>
            <th scope="col" class="py-2 pr-3 text-right font-medium">{{ t("inbox.cols.estimate") }}</th>
            <th scope="col" class="py-2 pr-6 font-medium">{{ t("inbox.cols.status") }}</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="item in items"
            :key="item.id"
            class="border-b border-line hover:bg-surface max-lg:flex max-lg:flex-wrap max-lg:items-center max-lg:gap-x-3 max-lg:gap-y-1.5 max-lg:px-4 max-lg:py-3"
            :class="{ 'bg-surface': current?.id === item.id }"
          >
            <td class="py-2.5 pr-3 pl-6 align-top max-lg:p-0">
              <input
                type="checkbox"
                class="size-4"
                :checked="selected.has(item.id)"
                :disabled="!startable(item)"
                :aria-label="t('inbox.select', { issue: `#${item.number}` })"
                @change="toggle(item)"
              />
            </td>
            <td class="w-full max-w-0 py-2.5 pr-3 max-lg:w-auto max-lg:max-w-none max-lg:flex-1 max-lg:basis-[calc(100%-2.5rem)] max-lg:p-0">
              <button type="button" class="block w-full min-w-0 text-left" @click="open(item)">
                <span class="block truncate font-medium hover:text-accent">{{ item.title }}</span>
                <span class="block truncate text-xs text-muted">
                  <span class="font-mono">{{ item.repo }}#{{ item.number }}</span> · {{ item.author }}
                  <template v-if="item.labels.length"> · {{ item.labels.join(", ") }}</template>
                </span>
              </button>
            </td>
            <td class="py-2.5 pr-3 whitespace-nowrap max-lg:p-0 max-lg:text-xs">{{ item.triage ? t(`inbox.kinds.${item.triage.kind}`) : "—" }}</td>
            <td class="py-2.5 pr-3 text-center font-mono max-lg:p-0 max-lg:text-xs">
              <span v-if="item.triage" :title="t('inbox.complexityHint')">{{ item.triage.complexity }}<span class="text-muted">/5</span></span>
              <span v-else>—</span>
            </td>
            <td class="max-w-36 truncate py-2.5 pr-3 text-muted max-lg:p-0 max-lg:text-xs">{{ item.triage?.area || "—" }}</td>
            <td class="py-2.5 pr-3 max-lg:p-0">
              <span v-if="item.triage" class="inline-flex items-center gap-1.5 whitespace-nowrap" :class="`tone-${actionLook[item.triage.suggested_action].tone}`">
                <component :is="actionLook[item.triage.suggested_action].icon" :size="14" style="color: var(--tone)" aria-hidden="true" />
                <template v-if="item.triage.duplicate_of">
                  {{ t("inbox.duplicateOf") }}
                  <button v-if="duplicateOf(item)" type="button" class="font-mono text-accent underline-offset-2 hover:underline" @click="open(duplicateOf(item)!)">#{{ item.triage.duplicate_of }}</button>
                  <span v-else class="font-mono">#{{ item.triage.duplicate_of }}</span>
                </template>
                <template v-else>{{ t(`inbox.actions.${item.triage.suggested_action}`) }}</template>
              </span>
              <span v-else class="text-muted">—</span>
            </td>
            <td class="py-2.5 pr-3 text-right font-mono whitespace-nowrap max-lg:p-0 max-lg:text-xs">
              <span v-if="item.estimate" :title="t('inbox.estimateHint', { n: item.estimate.runs })">≈ {{ money(item.estimate.usd) }}</span>
              <span v-else class="text-muted" :title="t('inbox.noEstimate')">—</span>
            </td>
            <td class="py-2.5 pr-6 max-lg:p-0"><StatusBadge :look="itemLook[item.status]" :status="`item_${item.status}`" /></td>
          </tr>
        </tbody>
      </table>

      <!-- Selection bar: what starting will do, before the dialog says it in full. -->
      <div
        v-if="selected.size"
        class="sticky bottom-0 flex flex-wrap items-center gap-3 border-t border-line bg-surface px-6 py-3 max-md:bottom-[calc(4rem+env(safe-area-inset-bottom))] max-md:px-4"
      >
        <span class="text-sm">{{ t("inbox.selected", { n: selected.size }) }}</span>
        <span class="font-mono text-sm text-muted">{{ total.known ? `≈ ${money(total.usd)}` : "" }}</span>
        <button type="button" class="text-sm text-muted hover:text-fg" @click="selected = new Set()">{{ t("inbox.clear") }}</button>
        <button type="button" class="ml-auto inline-flex min-h-10 items-center gap-2 rounded-md bg-accent px-4 font-semibold text-bg" @click="openStart">
          <Play :size="16" aria-hidden="true" />{{ t("inbox.startWith", { flow: "fix-issue" }) }}
        </button>
      </div>
    </div>

    <!-- Item panel -->
    <aside v-if="current" class="flex w-[28rem] shrink-0 flex-col overflow-auto border-l border-line bg-surface max-md:w-full max-md:border-l-0" :aria-label="t('inbox.panel')">
      <div class="flex items-start gap-2 border-b border-line p-4">
        <div class="min-w-0 flex-1">
          <p class="font-mono text-xs text-muted">{{ current.repo }}#{{ current.number }} · {{ projectName(current.project_id) }}</p>
          <h2 class="mt-1 font-semibold break-words">{{ current.title }}</h2>
          <div class="mt-2 flex flex-wrap items-center gap-2">
            <StatusBadge :look="itemLook[current.status]" :status="`item_${current.status}`" />
            <a :href="current.url" target="_blank" rel="noopener noreferrer" class="inline-flex items-center gap-1 text-xs text-accent hover:underline">
              {{ t("inbox.onGithub") }}<ExternalLink :size="12" aria-hidden="true" />
            </a>
          </div>
        </div>
        <button type="button" class="rounded p-2 text-muted hover:bg-surface-2 hover:text-fg" :aria-label="t('inbox.close')" @click="current = null"><X :size="18" aria-hidden="true" /></button>
      </div>
      <section v-if="current.triage" class="space-y-2 border-b border-line p-4 text-sm">
        <h3 class="text-xs font-medium tracking-wide text-muted uppercase">{{ t("inbox.triage") }}</h3>
        <dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
          <dt class="text-muted">{{ t("inbox.cols.kind") }}</dt><dd>{{ t(`inbox.kinds.${current.triage.kind}`) }}</dd>
          <dt class="text-muted">{{ t("inbox.cols.complexity") }}</dt><dd class="font-mono">{{ current.triage.complexity }}/5</dd>
          <dt class="text-muted">{{ t("inbox.cols.area") }}</dt><dd>{{ current.triage.area || "—" }}</dd>
          <dt class="text-muted">{{ t("inbox.cols.action") }}</dt>
          <dd>{{ current.triage.duplicate_of ? `${t("inbox.duplicateOf")} #${current.triage.duplicate_of}` : t(`inbox.actions.${current.triage.suggested_action}`) }}</dd>
          <dt class="text-muted">{{ t("inbox.cols.estimate") }}</dt>
          <dd>
            <template v-if="current.estimate"><span class="font-mono">≈ {{ money(current.estimate.usd) }}</span> · {{ t("inbox.estimateHint", { n: current.estimate.runs }) }}</template>
            <span v-else class="text-muted">{{ t("inbox.noEstimate") }}</span>
          </dd>
        </dl>
        <p class="text-muted">“{{ current.triage.reason }}” <span class="text-xs">· {{ current.triage_model }}</span></p>
      </section>
      <section v-if="current.runs.length" class="border-b border-line p-4 text-sm">
        <h3 class="mb-2 text-xs font-medium tracking-wide text-muted uppercase">{{ t("inbox.runs") }}</h3>
        <ul class="space-y-1">
          <li v-for="id in current.runs" :key="id"><RouterLink :to="`/runs/${id}`" class="font-mono text-accent hover:underline">{{ id }}</RouterLink></li>
        </ul>
      </section>
      <section class="flex-1 p-4">
        <h3 class="mb-2 text-xs font-medium tracking-wide text-muted uppercase">{{ t("inbox.body") }}</h3>
        <p class="mb-2 text-xs text-muted">{{ t("inbox.untrusted") }}</p>
        <!-- Plain text only: issue bodies are third-party content and are never rendered as HTML. -->
        <pre class="font-sans text-sm break-words whitespace-pre-wrap">{{ current.body || t("inbox.noBody") }}</pre>
      </section>
      <div class="flex gap-2 border-t border-line p-4">
        <button
          v-if="current.status !== 'dismissed'"
          type="button"
          class="inline-flex min-h-10 items-center gap-2 rounded-md border border-line px-3 text-sm hover:bg-surface-2"
          @click="dismiss()"
        ><Ban :size="15" aria-hidden="true" />{{ t("inbox.dismiss") }}</button>
        <button v-else type="button" class="inline-flex min-h-10 items-center gap-2 rounded-md border border-line px-3 text-sm hover:bg-surface-2" @click="dismiss(true)">
          <RotateCcw :size="15" aria-hidden="true" />{{ t("inbox.restore") }}
        </button>
      </div>
    </aside>

    <dialog ref="dialog" class="m-auto w-[min(34rem,calc(100%-2rem))] rounded-lg border border-line bg-surface p-0 text-fg backdrop:bg-black/60" :aria-label="t('inbox.startTitle')">
      <form method="dialog" class="space-y-4 p-5" @submit.prevent="start">
        <h2 class="text-lg font-semibold">{{ t("inbox.startTitle") }}</h2>
        <p class="text-sm">{{ t("inbox.startWhat", { n: chosen.length, flow: team ? "team" : "fix-issue" }) }}</p>
        <ul class="max-h-48 space-y-1 overflow-auto rounded-md border border-line p-2 text-sm">
          <li v-for="i in chosen" :key="i.id" class="flex gap-2">
            <span class="font-mono text-muted">#{{ i.number }}</span>
            <span class="min-w-0 flex-1 truncate">{{ i.title }}</span>
            <span class="font-mono text-muted">{{ i.estimate ? money(i.estimate.usd) : "—" }}</span>
          </li>
        </ul>
        <p class="text-sm text-muted">{{ t("inbox.startHow") }}</p>
        <p class="text-sm font-medium">
          {{ total.known ? t("inbox.total", { usd: money(total.usd), n: chosen.length }) : t("inbox.totalNone") }}
          <span v-if="total.unknown && total.known" class="text-muted">· {{ t("inbox.withoutEstimate", { n: total.unknown }) }}</span>
        </p>
        <label v-if="!mobile" class="flex items-start gap-3 text-sm">
          <input v-model="team" type="checkbox" class="mt-1 size-4" />
          <span>
            <span class="block font-medium">{{ t("newRun.team") }}</span>
            <span class="block text-xs text-muted">{{ t("newRun.teamHint") }}</span>
          </span>
        </label>
        <label v-if="!mobile" class="flex items-center gap-3 text-sm">
          <span>{{ t("inbox.budget") }}</span>
          <input v-model.number="budget" type="number" min="0.1" step="0.1" :placeholder="t('inbox.budgetDefault')" class="min-h-9 w-32 rounded-md border border-line bg-bg px-2 font-mono" />
        </label>
        <ul v-if="startErrors.length" class="tone-danger space-y-1 text-sm" style="color: var(--tone)" role="alert">
          <li v-for="e in startErrors" :key="e.item_id">{{ e.item_id ? `${e.item_id}: ` : "" }}{{ e.message }}</li>
        </ul>
        <div class="flex justify-end gap-2">
          <button type="button" class="min-h-10 rounded-md border border-line px-4 text-sm hover:bg-surface-2" @click="dialog?.close()">{{ t("inbox.cancel") }}</button>
          <button type="submit" :disabled="starting || !chosen.length" class="inline-flex min-h-10 items-center gap-2 rounded-md bg-accent px-4 text-sm font-semibold text-bg disabled:opacity-60">
            <Play :size="15" aria-hidden="true" />{{ starting ? t("inbox.starting") : t("inbox.start", { n: chosen.length }) }}
          </button>
        </div>
      </form>
    </dialog>
  </div>
</template>
