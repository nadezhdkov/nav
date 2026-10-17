<script setup lang="ts">
import type { AwayDelegate } from "@navarch/contracts";
import { CircleAlert, CircleCheck, RotateCcw, ShieldCheck, TriangleAlert, UserRound } from "@lucide/vue";
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { client } from "../api/client.ts";
import { useAwayStore } from "../stores/runs.ts";

/**
 * Away mode (ADR 0039): hand some approvals to an approver agent while you are busy. Turning it
 * on needs the warning read and an explicit yes; only the desktop changes it, never a phone.
 */
const { t } = useI18n();
const away = useAwayStore();
const canEdit = computed(() => client() !== "mobile");
const all: AwayDelegate[] = ["plan", "pr", "start"];

const delegate = ref<AwayDelegate[]>(["plan", "pr"]);
const minutes = ref<string>("240");
const maxComplexity = ref<string>("3");
const maxRevisions = ref(2);
const understood = ref(false);
const busy = ref(false);
const failure = ref<string | null>(null);

onMounted(() => void away.load());

const view = computed(() => away.view);
const canTurnOn = computed(() => understood.value && delegate.value.length > 0 && !busy.value);

async function turnOn() {
  busy.value = true;
  failure.value = null;
  try {
    await away.set({
      enabled: true,
      confirm: true,
      delegate: delegate.value,
      minutes: minutes.value === "forever" ? null : Number(minutes.value),
      max_complexity: maxComplexity.value === "none" ? null : Number(maxComplexity.value),
      max_revisions: maxRevisions.value,
    });
    understood.value = false;
  } catch (err) {
    failure.value = (err as Error).message;
  } finally {
    busy.value = false;
  }
}

async function turnOff() {
  busy.value = true;
  failure.value = null;
  try {
    await away.set({ enabled: false });
  } catch (err) {
    failure.value = (err as Error).message;
  } finally {
    busy.value = false;
  }
}

const verdictIcon = { approve: CircleCheck, revise: RotateCcw, escalate: UserRound } as const;
const verdictTone = { approve: "tone-success", revise: "tone-info", escalate: "tone-warning" } as const;
</script>

