<script setup lang="ts">
import { Newspaper, RefreshCw } from "@lucide/vue";
import { ref } from "vue";
import { useI18n } from "vue-i18n";
import { isDevice } from "../api/session.ts";
import { money } from "../lib/status.ts";
import { useSummaryStore } from "../stores/runs.ts";

/**
 * The morning summary (spec §7.4, ADR 0059). Issue titles come from GitHub and are untrusted (T1):
 * shown as plain text, on one line. Making one now syncs every project, so it is desktop only.
 */
const { t } = useI18n();
const store = useSummaryStore();
const busy = ref(false);
const error = ref<string | null>(null);

async function make() {
  busy.value = true;
  error.value = null;
  try {
    await store.make();
  } catch (err) {
    error.value = (err as Error).message;
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="rounded-lg border border-line bg-surface p-3" data-testid="summary-card">
    <div class="flex items-center gap-2">
      <h2 class="flex flex-1 items-center gap-2 text-sm font-medium">
        <Newspaper :size="16" class="text-accent" aria-hidden="true" />{{ t("home.summary.title") }}
        <span v-if="store.summary" class="font-normal text-muted">{{ new Date(store.summary.generated_at).toLocaleString() }}</span>
      </h2>
      <button
        v-if="!isDevice"
        type="button"
        class="inline-flex min-h-10 items-center gap-2 rounded-md border border-line px-3 text-sm hover:bg-surface-2 disabled:opacity-60"
        :disabled="busy"
        @click="make"
      ><RefreshCw :size="15" aria-hidden="true" />{{ busy ? t("home.summary.making") : t("home.summary.make") }}</button>
    </div>
    <p v-if="!store.summary" class="mt-2 text-sm text-muted">{{ t("home.summary.empty") }}</p>
    <div v-else class="mt-2 space-y-3 text-sm">
      <p class="text-muted">
        {{ t("home.summary.new") }}: <span class="text-fg">{{ store.summary.new_total }}</span>
        <template v-if="store.summary.duplicates"> · {{ store.summary.duplicates }} {{ t("home.summary.dups") }}</template>
        · {{ t("home.summary.ci") }}: <span class="text-fg">{{ store.summary.ci_failures.length }}</span>
        · {{ t("home.summary.stalled") }}: <span class="text-fg">{{ store.summary.stalled_prs.length }}</span>
        · {{ t("home.summary.approvals") }}: <span class="text-fg">{{ store.summary.approvals_waiting }}</span>
        · {{ t("home.summary.runs") }}: <span class="text-fg">{{ store.summary.runs_finished }}</span> ({{ store.summary.runs_failed }} {{ t("home.summary.failed") }})
        · {{ money(store.summary.billed_usd) }}
      </p>
      <div v-if="store.summary.suggestions.length">
        <h3 class="text-xs font-medium uppercase tracking-wide text-muted">
          {{ t("home.summary.worth") }} · {{ t("home.summary.estimate") }} {{ money(store.summary.suggestions_estimate_usd) }}
        </h3>
        <ul class="mt-1 space-y-1">
          <li v-for="i in store.summary.suggestions" :key="i.id" class="truncate">
            <RouterLink to="/inbox" class="hover:text-accent">{{ i.repo }}#{{ i.number }} {{ i.title }}</RouterLink>
            <span class="text-muted"> · {{ i.kind ?? t("home.summary.untriaged") }}<template v-if="i.complexity"> {{ i.complexity }}/5</template><template v-if="i.estimate_usd !== null"> · {{ money(i.estimate_usd) }}</template></span>
          </li>
        </ul>
      </div>
      <RouterLink to="/inbox" class="inline-block text-accent hover:underline">{{ t("home.summary.open") }}</RouterLink>
    </div>
    <p v-if="error" class="mt-1.5 text-xs" style="color: var(--tone-danger)" role="alert">{{ error }}</p>
  </div>
</template>
