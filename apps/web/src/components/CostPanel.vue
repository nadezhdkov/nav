<script setup lang="ts">
import type { CostPanel } from "@navarch/contracts";
import { CalendarDays, FolderGit2, Layers, UserCog } from "@lucide/vue";
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { money } from "../lib/status.ts";
import { dayBars, shareBars } from "../lib/metrics.ts";
import { compactTokens } from "../lib/usage.ts";

/**
 * The cost panel (spec §6.15, ADR 0037): daily spend as stacked bars, billed under
 * plan-equivalent, and ranked tables per project, profile and model. Every value in the chart is
 * also in the table under it.
 */
const props = defineProps<{ panel: CostPanel }>();
const { t, locale } = useI18n();

const chart = computed(() => dayBars(props.panel.days));
const hovered = ref<number | null>(null);
const dayFormat = computed(() => new Intl.DateTimeFormat(locale.value, { month: "short", day: "numeric" }));
const dayLabel = (day: string) => dayFormat.value.format(new Date(`${day}T12:00:00`));
const tickEvery = computed(() => Math.max(1, Math.ceil(props.panel.days.length / 6)));

const groups = computed(() => [
  {
    key: "projects",
    icon: FolderGit2,
    countKey: "runs",
    rows: shareBars(props.panel.projects).map((p) => ({
      ...p,
      id: `${p.kind}:${p.project_id ?? p.label}`,
      label: p.kind === "outside" ? t("metrics.outsideRuns") : p.label,
      hint: p.kind === "repo" ? t("metrics.notProject") : undefined,
      count: p.runs,
    })),
  },
  {
    key: "profiles",
    icon: UserCog,
    countKey: "tasks",
    rows: shareBars(props.panel.profiles).map((p) => ({ ...p, id: p.profile ?? "", label: p.profile ?? t("metrics.outsideRuns"), hint: undefined, count: p.tasks })),
  },
  {
    key: "models",
    icon: Layers,
    countKey: "calls",
    rows: shareBars(props.panel.models).map((m) => ({ ...m, id: m.model, label: m.model, hint: undefined, count: m.calls })),
  },
]);
</script>

