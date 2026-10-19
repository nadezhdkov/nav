<script setup lang="ts">
import { isTerminalRun } from "@navarch/contracts";
import { ChevronRight, CircleAlert, Coins, Gauge, Hand, Inbox, Plus } from "@lucide/vue";
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import CiFailures from "../components/CiFailures.vue";
import KillSwitch from "../components/KillSwitch.vue";
import SummaryCard from "../components/SummaryCard.vue";
import QuotaBars from "../components/QuotaBars.vue";
import StatusBadge from "../components/StatusBadge.vue";
import { money, runLook, runTitle } from "../lib/status.ts";
import { useApprovalsStore, useFleetStore, useInboxStore, useProjectsStore, useRunsStore, useUsageStore } from "../stores/runs.ts";

/**
 * Home (spec §15.1): what needs you, what is running, and the kill switch; plus agents' quota
 * windows, today's cost, the Inbox and alerts (ADR 0021). Phones get the compact version.
 */
const { t } = useI18n();
const runs = useRunsStore();
const approvals = useApprovalsStore();
const fleet = useFleetStore();
const inbox = useInboxStore();
const projects = useProjectsStore();

const usage = useUsageStore();
/** Billed spend today from the Cost Ledger, with plan use apart (ADR 0023). */
const today = computed(() => usage.view?.today ?? { cost: 0, plan_cost: 0, tokens: 0 });
const budgetAlert = computed(() => (usage.view?.budgets ?? []).some((b) => b.scope !== "run" && b.state !== "ok"));
const byAction = computed(() => {
  const counts = { start_run: 0, needs_info: 0, duplicate: 0, skip: 0, untriaged: 0 };
  for (const i of inbox.open) counts[i.triage?.suggested_action ?? "untriaged"]++;
  return counts;
});
/** Runs that stopped in the last 24 hours and need a look, plus triage problems. */
const alerts = computed(() => {
  const since = new Date(Date.now() - 86_400_000).toISOString();
  const list: { key: string; text: string; to: string }[] = runs.runs
    .filter((r) => ["failed", "budget_exceeded", "paused"].includes(r.status) && r.updated_at >= since)
    .map((r) => ({ key: r.id, text: t(`home.alerts.${r.status}`, { run: runTitle(r) }), to: `/runs/${r.id}` }));
  if (inbox.view && !inbox.view.triage.available && projects.projects.length) {
    list.push({ key: "triage", text: inbox.view.triage.reason ?? t("inbox.triageOff"), to: "/inbox" });
  }
  return list;
});

const active = computed(() => runs.runs.filter((r) => !isTerminalRun(r.status)));
/** The node an active run is on: its running agent, else the one waiting, from the Fleet view. */
function at(runId: string): string | null {
  const agents = fleet.view?.runs.find((r) => r.id === runId)?.agents ?? [];
  const agent = agents.find((a) => a.status === "running") ?? agents.find((a) => a.waiting);
  return agent?.node_id ?? null;
}
</script>

<template>
  <section class="mx-auto max-w-4xl space-y-5 p-6 max-md:p-4">
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

    <div v-if="alerts.length" class="tone-danger space-y-1.5 rounded-lg border p-3" style="border-color: color-mix(in srgb, var(--tone) 45%, transparent)" role="status">
      <h2 class="flex items-center gap-2 text-sm font-medium"><CircleAlert :size="16" style="color: var(--tone)" aria-hidden="true" />{{ t("home.alerts.title") }}</h2>
      <ul class="space-y-1 text-sm">
        <li v-for="a in alerts" :key="a.key"><RouterLink :to="a.to" class="text-fg hover:text-accent">{{ a.text }}</RouterLink></li>
      </ul>
    </div>

    <SummaryCard />

    <CiFailures />

    <div class="grid gap-3 md:grid-cols-2">
      <RouterLink to="/inbox" class="block rounded-lg border border-line bg-surface p-4 hover:bg-surface-2">
        <h2 class="flex items-center gap-2 text-sm font-medium"><Inbox :size="16" class="text-accent" aria-hidden="true" />{{ t("home.inbox") }}</h2>
        <p class="mt-1 text-2xl font-semibold">{{ inbox.open.length }}</p>
        <p class="text-xs text-muted">
          {{ t("home.inboxBreakdown", { start: byAction.start_run, info: byAction.needs_info, dup: byAction.duplicate, untriaged: byAction.untriaged }) }}
        </p>
      </RouterLink>
      <RouterLink to="/usage" class="block rounded-lg border border-line bg-surface p-4 hover:bg-surface-2">
        <h2 class="flex items-center gap-2 text-sm font-medium">
          <Coins :size="16" class="text-accent" aria-hidden="true" />{{ t("home.costToday") }}
          <span v-if="budgetAlert" class="tone-warning ml-auto flex items-center gap-1 text-xs font-normal" style="color: var(--tone)">
            <CircleAlert :size="13" aria-hidden="true" />{{ t("home.budgetAlert") }}
          </span>
        </h2>
        <p class="mt-1 font-mono text-2xl font-semibold">{{ money(today.cost) }}</p>
        <p class="text-xs text-muted">{{ t("home.costTodayHint", { plan: money(today.plan_cost) }) }}</p>
      </RouterLink>
    </div>

    <div>
      <h2 class="mb-2 text-sm font-medium tracking-wide text-muted uppercase">{{ t("home.active") }}</h2>
      <p v-if="runs.loaded && !runs.error && !active.length" class="rounded-lg border border-dashed border-line p-6 text-center text-muted">{{ t("home.empty") }}</p>
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

    <div class="rounded-lg border border-line bg-surface p-4">
      <h2 class="mb-3 flex items-center gap-2 text-sm font-medium"><Gauge :size="16" class="text-accent" aria-hidden="true" />{{ t("quota.title") }}</h2>
      <QuotaBars :quotas="projects.quotas" />
    </div>
  </section>
</template>
