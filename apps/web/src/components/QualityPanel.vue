<script setup lang="ts">
import type { ModelMetricsView, QualityPanel } from "@navarch/contracts";
import { CircleAlert, CircleCheck, CircleDot, CircleSlash, GitMerge, GitPullRequest, Gauge, UserCog, XCircle } from "@lucide/vue";
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { meetsTarget, prTone, TARGETS } from "../lib/metrics.ts";
import { ago, money } from "../lib/status.ts";

/**
 * The quality panel (spec §6.15, ADR 0037): what became of the PRs Navarch opened, against the
 * §17 targets, and success rates per profile and model.
 */
const props = defineProps<{ panel: QualityPanel }>();
const { t } = useI18n();

const pr = computed(() => props.panel.pull_requests);
const pct = (n: number | null) => (n === null ? "—" : `${Math.round(n * 100)}%`);
const closedCount = computed(() => pr.value.merged + pr.value.closed);

const tiles = computed(() => [
  {
    key: "acceptance",
    value: pct(pr.value.acceptance_rate),
    detail: t("metrics.acceptanceDetail", { merged: pr.value.merged, closed: closedCount.value }),
    target: { met: meetsTarget("acceptance", pr.value.acceptance_rate), text: t("metrics.targetAtLeast", { pct: TARGETS.acceptance * 100 }) },
  },
  {
    key: "asIs",
    value: String(pr.value.accepted_as_is),
    detail: t("metrics.asIsDetail", { merged: pr.value.merged }),
    target: null,
  },
  {
    key: "rework",
    value: pct(pr.value.rework_rate),
    detail: t("metrics.reworkDetail", { n: pr.value.rework }),
    target: { met: meetsTarget("rework", pr.value.rework_rate), text: t("metrics.targetBelow", { pct: TARGETS.rework * 100 }) },
  },
  {
    key: "costPerMerged",
    value: pr.value.cost_per_merged === null ? "—" : money(pr.value.cost_per_merged),
    detail: t("metrics.costPerMergedDetail"),
    target: null,
  },
]);

const stateIcon = { open: CircleDot, merged: GitMerge, closed: XCircle, gone: CircleSlash };

const rateGroups = computed(() => [
  { key: "successProfiles", icon: UserCog, rows: props.panel.profiles.map((p) => ({ id: p.profile, label: p.profile, ok: p.succeeded, tasks: p.tasks, rate: p.success_rate, limited: p.rate_limited })) },
  { key: "successModels", icon: Gauge, rows: props.panel.models.map((m: ModelMetricsView) => ({ id: m.id, label: m.id, ok: m.succeeded, tasks: m.tasks, rate: m.success_rate, limited: m.rate_limited })) },
]);
</script>