<template>
  <div class="space-y-5">
    <div class="rounded-lg border border-line bg-surface p-4">
      <div class="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <h2 class="flex items-center gap-2 text-sm font-medium"><CalendarDays :size="16" class="text-accent" aria-hidden="true" />{{ t("metrics.byDay") }}</h2>
        <p class="font-mono text-sm">
          {{ money(panel.total.cost) }} <span class="font-sans text-xs text-muted">{{ t("usage.billed") }}</span> ·
          {{ money(panel.total.plan_cost) }} <span class="font-sans text-xs text-muted">{{ t("metrics.planEquivalent") }}</span> ·
          <span class="text-xs text-muted">{{ t("usage.tokens", { n: compactTokens(panel.total.tokens) }) }}</span>
        </p>
        <ul class="ml-auto flex gap-4 text-xs text-muted" :aria-label="t('metrics.legend')">
          <li class="flex items-center gap-1.5"><span class="inline-block size-2.5 rounded-sm" style="background: var(--series-billed)" aria-hidden="true" />{{ t("metrics.billedSeries") }}</li>
          <li class="flex items-center gap-1.5"><span class="inline-block size-2.5 rounded-sm" style="background: var(--series-plan)" aria-hidden="true" />{{ t("metrics.planSeries") }}</li>
        </ul>
      </div>

      <div class="relative mt-4 h-48 pl-12" @pointerleave="hovered = null">
        <div class="pointer-events-none absolute inset-0 left-12" aria-hidden="true">
          <div v-for="f in [1, 0.5, 0]" :key="f" class="absolute right-0 left-0 border-t border-line/60" :style="{ bottom: `${f * 100}%` }">
            <span class="absolute -top-2 -left-12 w-10 text-right font-mono text-[10px] text-muted">{{ f === 0 ? "$0" : money(chart.top * f) }}</span>
          </div>
        </div>
        <div class="relative flex h-full items-end gap-[2px]" role="list" :aria-label="t('metrics.byDay')">
          <div
            v-for="(b, i) in chart.bars"
            :key="b.day"
            role="listitem"
            tabindex="0"
            class="group relative flex h-full min-w-[2px] flex-1 flex-col justify-end gap-[2px] rounded-sm outline-offset-1"
            :aria-label="t('metrics.dayAria', { day: dayLabel(b.day), billed: money(b.cost), plan: money(b.plan_cost) })"
            @pointerenter="hovered = i"
            @focus="hovered = i"
            @blur="hovered = null"
          >
            <div
              v-if="b.planPct > 0"
              class="w-full rounded-t-[4px]"
              :class="hovered === i ? 'brightness-125' : ''"
              :style="{ height: `${b.planPct}%`, background: 'var(--series-plan)' }"
            />
            <div
              v-if="b.billedPct > 0"
              class="w-full"
              :class="[b.planPct > 0 ? '' : 'rounded-t-[4px]', hovered === i ? 'brightness-125' : '']"
              :style="{ height: `${b.billedPct}%`, background: 'var(--series-billed)' }"
            />
            <div
              v-if="hovered === i"
              class="pointer-events-none absolute bottom-full z-10 mb-2 w-max rounded-md border border-line bg-bg px-2.5 py-1.5 text-xs shadow-lg"
              :class="i > chart.bars.length / 2 ? 'right-0' : 'left-0'"
              aria-hidden="true"
            >
              <p class="mb-1 text-muted">{{ dayLabel(b.day) }}</p>
              <p class="flex items-center gap-2"><span class="inline-block h-0.5 w-3" style="background: var(--series-billed)" /><strong class="font-mono">{{ money(b.cost) }}</strong><span class="text-muted">{{ t("metrics.billedSeries") }}</span></p>
              <p class="flex items-center gap-2"><span class="inline-block h-0.5 w-3" style="background: var(--series-plan)" /><strong class="font-mono">{{ money(b.plan_cost) }}</strong><span class="text-muted">{{ t("metrics.planSeries") }}</span></p>
              <p class="mt-0.5 text-muted">{{ t("usage.tokens", { n: compactTokens(b.tokens) }) }}</p>
            </div>
          </div>
        </div>
      </div>
      <div class="mt-1 flex gap-[2px] pl-12 text-[10px] text-muted" aria-hidden="true">
        <span v-for="(b, i) in chart.bars" :key="b.day" class="min-w-[2px] flex-1 overflow-visible whitespace-nowrap">{{ i % tickEvery === 0 ? dayLabel(b.day) : "" }}</span>
      </div>

      <details class="mt-3 text-xs">
        <summary class="cursor-pointer text-muted hover:text-fg">{{ t("metrics.showTable") }}</summary>
        <table class="mt-2 w-full max-w-md border-collapse font-mono">
          <caption class="sr-only">{{ t("metrics.byDay") }}</caption>
          <thead class="text-left font-sans text-muted">
            <tr class="border-b border-line">
              <th scope="col" class="py-1 font-medium">{{ t("metrics.col.day") }}</th>
              <th scope="col" class="py-1 text-right font-medium">{{ t("metrics.billedSeries") }}</th>
              <th scope="col" class="py-1 text-right font-medium">{{ t("metrics.planSeries") }}</th>
              <th scope="col" class="py-1 text-right font-medium">{{ t("metrics.col.tokens") }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="b in [...chart.bars].reverse()" :key="b.day" class="border-b border-line/50">
              <th scope="row" class="py-1 text-left font-normal">{{ b.day }}</th>
              <td class="py-1 text-right">{{ money(b.cost) }}</td>
              <td class="py-1 text-right">{{ money(b.plan_cost) }}</td>
              <td class="py-1 text-right">{{ compactTokens(b.tokens) }}</td>
            </tr>
          </tbody>
        </table>
      </details>
    </div>

    <div class="grid gap-5 lg:grid-cols-2 2xl:grid-cols-3">
      <div v-for="g in groups" :key="g.key" class="rounded-lg border border-line bg-surface">
        <h2 class="flex items-center gap-2 px-4 pt-4 pb-3 text-sm font-medium"><component :is="g.icon" :size="16" class="text-accent" aria-hidden="true" />{{ t(`metrics.${g.key}`) }}</h2>
        <p v-if="!g.rows.length" class="px-4 pb-4 text-sm text-muted">{{ t("metrics.noSpend") }}</p>
        <ul v-else class="divide-y divide-line border-t border-line">
          <li v-for="r in g.rows" :key="r.id" class="px-4 py-2.5 text-sm">
            <div class="flex items-baseline gap-2">
              <span class="min-w-0 flex-1 truncate" :title="r.hint ? `${r.label} · ${r.hint}` : r.label">{{ r.label }}</span>
              <span class="shrink-0 text-[11px] text-muted">{{ t(`metrics.count.${g.countKey}`, { n: r.count }) }}</span>
            </div>
            <div class="mt-1.5 flex h-1.5 gap-[2px]" aria-hidden="true">
              <span v-if="r.billedPct > 0" class="rounded-l-sm" :class="r.planPct > 0 ? '' : 'rounded-r-sm'" :style="{ width: `${r.billedPct}%`, background: 'var(--series-billed)' }" />
              <span v-if="r.planPct > 0" class="rounded-r-sm" :class="r.billedPct > 0 ? '' : 'rounded-l-sm'" :style="{ width: `${r.planPct}%`, background: 'var(--series-plan)' }" />
            </div>
            <p class="mt-1 font-mono text-xs">
              {{ money(r.cost) }} <span class="font-sans text-muted">{{ t("usage.billed") }}</span> ·
              {{ money(r.plan_cost) }} <span class="font-sans text-muted">{{ t("metrics.planEquivalent") }}</span> ·
              <span class="text-muted">{{ compactTokens(r.tokens) }}</span>
            </p>
          </li>
        </ul>
      </div>
    </div>
    <p class="text-[11px] text-muted">{{ t("metrics.costHint") }}</p>
  </div>
</template>
