<script setup lang="ts">
import { reachable } from "../api/client.ts";
import type { ApprovalView } from "@navarch/contracts";
import { Check, Hand, X } from "@lucide/vue";
import { computed, nextTick, reactive, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute } from "vue-router";
import { ago, money } from "../lib/status.ts";
import { useApprovalsStore, useRunsStore } from "../stores/runs.ts";

/** Approvals (spec §6.10.3): what will happen, why, and the run's cost, before the human decides. */
const { t } = useI18n();
const store = useApprovalsStore();
const runs = useRunsStore();
const reasons = reactive<Record<string, string>>({});
const busy = reactive<Record<string, boolean>>({});
const errors = reactive<Record<string, string>>({});
// An approval with choices (a compete pick, ADR 0031) starts on its default, the first one.
const picks = reactive<Record<string, string>>({});
const pickOf = (a: ApprovalView) => picks[a.id] ?? a.choices[0];

// A notification opens `/approvals?focus=<id>` (ADR 0020): bring that approval into view.
const route = useRoute();
const focus = computed(() => (typeof route?.query.focus === "string" ? route.query.focus : null));
watch(
  () => [focus.value, store.pending.length] as const,
  async ([id]) => {
    if (!id) return;
    await nextTick();
    document.getElementById(`approval-${id}`)?.scrollIntoView({ block: "start" });
  },
  { immediate: true },
);

const decided = computed(() => store.approvals.filter((a) => a.status !== "pending").slice(0, 20));
const runOf = (a: ApprovalView) => runs.runs.find((r) => r.id === a.run_id);

async function decide(a: ApprovalView, decision: "approve" | "reject") {
  busy[a.id] = true;
  delete errors[a.id];
  try {
    const reason = reasons[a.id]?.trim() || undefined;
    await (decision === "approve" && a.choices.length ? store.decide(a.id, decision, reason, pickOf(a)) : store.decide(a.id, decision, reason));
  } catch (err) {
    errors[a.id] = (err as Error).message;
  } finally {
    busy[a.id] = false;
  }
}
</script>

