<script setup lang="ts">
import type { BudgetView, ModelMetricsView } from "@navarch/contracts";
import { ArrowDown, ArrowUp, CircleAlert, CircleCheck, Coins, Gauge, Pencil, TriangleAlert, Wallet } from "@lucide/vue";
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { api, client } from "../api/client.ts";
import QuotaBars from "../components/QuotaBars.vue";
import { money } from "../lib/status.ts";
import { budgetPercent, budgetTone, compactTokens, sortModels, visibleBudgets, type SortKey } from "../lib/usage.ts";
import { useUsageStore } from "../stores/runs.ts";

/**
 * Usage (ADR 0023): budgets on billed use, spend today and this month, observed metrics per
 * agent and model, and quota windows. Budgets are changed only from the PC, never from a phone.
 */
const { t } = useI18n();
const usage = useUsageStore();
const canEdit = computed(() => client() !== "mobile");

onMounted(() => void usage.load());

const budgets = computed(() => visibleBudgets(usage.view?.budgets ?? []));
const profiles = ["triager", "planner", "implementer", "reviewer", "lead", "researcher"];

async function setWindow(days: number) {
  usage.days = days;
  await usage.load();
}
async function setProfile(profile: string) {
  usage.profile = profile || null;
  await usage.load();
}

const sortKey = ref<SortKey>("tasks");
const sortDir = ref<"asc" | "desc">("desc");
const models = computed(() => sortModels(usage.view?.models ?? [], sortKey.value, sortDir.value));
function sortBy(key: SortKey) {
  if (sortKey.value === key) sortDir.value = sortDir.value === "asc" ? "desc" : "asc";
  else {
    sortKey.value = key;
    sortDir.value = key === "id" ? "asc" : "desc";
  }
}
const ariaSort = (key: SortKey) => (sortKey.value === key ? (sortDir.value === "asc" ? "ascending" : "descending") : "none");
const columns: { key: SortKey; label: string; numeric: boolean }[] = [
  { key: "id", label: "model", numeric: false },
  { key: "tasks", label: "tasks", numeric: true },
  { key: "success_rate", label: "success", numeric: true },
  { key: "error_rate_24h", label: "errors24h", numeric: true },
  { key: "tokens", label: "tokens", numeric: true },
  { key: "median_tokens_per_success", label: "tokensPerSuccess", numeric: true },
  { key: "median_cost_per_success", label: "costPerSuccess", numeric: true },
  { key: "cost", label: "billed", numeric: true },
  { key: "plan_cost", label: "planEquivalent", numeric: true },
  { key: "p50_duration_ms", label: "duration", numeric: true },
];

