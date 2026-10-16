<script setup lang="ts">
import { reachable } from "../api/client.ts";
import { useI18n } from "vue-i18n";
import StatusBadge from "../components/StatusBadge.vue";
import { ago, money, runLook, runTitle } from "../lib/status.ts";
import { useRunsStore } from "../stores/runs.ts";

const { t } = useI18n();
const store = useRunsStore();

const title = runTitle;

function repoName(path: string): string {
  return path.split("/").filter(Boolean).at(-1) ?? path;
}
</script>

<template>
  <section class="p-6 max-md:p-4">
    <h1 class="mb-4 text-xl font-semibold">{{ t("runs.title") }}</h1>
    <template v-if="store.error">
      <!-- Unreachable: App shows why; repeating the raw error here would only add noise. -->
      <p v-if="reachable" class="tone-danger mb-3 text-sm" style="color: var(--tone)" role="alert">{{ store.error }}</p>
    </template>
    <p v-if="!store.loaded" class="text-muted">{{ t("runs.loading") }}</p>
    <p v-else-if="!store.error && !store.runs.length" class="rounded-lg border border-dashed border-line p-8 text-center text-muted">
      {{ t("runs.empty") }}
    </p>
    <ul v-else class="divide-y divide-line rounded-lg border border-line bg-surface md:hidden">
      <li v-for="run in store.runs" :key="run.id">
        <RouterLink :to="`/runs/${run.id}`" class="block min-h-12 space-y-1.5 px-4 py-3 hover:bg-surface-2">
          <span class="flex items-center gap-2">
            <StatusBadge :look="runLook[run.status]" :status="run.status" />
            <time :datetime="run.updated_at" class="ml-auto text-xs text-muted">{{ ago(run.updated_at) }}</time>
          </span>
          <span class="block truncate font-medium">{{ title(run) }}</span>
          <span class="flex gap-3 font-mono text-xs text-muted">
            <span>{{ run.flow ?? "—" }}</span>
            <span class="ml-auto">{{ money(run.cost_total) }} / {{ money(run.budget) }}</span>
          </span>
        </RouterLink>
      </li>
    </ul>
    <div v-if="store.loaded && store.runs.length" class="overflow-x-auto rounded-lg border border-line bg-surface max-md:hidden">
      <table class="w-full table-fixed text-left text-sm">
        <thead class="border-b border-line text-xs tracking-wide text-muted uppercase">
          <tr>
            <th class="w-48 px-4 py-2.5 font-medium">{{ t("runs.status") }}</th>
            <th class="px-4 py-2.5 font-medium">{{ t("runs.work") }}</th>
            <th class="w-36 px-4 py-2.5 font-medium max-lg:hidden">{{ t("runs.flow") }}</th>
            <th class="w-48 px-4 py-2.5 font-medium max-lg:hidden">{{ t("runs.repo") }}</th>
            <th class="w-40 px-4 py-2.5 text-right font-medium">{{ t("runs.cost") }}</th>
            <th class="w-24 px-4 py-2.5 text-right font-medium">{{ t("runs.updated") }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="run in store.runs" :key="run.id" class="border-b border-line last:border-0 hover:bg-surface-2">
            <td class="px-4 py-3"><StatusBadge :look="runLook[run.status]" :status="run.status" /></td>
            <td class="px-4 py-3">
              <RouterLink :to="`/runs/${run.id}`" class="block truncate font-medium hover:text-accent">{{ title(run) }}</RouterLink>
              <span class="block truncate font-mono text-xs text-muted">{{ run.id }}</span>
            </td>
            <td class="truncate px-4 py-3 font-mono text-xs text-muted max-lg:hidden">{{ run.flow ?? "—" }}</td>
            <td class="truncate px-4 py-3 text-muted max-lg:hidden" :title="run.repo_path">{{ repoName(run.repo_path) }}</td>
            <td class="px-4 py-3 text-right font-mono text-xs whitespace-nowrap">{{ money(run.cost_total) }} / {{ money(run.budget) }}</td>
            <td class="px-4 py-3 text-right text-xs whitespace-nowrap text-muted">
              <time :datetime="run.updated_at">{{ ago(run.updated_at) }}</time>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>
