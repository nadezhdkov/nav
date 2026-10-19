<script setup lang="ts">
import type { ScheduleDay, ScheduleView } from "@navarch/contracts";
import { CalendarClock, Pause, Play, Trash2 } from "@lucide/vue";
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { api, client } from "../api/client.ts";
import { useProjectsStore, useSchedulesStore } from "../stores/runs.ts";

/**
 * Scheduled runs (ADR 0064): a prompt the daemon starts on a timetable in a registered project, with a
 * budget. Only the desktop sets them; the daemon starts them through the same path as any run, so
 * autonomy levels, approvals and budgets still apply. Prompts and messages are plain text.
 */
const { t, locale } = useI18n();
const schedules = useSchedulesStore();
const projects = useProjectsStore();
const canEdit = computed(() => client() !== "mobile");

const DAYS: ScheduleDay[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const name = ref("");
const projectId = ref("");
const prompt = ref("");
const at = ref("03:00");
const days = ref<ScheduleDay[]>([...DAYS]);
const budget = ref("1");
const busy = ref(false);
const failure = ref<string | null>(null);

onMounted(() => void schedules.load());

const valid = computed(() => name.value.trim() && projectId.value && prompt.value.trim().length >= 3 && days.value.length && Number(budget.value) > 0 && /^\d\d:\d\d$/.test(at.value));

function toggleDay(d: ScheduleDay) {
  days.value = days.value.includes(d) ? days.value.filter((x) => x !== d) : DAYS.filter((x) => x === d || days.value.includes(x));
}

async function create() {
  busy.value = true;
  failure.value = null;
  try {
    await api.saveSchedule({ name: name.value.trim(), project_id: projectId.value, prompt: prompt.value.trim(), budget: Number(budget.value), at: at.value, days: days.value, enabled: true });
    name.value = "";
    prompt.value = "";
    await schedules.load();
  } catch (err) {
    failure.value = (err as Error).message;
  } finally {
    busy.value = false;
  }
}

async function act(run: () => Promise<unknown>) {
  failure.value = null;
  try {
    await run();
  } catch (err) {
    failure.value = (err as Error).message;
  }
  await schedules.load();
}

const toggle = (s: ScheduleView) => act(() => api.setScheduleEnabled(s.id, !s.enabled));
const drop = (s: ScheduleView) => act(() => api.removeSchedule(s.id));
const daysText = (s: ScheduleView) => (s.days.length === 7 ? t("schedules.daily") : s.days.map((d) => t(`schedules.day.${d}`)).join(", "));
const when = (iso: string) => new Date(iso).toLocaleString(locale.value);
</script>

<template>
  <section class="mx-auto max-w-3xl space-y-5 p-6 max-md:p-4">
    <header>
      <h1 class="flex items-center gap-2 text-xl font-semibold"><CalendarClock :size="20" aria-hidden="true" />{{ t("schedules.title") }}</h1>
      <p class="mt-1 text-sm text-muted">{{ t("schedules.intro") }}</p>
    </header>

    <p v-if="failure" class="tone-danger rounded-md border p-3 text-sm" style="border-color: var(--tone); color: var(--tone)" role="alert">{{ failure }}</p>

    <ul class="space-y-3">
      <li v-for="s in schedules.list" :key="s.id" class="rounded-lg border border-line bg-surface p-4">
        <div class="flex flex-wrap items-center gap-2">
          <h2 class="font-medium">{{ s.name }}</h2>
          <span class="text-xs text-muted">{{ s.repo ?? s.project_id }}</span>
          <span v-if="!s.enabled" class="rounded-full border border-line px-2 text-xs text-muted">{{ t("schedules.paused") }}</span>
          <div v-if="canEdit" class="ml-auto flex gap-1">
            <button type="button" class="grid size-11 place-items-center rounded-md border border-line hover:bg-surface-2" :aria-label="s.enabled ? t('schedules.pause') : t('schedules.resume')" @click="toggle(s)">
              <component :is="s.enabled ? Pause : Play" :size="16" aria-hidden="true" />
            </button>
            <button type="button" class="grid size-11 place-items-center rounded-md border border-line hover:bg-surface-2" :aria-label="t('schedules.remove')" @click="drop(s)">
              <Trash2 :size="16" aria-hidden="true" />
            </button>
          </div>
        </div>
        <p class="mt-1 whitespace-pre-wrap break-words text-sm">{{ s.prompt }}</p>
        <p class="mt-2 text-xs text-muted">{{ daysText(s) }} · {{ s.at }} · {{ t("schedules.budget", { usd: s.budget }) }}<template v-if="s.flow"> · {{ s.flow }}</template></p>
        <p class="mt-1 text-xs text-muted">
          <template v-if="s.enabled && s.next_at">{{ t("schedules.next", { when: when(s.next_at) }) }}</template>
          <template v-if="s.last_outcome"> · {{ t(`schedules.outcome.${s.last_outcome}`) }} ({{ s.last_slot }})</template>
          <template v-if="s.last_outcome === 'started' && s.last_run_id"> · <RouterLink :to="`/runs/${s.last_run_id}`" class="text-accent hover:underline">{{ t("schedules.openRun") }}</RouterLink></template>
        </p>
        <p v-if="s.last_message" class="mt-1 whitespace-pre-wrap break-words text-xs text-muted">{{ s.last_message }}</p>
      </li>
      <li v-if="schedules.loaded && !schedules.list.length" class="text-sm text-muted">{{ t("schedules.empty") }}</li>
    </ul>

    <form v-if="canEdit" class="space-y-3 rounded-lg border border-line bg-surface p-4" @submit.prevent="create">
      <h2 class="font-medium">{{ t("schedules.new") }}</h2>
      <label class="block text-sm">{{ t("schedules.name") }}
        <input v-model="name" maxlength="60" class="mt-1 min-h-11 w-full rounded-md border border-line bg-bg px-3" />
      </label>
      <label class="block text-sm">{{ t("schedules.project") }}
        <select v-model="projectId" class="mt-1 min-h-11 w-full rounded-md border border-line bg-bg px-3">
          <option value="" disabled>{{ t("schedules.pickProject") }}</option>
          <option v-for="p in projects.projects" :key="p.id" :value="p.id">{{ p.repo }}</option>
        </select>
      </label>
      <label class="block text-sm">{{ t("schedules.prompt") }}
        <textarea v-model="prompt" rows="3" maxlength="4000" class="mt-1 w-full rounded-md border border-line bg-bg px-3 py-2" />
      </label>
      <div class="flex flex-wrap gap-4">
        <label class="block text-sm">{{ t("schedules.at") }}
          <input v-model="at" type="time" class="mt-1 block min-h-11 rounded-md border border-line bg-bg px-3" />
        </label>
        <label class="block text-sm">{{ t("schedules.budgetLabel") }}
          <input v-model="budget" type="number" min="0.1" step="0.1" class="mt-1 block min-h-11 w-28 rounded-md border border-line bg-bg px-3" />
        </label>
      </div>
      <fieldset>
        <legend class="text-sm">{{ t("schedules.days") }}</legend>
        <div class="mt-1 flex flex-wrap gap-2">
          <label v-for="d in DAYS" :key="d" class="inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-md border border-line px-3 text-sm" :class="days.includes(d) ? 'bg-surface-2' : ''">
            <input type="checkbox" :checked="days.includes(d)" class="size-4" @change="toggleDay(d)" />{{ t(`schedules.day.${d}`) }}
          </label>
        </div>
      </fieldset>
      <p class="text-xs text-muted">{{ t("schedules.note") }}</p>
      <button type="submit" :disabled="!valid || busy" class="min-h-11 rounded-md bg-accent px-4 font-medium text-bg disabled:opacity-50">{{ t("schedules.create") }}</button>
    </form>
  </section>
</template>