const pct = (n: number | null) => (n === null ? "—" : `${Math.round(n * 100)}%`);
const seconds = (ms: number | null) => (ms === null ? "—" : ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)} s`);
function scopeLabel(b: BudgetView): string {
  if (b.scope === "global_monthly") return t("usage.scope.global_monthly", { period: b.period });
  if (b.scope === "project_daily") return t("usage.scope.project_daily", { name: b.label });
  return t("usage.scope.run", { name: b.label });
}
const stateIcon = { ok: CircleCheck, warning: TriangleAlert, exceeded: CircleAlert };

/** The limit being edited: what it is now, the new value, and whether the user removes it. */
const editing = ref<{ budget: BudgetView; amount: string; none: boolean } | null>(null);
const saving = ref(false);
const editError = ref<string | null>(null);
const notice = ref<string | null>(null);
function edit(b: BudgetView) {
  editing.value = { budget: b, amount: b.limit === null ? "" : String(b.limit), none: b.limit === null };
  editError.value = null;
}
async function save() {
  const e = editing.value;
  if (!e) return;
  const usd = e.none ? null : Number(e.amount);
  if (usd !== null && !(usd > 0)) return void (editError.value = t("usage.invalidAmount"));
  saving.value = true;
  try {
    await api.setBudget({ scope: e.budget.scope, ...(e.budget.target ? { target: e.budget.target } : {}), usd });
    editing.value = null;
    notice.value = t("usage.saved");
    await usage.load();
  } catch (err) {
    editError.value = (err as Error).message;
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <section class="mx-auto max-w-6xl space-y-5 p-6 max-md:p-4">
    <header>
      <h1 class="text-xl font-semibold">{{ t("usage.title") }}</h1>
      <p class="mt-1 max-w-3xl text-sm text-muted">{{ t("usage.subtitle") }}</p>
    </header>
    <p v-if="usage.error" class="tone-danger text-sm" style="color: var(--tone)" role="alert">{{ usage.error }}</p>
    <p v-if="notice" class="tone-success flex items-center gap-2 text-sm" style="color: var(--tone)" role="status">
      <CircleCheck :size="16" aria-hidden="true" />{{ notice }}
    </p>

    <div v-if="usage.view" class="grid gap-3 sm:grid-cols-2">
      <div v-for="period in (['today', 'month'] as const)" :key="period" class="rounded-lg border border-line bg-surface p-4">
        <h2 class="flex items-center gap-2 text-sm font-medium"><Coins :size="16" class="text-accent" aria-hidden="true" />{{ t(`usage.${period}`) }}</h2>
        <p class="mt-1 font-mono text-2xl font-semibold">{{ money(usage.view[period].cost) }} <span class="text-sm font-normal text-muted">{{ t("usage.billed") }}</span></p>
        <p class="text-xs text-muted">
          {{ t("usage.planEquivalentAmount", { amount: money(usage.view[period].plan_cost) }) }} ·
          {{ t("usage.tokens", { n: compactTokens(usage.view[period].tokens) }) }}
        </p>
      </div>
    </div>

    <div class="rounded-lg border border-line bg-surface p-4">
      <h2 class="mb-3 flex items-center gap-2 text-sm font-medium"><Wallet :size="16" class="text-accent" aria-hidden="true" />{{ t("usage.budgets") }}</h2>
      <p v-if="!canEdit" class="mb-3 text-xs text-muted">{{ t("usage.deviceNote") }}</p>
      <ul class="space-y-4">
        <li v-for="b in budgets" :key="`${b.scope}-${b.target}`" :class="`tone-${budgetTone[b.state]}`">
          <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm">
            <span class="font-medium">{{ scopeLabel(b) }}</span>
            <span class="flex items-center gap-1 text-xs" :style="b.state === 'ok' ? '' : 'color: var(--tone)'">
              <component :is="stateIcon[b.state]" :size="13" aria-hidden="true" />{{ t(`usage.state.${b.limit === null ? 'none' : b.state}`) }}
            </span>
            <span class="ml-auto font-mono text-xs">
              {{ b.limit === null ? `${money(b.used)} · ${t("usage.noLimit")}` : t("usage.usedOf", { used: money(b.used), limit: money(b.limit), pct: budgetPercent(b) }) }}
            </span>
            <button
              v-if="canEdit"
              type="button"
              class="inline-flex min-h-8 items-center gap-1 rounded-md border border-line px-2 text-xs text-muted hover:bg-surface-2 hover:text-fg"
              :aria-label="t('usage.editFor', { scope: scopeLabel(b) })"
              @click="edit(b)"
            >
              <Pencil :size="12" aria-hidden="true" />{{ t("usage.edit") }}
            </button>
          </div>
          <div
            v-if="budgetPercent(b) !== null"
            class="mt-1.5 h-2 overflow-hidden rounded-full bg-surface-2"
            role="meter"
            :aria-label="scopeLabel(b)"
            aria-valuemin="0"
            aria-valuemax="100"
            :aria-valuenow="budgetPercent(b) ?? 0"
          >
            <div class="h-full rounded-full" :style="{ width: `${budgetPercent(b)}%`, background: 'var(--tone)' }" />
          </div>
          <p class="mt-1 text-[11px] text-muted">
            {{ t(`usage.source.${b.source}`) }}<template v-if="b.plan_equivalent > 0"> · {{ t("usage.planEquivalentAmount", { amount: money(b.plan_equivalent) }) }}</template>
          </p>

          <form
            v-if="editing && editing.budget === b"
            class="mt-3 space-y-3 rounded-md border border-line bg-bg p-3 text-sm"
            :aria-label="t('usage.editTitle', { scope: scopeLabel(b) })"
            @submit.prevent="save"
          >
            <p class="font-medium">{{ t("usage.editTitle", { scope: scopeLabel(b) }) }}</p>
            <p class="text-xs text-muted">{{ t("usage.current", { limit: b.limit === null ? t("usage.noLimit") : money(b.limit) }) }}</p>
            <div class="flex flex-wrap items-center gap-3">
              <label class="flex items-center gap-2">
                <span>{{ t("usage.newLimit") }}</span>
                <input
                  v-model="editing.amount"
                  type="number"
                  min="0.01"
                  step="0.01"
                  inputmode="decimal"
                  :disabled="editing.none"
                  class="min-h-10 w-28 rounded-md border border-line bg-surface px-2 font-mono"
                />
              </label>
              <label v-if="b.scope !== 'run'" class="flex items-center gap-2">
                <input v-model="editing.none" type="checkbox" class="size-4" />{{ t("usage.removeLimit") }}
              </label>
            </div>
            <p class="text-xs text-muted">{{ t("usage.editEffect") }}</p>
            <p v-if="editError" class="tone-danger text-xs" style="color: var(--tone)" role="alert">{{ editError }}</p>
            <div class="flex gap-2">
              <button type="submit" :disabled="saving" class="min-h-10 rounded-md bg-accent px-4 font-semibold text-bg disabled:opacity-60">{{ t("usage.save") }}</button>
              <button type="button" class="min-h-10 rounded-md border border-line px-4" @click="editing = null">{{ t("usage.cancel") }}</button>
            </div>
          </form>
        </li>
      </ul>
    </div>

    <div class="rounded-lg border border-line bg-surface">
      <div class="flex flex-wrap items-center gap-3 px-4 pt-4 pb-3">
        <h2 class="flex items-center gap-2 text-sm font-medium"><Gauge :size="16" class="text-accent" aria-hidden="true" />{{ t("usage.models") }}</h2>
        <div class="ml-auto flex flex-wrap items-center gap-2 text-xs">
          <div role="group" :aria-label="t('usage.window')" class="flex overflow-hidden rounded-md border border-line">
            <button
              v-for="d in [7, 30]"
              :key="d"
              type="button"
              class="min-h-8 px-3"
              :class="usage.days === d ? 'bg-surface-2 text-fg' : 'text-muted hover:text-fg'"
              :aria-pressed="usage.days === d"
              @click="setWindow(d)"
            >
              {{ t("usage.days", { n: d }) }}
            </button>
          </div>
          <label class="flex items-center gap-1.5 text-muted">
            {{ t("usage.profile") }}
            <select class="min-h-8 rounded-md border border-line bg-surface px-2 text-fg" :value="usage.profile ?? ''" @change="setProfile(($event.target as HTMLSelectElement).value)">
              <option value="">{{ t("usage.allProfiles") }}</option>
              <option v-for="p in profiles" :key="p" :value="p">{{ p }}</option>
            </select>
          </label>
        </div>
      </div>
      <p v-if="usage.view && !models.length" class="px-4 pb-4 text-sm text-muted">{{ t("usage.noModels") }}</p>
      <div v-else class="overflow-x-auto">
        <table class="w-full border-collapse text-sm">
          <caption class="sr-only">{{ t("usage.models") }}</caption>
          <thead class="text-xs tracking-wide whitespace-nowrap text-muted uppercase">
            <tr class="border-y border-line">
              <th v-for="c in columns" :key="c.key" scope="col" :aria-sort="ariaSort(c.key)" class="px-3 py-2 font-medium first:pl-4" :class="c.numeric ? 'text-right' : 'text-left'">
                <button type="button" class="inline-flex items-center gap-1 uppercase hover:text-fg" @click="sortBy(c.key)">
                  {{ t(`usage.col.${c.label}`) }}
                  <component :is="sortDir === 'asc' ? ArrowUp : ArrowDown" v-if="sortKey === c.key" :size="12" aria-hidden="true" />
                </button>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="m in models" :key="m.id" class="border-b border-line font-mono text-xs last:border-0">
              <th scope="row" class="py-2 pr-3 pl-4 text-left font-sans text-sm font-medium">
                {{ m.id }}
                <span class="ml-1 rounded border border-line px-1 font-sans text-[10px] font-normal text-muted uppercase">{{ t(`usage.billing.${m.billing}`) }}</span>
              </th>
              <td class="px-3 py-2 text-right">{{ m.succeeded }}/{{ m.tasks }}</td>
              <td class="px-3 py-2 text-right">{{ pct(m.success_rate) }}</td>
              <td class="px-3 py-2 text-right" :title="m.error_rate_24h === null ? t('usage.noHistory') : undefined">{{ pct(m.error_rate_24h) }}</td>
              <td class="px-3 py-2 text-right whitespace-nowrap">{{ compactTokens(m.tokens_in) }} / {{ compactTokens(m.tokens_out) }}</td>
              <td class="px-3 py-2 text-right">{{ m.median_tokens_per_success === null ? "—" : compactTokens(m.median_tokens_per_success) }}</td>
              <td class="px-3 py-2 text-right">{{ m.median_cost_per_success === null ? "—" : money(m.median_cost_per_success) }}</td>
              <td class="px-3 py-2 text-right">{{ money(m.cost) }}</td>
              <td class="px-3 py-2 text-right text-muted">{{ money(m.plan_cost) }}</td>
              <td class="px-3 py-2 pr-4 text-right">{{ seconds(m.p50_duration_ms) }}</td>
            </tr>
          </tbody>
        </table>
        <p class="px-4 py-3 text-[11px] text-muted">{{ t("usage.modelsHint") }}</p>
      </div>
    </div>

    <div class="rounded-lg border border-line bg-surface p-4">
      <h2 class="mb-3 flex items-center gap-2 text-sm font-medium"><Gauge :size="16" class="text-accent" aria-hidden="true" />{{ t("quota.title") }}</h2>
      <QuotaBars :quotas="usage.view?.quotas ?? []" />
    </div>
  </section>
</template>
