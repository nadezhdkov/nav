<script setup lang="ts">
import { CircleCheck, CircleHelp, GitPullRequest, TriangleAlert } from "@lucide/vue";
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { RouterLink } from "vue-router";
import { meetsTarget, percent, shares, TARGET_PERCENT } from "../lib/specs.ts";
import { useSpecsStore } from "../stores/runs.ts";

/**
 * Specs (ADR 0053): what `reverse-spec` runs wrote, with the share of claims the code confirmed
 * against the Phase 3 target, and the addenda `spec-sync` runs added after merges. Read-only: the
 * specs themselves live in the project's repository, and a pull request carries them.
 */
const { t, locale } = useI18n();
const specs = useSpecsStore();

const latest = computed(() => specs.extractions[0] ?? null);
const when = (iso: string) => new Date(iso).toLocaleString(locale.value, { dateStyle: "medium", timeStyle: "short" });
</script>

<template>
  <section class="mx-auto max-w-5xl space-y-6 p-6 max-md:p-4">
    <header>
      <h1 class="text-xl font-semibold">{{ t("specs.title") }}</h1>
      <p class="mt-1 text-sm text-muted">{{ t("specs.intro", { target: TARGET_PERCENT }) }}</p>
    </header>

    <p v-if="specs.error" role="alert" class="tone-danger rounded-md border p-3 text-sm" style="color: var(--tone); border-color: var(--tone)">{{ specs.error }}</p>

    <div v-if="latest" class="rounded-lg border border-line bg-surface p-4" :class="meetsTarget(latest.green_rate) ? 'tone-success' : 'tone-warning'">
      <p class="text-xs uppercase tracking-wide text-muted">{{ t("specs.latest") }}</p>
      <p class="mt-1 flex flex-wrap items-center gap-2 text-2xl font-semibold" style="color: var(--tone)">
        <component :is="meetsTarget(latest.green_rate) ? CircleCheck : TriangleAlert" :size="22" aria-hidden="true" />
        {{ percent(latest.green_rate) ?? "—" }}
        <span class="text-sm font-normal text-fg">{{ meetsTarget(latest.green_rate) ? t("specs.targetMet", { target: TARGET_PERCENT }) : t("specs.targetMissed", { target: TARGET_PERCENT }) }}</span>
      </p>
    </div>

    <section aria-labelledby="specs-extractions">
      <h2 id="specs-extractions" class="mb-2 text-sm font-semibold">{{ t("specs.extractions") }}</h2>
      <p v-if="specs.loaded && !specs.extractions.length" class="rounded-md border border-dashed border-line p-4 text-sm text-muted">{{ t("specs.empty") }}</p>
      <ul v-else class="space-y-3">
        <li v-for="s in specs.extractions" :key="s.run_id + s.ts" class="rounded-lg border border-line bg-surface p-4">
          <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <RouterLink :to="`/runs/${s.run_id}`" class="font-medium hover:underline">{{ s.run_name ?? s.run_id }}</RouterLink>
            <span class="text-xs text-muted">{{ when(s.ts) }}</span>
            <span class="ml-auto font-mono text-sm">{{ percent(s.green_rate) ?? "—" }}</span>
          </div>
          <div class="mt-2 flex h-2 overflow-hidden rounded-full bg-surface-2" role="img" :aria-label="t('specs.bar', { confirmed: s.confirmed, inferred: s.inferred, gap: s.gap })">
            <span class="h-full" :style="{ width: `${shares(s).confirmed}%`, background: 'var(--tone-success)' }" />
            <span class="h-full" :style="{ width: `${shares(s).inferred}%`, background: 'var(--tone-warning)' }" />
            <span class="h-full" :style="{ width: `${shares(s).gap}%`, background: 'var(--tone-danger)' }" />
          </div>
          <p class="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
            <span>{{ t("specs.components", { n: s.components }) }}</span>
            <span>{{ t("specs.claims", { n: s.claims }) }}</span>
            <span>{{ t("specs.confirmed", { n: s.confirmed }) }}</span>
            <span>{{ t("specs.inferred", { n: s.inferred }) }}</span>
            <span>{{ t("specs.gap", { n: s.gap }) }}</span>
            <span v-if="s.downgraded">{{ t("specs.downgraded", { n: s.downgraded }) }}</span>
            <span class="font-mono">{{ s.branch }}</span>
          </p>
        </li>
      </ul>
    </section>

    <section aria-labelledby="specs-addenda">
      <h2 id="specs-addenda" class="mb-2 text-sm font-semibold">{{ t("specs.addenda") }}</h2>
      <p v-if="specs.loaded && !specs.addenda.length" class="rounded-md border border-dashed border-line p-4 text-sm text-muted">{{ t("specs.emptyAddenda") }}</p>
      <ul v-else class="space-y-3">
        <li v-for="a in specs.addenda" :key="a.run_id + a.ts" class="rounded-lg border border-line bg-surface p-4">
          <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span class="flex items-center gap-1.5 font-medium"><GitPullRequest :size="14" aria-hidden="true" />{{ a.repo }}#{{ a.pr_number }}</span>
            <RouterLink :to="`/runs/${a.run_id}`" class="text-xs text-muted hover:underline">{{ a.run_name ?? a.run_id }}</RouterLink>
            <span class="text-xs text-muted">{{ when(a.ts) }}</span>
          </div>
          <p class="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
            <span>{{ t("specs.changes", { n: a.changes }) }}</span>
            <span>{{ t("specs.confirmed", { n: a.confirmed }) }}</span>
            <span>{{ t("specs.inferred", { n: a.inferred }) }}</span>
            <span>{{ t("specs.gap", { n: a.gap }) }}</span>
            <span v-if="a.stale" class="flex items-center gap-1" style="color: var(--tone-warning)"><TriangleAlert :size="12" aria-hidden="true" />{{ t("specs.stale", { n: a.stale }) }}</span>
            <span v-if="a.unmatched" class="flex items-center gap-1"><CircleHelp :size="12" aria-hidden="true" />{{ t("specs.unmatched", { n: a.unmatched }) }}</span>
            <span class="font-mono">{{ a.branch }}</span>
          </p>
        </li>
      </ul>
    </section>
  </section>
</template>