<template>
  <section class="max-w-4xl p-6 max-md:p-4">
    <h1 class="mb-4 text-xl font-semibold">{{ t("approvals.title") }}</h1>
    <template v-if="store.error">
      <!-- Unreachable: App shows why; repeating the raw error here would only add noise. -->
      <p v-if="reachable" class="tone-danger mb-3 text-sm" style="color: var(--tone)" role="alert">{{ store.error }}</p>
    </template>

    <h2 class="mb-2 text-sm font-medium tracking-wide text-muted uppercase">{{ t("approvals.pending") }}</h2>
    <p v-if="store.loaded && !store.error && !store.pending.length" class="rounded-lg border border-dashed border-line p-6 text-center text-muted">
      {{ t("approvals.empty") }}
    </p>
    <article
      v-for="a in store.pending"
      :id="`approval-${a.id}`"
      :key="a.id"
      class="tone-warning mb-3 scroll-mt-4 rounded-lg border bg-surface p-4"
      :class="{ 'ring-2 ring-accent': a.id === focus }"
      style="border-color: color-mix(in srgb, var(--tone) 50%, transparent)"
      :aria-labelledby="`apr-${a.id}`"
    >
      <header class="mb-3 flex flex-wrap items-center gap-2">
        <Hand :size="16" style="color: var(--tone)" aria-hidden="true" />
        <h3 :id="`apr-${a.id}`" class="font-semibold">{{ a.action }}</h3>
        <span class="font-mono text-xs text-muted">{{ a.id }}</span>
        <RouterLink :to="`/runs/${a.run_id}`" class="ml-auto text-sm text-accent hover:underline">{{ t("approvals.run") }} {{ a.run_id }}</RouterLink>
      </header>
      <dl class="space-y-2 text-sm">
        <div>
          <dt class="text-xs tracking-wide text-muted uppercase">{{ t("approvals.what") }}</dt>
          <dd><pre class="mt-1 max-h-80 overflow-auto rounded-md border border-line bg-bg p-2 font-mono text-xs whitespace-pre-wrap">{{ a.summary }}</pre></dd>
        </div>
        <div>
          <dt class="text-xs tracking-wide text-muted uppercase">{{ t("approvals.why") }}</dt>
          <dd>{{ a.reason }}</dd>
        </div>
        <div v-if="runOf(a)">
          <dt class="text-xs tracking-wide text-muted uppercase">{{ t("approvals.cost") }}</dt>
          <dd class="font-mono text-xs">{{ money(runOf(a)!.cost_total) }} / {{ money(runOf(a)!.budget) }}</dd>
        </div>
      </dl>
      <fieldset v-if="a.choices.length" class="mt-3">
        <legend class="mb-1.5 text-xs tracking-wide text-muted uppercase">{{ t("approvals.pick") }}</legend>
        <div class="flex flex-wrap gap-2">
          <label
            v-for="(c, i) in a.choices"
            :key="c"
            class="inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-md border px-3 text-sm"
            :class="pickOf(a) === c ? 'border-accent bg-accent/10' : 'border-line'"
          >
            <input type="radio" :name="`pick-${a.id}`" :value="c" :checked="pickOf(a) === c" class="accent-current" @change="picks[a.id] = c" />
            <span class="font-mono">{{ c }}</span>
            <span v-if="i === 0" class="text-xs text-muted">{{ t("approvals.suggested") }}</span>
          </label>
        </div>
      </fieldset>
      <div class="mt-3 flex flex-wrap items-center gap-2">
        <label :for="`reason-${a.id}`" class="sr-only">{{ t("approvals.reason") }}</label>
        <input :id="`reason-${a.id}`" v-model="reasons[a.id]" :placeholder="t('approvals.reason')" class="min-h-11 min-w-48 flex-1 rounded-md border border-line bg-bg px-3 text-sm" />
        <button :disabled="busy[a.id]" class="tone-success inline-flex min-h-11 items-center max-sm:flex-1 max-sm:justify-center gap-1.5 rounded-md px-4 font-medium whitespace-nowrap disabled:opacity-60" style="background: var(--tone); color: var(--bg)" @click="decide(a, 'approve')">
          <Check :size="16" aria-hidden="true" />{{ a.choices.length ? t("approvals.approvePick", { choice: pickOf(a) }) : t("approvals.approve") }}
        </button>
        <button :disabled="busy[a.id]" class="tone-danger inline-flex min-h-11 items-center max-sm:flex-1 max-sm:justify-center gap-1.5 rounded-md border px-4 font-medium disabled:opacity-60" style="color: var(--tone); border-color: var(--tone)" @click="decide(a, 'reject')">
          <X :size="16" aria-hidden="true" />{{ t("approvals.reject") }}
        </button>
      </div>
      <p v-if="errors[a.id]" class="tone-danger mt-2 text-sm" style="color: var(--tone)" role="alert">{{ errors[a.id] }}</p>
    </article>

    <template v-if="decided.length">
      <h2 class="mt-8 mb-2 text-sm font-medium tracking-wide text-muted uppercase">{{ t("approvals.decided") }}</h2>
      <ul class="divide-y divide-line rounded-lg border border-line bg-surface text-sm">
        <li v-for="a in decided" :key="a.id" class="flex flex-wrap items-center gap-3 px-4 py-2.5">
          <span class="font-medium">{{ a.action }}</span>
          <RouterLink :to="`/runs/${a.run_id}`" class="font-mono text-xs text-muted hover:text-accent">{{ a.run_id }}</RouterLink>
          <span v-if="a.choice" class="font-mono text-xs">{{ t("approvals.picked", { choice: a.choice }) }}</span>
          <span class="ml-auto text-xs text-muted">{{ t("approvals.by", { status: t(`status.${a.status}`), when: ago(a.decided_at ?? a.created_at) }) }}</span>
        </li>
      </ul>
    </template>
  </section>
</template>
