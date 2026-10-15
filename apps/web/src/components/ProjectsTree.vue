<script setup lang="ts">
import { ChevronDown, ChevronRight, FolderGit2 } from "@lucide/vue";
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { ago, nodeLook, runLook, runTitle } from "../lib/status.ts";
import { useFleetStore, useProjectsStore } from "../stores/runs.ts";

/**
 * Sidebar: project → active runs → running agents with their age (idea from Orca, ADR 0021).
 * Built from the projects list and the Fleet view; nothing is derived beyond grouping.
 */
const { t } = useI18n();
const projects = useProjectsStore();
const fleet = useFleetStore();
const open = ref(new Set<string>());

const tree = computed(() =>
  projects.projects.map((p) => ({
    project: p,
    runs: (fleet.view?.runs ?? []).filter((r) => r.repo_path === p.path),
  })),
);
function toggle(id: string) {
  const next = new Set(open.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  open.value = next;
}
</script>

<template>
  <div v-if="tree.length" class="mx-2 mt-4">
    <h2 class="px-3 pb-1 text-[11px] font-medium tracking-wide text-muted uppercase">{{ t("nav.projects") }}</h2>
    <ul>
      <li v-for="node in tree" :key="node.project.id">
        <button
          type="button"
          class="flex min-h-9 w-full items-center gap-2 rounded-md px-3 text-left text-sm text-muted hover:bg-surface-2 hover:text-fg"
          :aria-expanded="open.has(node.project.id)"
          @click="toggle(node.project.id)"
        >
          <component :is="open.has(node.project.id) ? ChevronDown : ChevronRight" :size="14" aria-hidden="true" />
          <FolderGit2 :size="15" aria-hidden="true" />
          <span class="min-w-0 flex-1 truncate" :title="node.project.repo">{{ node.project.name }}</span>
          <span v-if="node.project.active_runs" class="text-xs" :title="t('nav.activeRuns', { n: node.project.active_runs })">{{ node.project.active_runs }}</span>
        </button>
        <ul v-if="open.has(node.project.id)" class="mb-1 ml-5 border-l border-line pl-2">
          <li v-if="!node.runs.length" class="px-2 py-1 text-xs text-muted">{{ t("nav.noActiveRuns") }}</li>
          <li v-for="run in node.runs" :key="run.id">
            <RouterLink :to="`/runs/${run.id}`" class="flex min-h-8 items-center gap-1.5 rounded px-2 text-xs hover:bg-surface-2" :class="`tone-${runLook[run.status].tone}`">
              <component :is="runLook[run.status].icon" :size="12" :class="{ spin: runLook[run.status].spin }" style="color: var(--tone)" aria-hidden="true" />
              <span class="min-w-0 flex-1 truncate text-fg" :title="runTitle(run)">{{ runTitle(run) }}</span>
              <span class="sr-only">{{ t(`status.${run.status}`) }}</span>
            </RouterLink>
            <ul class="ml-3">
              <li v-for="agent in run.agents.filter((a) => a.status === 'running' || a.waiting)" :key="agent.id">
                <RouterLink
                  :to="{ path: '/fleet', query: { agent: agent.id } }"
                  class="flex min-h-7 items-center gap-1.5 rounded px-2 text-[11px] text-muted hover:bg-surface-2 hover:text-fg"
                  :class="`tone-${nodeLook[agent.status].tone}`"
                >
                  <component :is="nodeLook[agent.status].icon" :size="11" :class="{ spin: nodeLook[agent.status].spin }" style="color: var(--tone)" aria-hidden="true" />
                  <span class="min-w-0 flex-1 truncate">{{ agent.profile }} · {{ agent.adapter }}</span>
                  <span class="font-mono">{{ ago(agent.updated_at) }}</span>
                </RouterLink>
              </li>
            </ul>
          </li>
        </ul>
      </li>
    </ul>
  </div>
</template>