<template>
  <section class="mx-auto max-w-4xl p-6 max-md:p-4" :aria-label="t('away.title')">
    <header class="flex items-center gap-3">
      <ShieldCheck :size="24" aria-hidden="true" />
      <h1 class="text-xl font-semibold">{{ t("away.title") }}</h1>
      <span class="ml-auto rounded-full border border-line px-3 py-0.5 text-sm" :class="view?.active ? 'tone-warning' : 'text-muted'" :style="view?.active ? 'color: var(--tone)' : ''">
        {{ view?.active ? t("away.on") : t("away.off") }}
      </span>
    </header>
    <p class="mt-3 text-muted">{{ t("away.intro") }}</p>

    <p v-if="view?.active && view.unavailable" class="tone-warning mt-4 flex items-start gap-2 rounded-lg border p-3 text-sm" style="border-color: color-mix(in srgb, var(--tone) 45%, transparent)" role="alert">
      <CircleAlert :size="18" class="mt-0.5 shrink-0" aria-hidden="true" style="color: var(--tone)" />{{ t("away.unavailable", { reason: view.unavailable }) }}
    </p>
    <p v-if="failure" class="tone-danger mt-4 rounded-lg border p-3 text-sm" style="border-color: color-mix(in srgb, var(--tone) 45%, transparent)" role="alert">{{ failure }}</p>

    <!-- On: what was handed over, and the way out. -->
    <div v-if="view?.active && view.settings" class="mt-6 rounded-lg border border-line bg-surface p-4">
      <ul class="flex flex-wrap gap-2">
        <li v-for="s in view.settings.delegate" :key="s" class="rounded-full bg-surface-2 px-3 py-0.5 text-sm">{{ t(`away.delegate.${s}`) }}</li>
      </ul>
      <p class="mt-2 text-sm text-muted">
        {{ view.settings.until ? t("away.until", { time: new Date(view.settings.until).toLocaleString() }) : t("away.untilOff") }} ·
        {{ t("away.complexity") }}: {{ view.settings.max_complexity === null ? t("away.noLimit") : t("away.level", { n: view.settings.max_complexity }) }} ·
        {{ t("away.revisions") }} {{ t("away.times", { n: view.settings.max_revisions }) }}
      </p>
      <button v-if="canEdit" type="button" class="mt-4 inline-flex min-h-11 items-center gap-2 rounded-md border border-line px-4 font-medium hover:bg-surface-2 disabled:opacity-50" :disabled="busy" @click="turnOff">
        {{ t("away.turnOff") }}
      </button>
      <p v-else class="mt-3 text-sm text-muted">{{ t("away.phone") }}</p>
    </div>

    <!-- Off: the warning, the options, and an explicit yes. -->
    <form v-else-if="canEdit" class="mt-6 space-y-5 rounded-lg border border-line bg-surface p-4" @submit.prevent="turnOn">
      <div class="tone-warning rounded-md border p-3" style="border-color: color-mix(in srgb, var(--tone) 45%, transparent)">
        <p class="flex items-center gap-2 font-semibold" style="color: var(--tone)"><TriangleAlert :size="18" aria-hidden="true" />{{ t("away.warnTitle") }}</p>
        <ul class="mt-2 list-disc space-y-1 pl-6 text-sm">
          <li v-for="(line, i) in [t('away.warn[0]'), t('away.warn[1]'), t('away.warn[2]')]" :key="i">{{ line }}</li>
        </ul>
      </div>
      <fieldset>
        <legend class="font-medium">{{ t("away.hand") }}</legend>
        <label v-for="s in all" :key="s" class="mt-1 flex min-h-10 items-center gap-3">
          <input v-model="delegate" type="checkbox" :value="s" class="size-4" />{{ t(`away.delegate.${s}`) }}
        </label>
      </fieldset>
      <div class="grid gap-4 sm:grid-cols-3">
        <label class="block text-sm">{{ t("away.duration") }}
          <select v-model="minutes" class="mt-1 block min-h-10 w-full rounded-md border border-line bg-surface-2 px-2">
            <option value="60">{{ t("away.durations.60") }}</option>
            <option value="240">{{ t("away.durations.240") }}</option>
            <option value="480">{{ t("away.durations.480") }}</option>
            <option value="1440">{{ t("away.durations.1440") }}</option>
            <option value="forever">{{ t("away.durations.forever") }}</option>
          </select>
        </label>
        <label class="block text-sm">{{ t("away.complexity") }}
          <select v-model="maxComplexity" class="mt-1 block min-h-10 w-full rounded-md border border-line bg-surface-2 px-2">
            <option v-for="n in [1, 2, 3, 4]" :key="n" :value="String(n)">{{ t("away.level", { n }) }}</option>
            <option value="none">{{ t("away.noLimit") }}</option>
          </select>
        </label>
        <label class="block text-sm">{{ t("away.revisions") }}
          <select v-model.number="maxRevisions" class="mt-1 block min-h-10 w-full rounded-md border border-line bg-surface-2 px-2">
            <option v-for="n in [0, 1, 2, 3]" :key="n" :value="n">{{ t("away.times", { n }) }}</option>
          </select>
        </label>
      </div>
      <label class="flex items-start gap-3"><input v-model="understood" type="checkbox" class="mt-1 size-4" />{{ t("away.understand") }}</label>
      <button type="submit" class="inline-flex min-h-11 items-center gap-2 rounded-md bg-accent px-4 font-medium text-bg disabled:opacity-50" :disabled="!canTurnOn">
        <ShieldCheck :size="18" aria-hidden="true" />{{ t("away.turnOn") }}
      </button>
    </form>
    <p v-else class="mt-6 text-sm text-muted">{{ t("away.phone") }}</p>

    <!-- What the approver did since it was turned on. -->
    <section v-if="view?.settings" class="mt-8" :aria-label="t('away.log')">
      <h2 class="font-semibold">{{ t("away.log") }}</h2>
      <p class="mt-1 text-sm text-muted">{{ t("away.summary", view.counts) }}</p>
      <p v-if="!view.reviews.length" class="mt-3 text-sm text-muted">{{ t("away.empty") }}</p>
      <ul v-else class="mt-3 divide-y divide-line rounded-lg border border-line bg-surface">
        <li v-for="r in view.reviews" :key="r.approval_id" class="flex flex-wrap items-start gap-x-3 gap-y-1 p-3">
          <span :class="verdictTone[r.verdict]" class="inline-flex min-w-36 items-center gap-1.5 font-medium" style="color: var(--tone)">
            <component :is="verdictIcon[r.verdict]" :size="16" aria-hidden="true" />{{ t(`away.verdict.${r.verdict}`) }}
          </span>
          <span class="text-sm text-muted">{{ t(`away.subject.${r.subject}`) }}</span>
          <RouterLink v-if="r.run_id" :to="`/runs/${r.run_id}`" class="text-sm underline">{{ r.run_name ?? r.run_id }}</RouterLink>
          <span class="ml-auto text-xs text-muted">{{ new Date(r.at).toLocaleTimeString() }}</span>
          <p class="basis-full text-sm">{{ r.reason }}</p>
        </li>
      </ul>
    </section>
  </section>
</template>
