<script setup lang="ts">
import { Check, Lightbulb, X } from "@lucide/vue";
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { RouterLink } from "vue-router";
import { isDevice } from "../api/session.ts";
import { usePrinciplesStore, useProjectsStore } from "../stores/runs.ts";

/**
 * Rules (ADR 0057): each project's rules, and the ones planner and reviewer agents proposed
 * (ADR 0056). A proposal changes nothing until the user accepts it here or with
 * `navarch principles accept`. Reasons are the agent's words, so they are shown as plain text.
 */
const { t, locale } = useI18n();
const principles = usePrinciplesStore();
const projects = useProjectsStore();

const sections = computed(() =>
  projects.projects
    .map((p) => ({ project: p, view: principles.byProject[p.id] }))
    .filter((s) => s.view)
    .sort((a, b) => b.view!.proposals.length - a.view!.proposals.length),
);
const when = (iso: string) => new Date(iso).toLocaleString(locale.value, { dateStyle: "medium", timeStyle: "short" });
</script>

<template>
  <section class="mx-auto max-w-5xl space-y-6 p-6 max-md:p-4">
    <header>
      <h1 class="text-xl font-semibold">{{ t("rules.title") }}</h1>
      <p class="mt-1 text-sm text-muted">{{ t("rules.intro") }}</p>
    </header>

    <p v-if="principles.error" role="alert" class="tone-danger rounded-md border p-3 text-sm" style="color: var(--tone); border-color: var(--tone)">{{ principles.error }}</p>
    <p v-if="principles.loaded && !projects.projects.length" class="rounded-md border border-dashed border-line p-4 text-sm text-muted">{{ t("rules.noProjects") }}</p>

    <section v-for="s in sections" :key="s.project.id" :aria-labelledby="`rules-${s.project.id}`" class="space-y-3">
      <h2 :id="`rules-${s.project.id}`" class="text-sm font-semibold">{{ s.project.name }}</h2>

      <ul v-if="s.view!.proposals.length" class="space-y-2" :aria-label="t('rules.proposed')">
        <li v-for="p in s.view!.proposals" :key="p.id" class="tone-warning rounded-lg border bg-surface p-4" style="border-color: var(--tone)">
          <p class="flex items-start gap-2 font-medium"><Lightbulb :size="16" class="mt-0.5 shrink-0" style="color: var(--tone)" aria-hidden="true" />{{ p.text }}</p>
          <p class="mt-1 text-sm text-muted">{{ t("rules.reason", { reason: p.reason }) }}</p>
          <p class="mt-1 flex flex-wrap gap-x-3 text-xs text-muted">
            <span>{{ t("rules.proposedBy") }}</span>
            <RouterLink v-if="p.run_id" :to="`/runs/${p.run_id}`" class="hover:underline">{{ p.run_id }}</RouterLink>
            <span>{{ when(p.proposed_at) }}</span>
          </p>
          <div v-if="!isDevice" class="mt-3 flex flex-wrap gap-2">
            <button type="button" class="inline-flex min-h-9 items-center gap-1.5 rounded-md border border-line bg-surface-2 px-3 text-sm" @click="principles.decide(s.project.id, p.id, 'accept')"><Check :size="14" aria-hidden="true" />{{ t("rules.accept") }}</button>
            <button type="button" class="inline-flex min-h-9 items-center gap-1.5 rounded-md border border-line px-3 text-sm text-muted" @click="principles.decide(s.project.id, p.id, 'dismiss')"><X :size="14" aria-hidden="true" />{{ t("rules.dismiss") }}</button>
          </div>
        </li>
      </ul>
      <p v-if="s.view!.proposals.length" class="text-xs text-muted">{{ t("rules.notApplied") }}</p>

      <p v-if="!s.view!.principles.length" class="rounded-md border border-dashed border-line p-4 text-sm text-muted">{{ t("rules.empty") }}</p>
      <ul v-else class="divide-y divide-line rounded-lg border border-line bg-surface">
        <li v-for="r in s.view!.principles" :key="r.id" class="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-2 text-sm">
          <span>{{ r.text }}</span>
          <span class="ml-auto text-xs text-muted">{{ r.source === "user" ? t("rules.sourceUser") : t("rules.sourceFile") }}</span>
        </li>
      </ul>
      <p v-if="s.view!.truncated" class="text-xs text-muted">{{ t("rules.truncated") }}</p>
    </section>
  </section>
</template>
