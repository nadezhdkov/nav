<script setup lang="ts">
import { isTerminalRun } from "@navarch/contracts";
import { ChevronRight, Hand, Plus } from "@lucide/vue";
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import KillSwitch from "../components/KillSwitch.vue";
import StatusBadge from "../components/StatusBadge.vue";
import { money, runLook, runTitle } from "../lib/status.ts";
import { useApprovalsStore, useFleetStore, useRunsStore } from "../stores/runs.ts";

/** Home (spec §15.1 Mobile): what needs you, what is running, and the kill switch. */
const { t } = useI18n();
const runs = useRunsStore();
const approvals = useApprovalsStore();
const fleet = useFleetStore();

const active = computed(() => runs.runs.filter((r) => !isTerminalRun(r.status)));
/** The node an active run is on: its running agent, else the one waiting, from the Fleet view. */
function at(runId: string): string | null {
  const agents = fleet.view?.runs.find((r) => r.id === runId)?.agents ?? [];
  const agent = agents.find((a) => a.status === "running") ?? agents.find((a) => a.waiting);
  return agent?.node_id ?? null;
}
</script>

<template>
  <section class="mx-auto max-w-3xl space-y-5 p-6 max-md:p-4">
    <h1 class="text-xl font-semibold">{{ t("home.title") }}</h1>

    <RouterLink
      to="/approvals"
      class="flex min-h-14 items-center gap-3 rounded-lg border bg-surface px-4"
      :class="approvals.pending.length ? 'tone-warning' : 'tone-muted'"
      style="border-color: color-mix(in srgb, var(--tone) 50%, transparent)"
    >
      <Hand :size="20" style="color: var(--tone)" aria-hidden="true" />
      <span class="flex-1 font-medium">
        {{ approvals.pending.length ? t("home.approvals", { n: approvals.pending.length }) : t("home.noApprovals") }}
      </span>
      <ChevronRight :size="18" class="text-muted" aria-hidden="true" />
    </RouterLink>

    <div class="flex gap-3 max-sm:flex-col">
      <RouterLink to="/new" class="inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-md bg-accent px-4 font-semibold text-bg">
        <Plus :size="18" aria-hidden="true" />{{ t("home.newRun") }}
      </RouterLink>
      <!-- On the desktop the kill switch lives in the sidebar. -->
      <KillSwitch class="flex-1 md:hidden" />
    </div>

    <div>
      <h2 class="mb-2 text-sm font-medium tracking-wide text-muted uppercase">{{ t("home.active") }}</h2>
      <p v-if="runs.loaded && !active.length" class="rounded-lg border border-dashed border-line p-6 text-center text-muted">{{ t("home.empty") }}</p>
      <ul class="space-y-2">
        <li v-for="r in active" :key="r.id">
          <RouterLink :to="`/runs/${r.id}`" class="block rounded-lg border border-line bg-surface p-3 hover:bg-surface-2">
            <div class="flex items-start gap-2">
              <span class="min-w-0 flex-1 truncate font-medium">{{ runTitle(r) }}</span>
              <StatusBadge :look="runLook[r.status]" :status="r.status" />
            </div>
            <div class="mt-1.5 flex flex-wrap gap-x-3 text-xs text-muted">
              <span v-if="at(r.id)">{{ t("home.at", { node: at(r.id) }) }}</span>
              <span class="font-mono">{{ money(r.cost_total) }} / {{ money(r.budget) }}</span>
              <span class="truncate">{{ r.repo_path }}</span>
            </div>
          </RouterLink>
        </li>
      </ul>
    </div>
  </section>
</template>