<template>
  <div class="space-y-5">
    <div class="rounded-lg border border-line bg-surface p-4">
      <h2 class="flex items-center gap-2 text-sm font-medium"><GitPullRequest :size="16" class="text-accent" aria-hidden="true" />{{ t("metrics.pullRequests") }}</h2>
      <p class="mt-1 text-xs text-muted">
        {{ t("metrics.prCounts", { opened: pr.opened, open: pr.open, merged: pr.merged, closed: pr.closed }) }}<template v-if="pr.gone"> · {{ t("metrics.prGone", { n: pr.gone }) }}</template>
      </p>
      <div class="mt-3 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <div v-for="tile in tiles" :key="tile.key" class="rounded-md border border-line bg-bg p-3">
          <p class="text-xs text-muted">{{ t(`metrics.tile.${tile.key}`) }}</p>
          <p class="mt-1 font-mono text-2xl font-semibold">{{ tile.value }}</p>
          <p class="text-xs text-muted">{{ tile.detail }}</p>
          <p
            v-if="tile.target"
            class="mt-1 flex items-center gap-1 text-[11px]"
            :class="tile.target.met === null ? 'text-muted' : tile.target.met ? 'tone-success' : 'tone-warning'"
            :style="tile.target.met === null ? '' : 'color: var(--tone)'"
          >
            <component :is="tile.target.met === false ? CircleAlert : CircleCheck" v-if="tile.target.met !== null" :size="12" aria-hidden="true" />
            {{ tile.target.met === null ? tile.target.text : `${tile.target.met ? t("metrics.targetMet") : t("metrics.targetMissed")} · ${tile.target.text}` }}
          </p>
        </div>
      </div>
      <p class="mt-3 text-[11px] text-muted">{{ t("metrics.prHint") }}</p>
    </div>

    <div class="grid gap-5 lg:grid-cols-2">
      <div v-for="g in rateGroups" :key="g.key" class="rounded-lg border border-line bg-surface">
        <h2 class="flex items-center gap-2 px-4 pt-4 pb-3 text-sm font-medium"><component :is="g.icon" :size="16" class="text-accent" aria-hidden="true" />{{ t(`metrics.${g.key}`) }}</h2>
        <p v-if="!g.rows.length" class="px-4 pb-4 text-sm text-muted">{{ t("usage.noModels") }}</p>
        <ul v-else class="space-y-3 px-4 pb-4">
          <li v-for="r in g.rows" :key="r.id" class="text-sm">
            <div class="flex items-baseline gap-2">
              <span class="min-w-0 truncate">{{ r.label }}</span>
              <span class="ml-auto font-mono text-xs">{{ pct(r.rate) }}</span>
              <span class="w-16 text-right font-mono text-[11px] text-muted">{{ r.ok }}/{{ r.tasks }}</span>
            </div>
            <div
              class="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-2"
              role="meter"
              :aria-label="t('metrics.successOf', { name: r.label })"
              aria-valuemin="0"
              aria-valuemax="100"
              :aria-valuenow="r.rate === null ? 0 : Math.round(r.rate * 100)"
            >
              <div class="h-full rounded-full bg-accent" :style="{ width: `${(r.rate ?? 0) * 100}%` }" />
            </div>
            <p v-if="r.limited" class="mt-0.5 text-[11px] text-muted">{{ t("metrics.rateLimited", { n: r.limited }) }}</p>
          </li>
        </ul>
      </div>
    </div>

    <div class="rounded-lg border border-line bg-surface">
      <h2 class="flex items-center gap-2 px-4 pt-4 pb-3 text-sm font-medium"><GitPullRequest :size="16" class="text-accent" aria-hidden="true" />{{ t("metrics.recent") }}</h2>
      <p v-if="!pr.recent.length" class="px-4 pb-4 text-sm text-muted">{{ t("metrics.noPrs") }}</p>
      <div v-else class="overflow-x-auto">
        <table class="w-full border-collapse text-sm">
          <caption class="sr-only">{{ t("metrics.recent") }}</caption>
          <thead class="text-[11px] tracking-wide whitespace-nowrap text-muted uppercase">
            <tr class="border-y border-line">
              <th scope="col" class="py-2 pl-4 text-left font-medium">{{ t("metrics.col.pr") }}</th>
              <th scope="col" class="px-3 py-2 text-left font-medium">{{ t("metrics.col.state") }}</th>
              <th scope="col" class="px-3 py-2 text-right font-medium">{{ t("metrics.col.commitsAfter") }}</th>
              <th scope="col" class="px-3 py-2 text-right font-medium">{{ t("metrics.col.cost") }}</th>
              <th scope="col" class="py-2 pr-4 text-right font-medium">{{ t("metrics.col.opened") }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="p in pr.recent" :key="`${p.repo}#${p.number}`" class="border-b border-line last:border-0">
              <th scope="row" class="py-2 pl-4 text-left font-normal">
                <a :href="p.url" target="_blank" rel="noopener noreferrer" class="font-mono text-xs text-accent hover:underline">{{ p.repo }}#{{ p.number }}</a>
                <RouterLink :to="`/runs/${p.run_id}`" class="block text-xs text-muted hover:text-fg">{{ p.run_name }}</RouterLink>
              </th>
              <td class="px-3 py-2" :class="`tone-${prTone[p.state]}`">
                <span class="flex items-center gap-1.5 text-xs" style="color: var(--tone)"><component :is="stateIcon[p.state]" :size="14" aria-hidden="true" />{{ t(`metrics.state.${p.state}`) }}</span>
              </td>
              <td class="px-3 py-2 text-right font-mono text-xs">{{ p.commits_after ?? "—" }}</td>
              <td class="px-3 py-2 text-right font-mono text-xs whitespace-nowrap">{{ money(p.cost) }}<span class="block text-muted">{{ money(p.plan_cost) }}</span></td>
              <td class="py-2 pr-4 text-right text-xs whitespace-nowrap text-muted"><time :datetime="p.opened_at">{{ ago(p.opened_at) }}</time></td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>
