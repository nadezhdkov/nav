<script setup lang="ts">
import { FileCheck, MessageSquare, ScrollText, Hand, House, ShieldCheck, Inbox, Languages, ListChecks, RefreshCw, Settings, Ship, Smartphone, Wallet, Wifi, WifiOff, Workflow } from "@lucide/vue";
import { computed, onMounted, onUnmounted, watch } from "vue";
import { useI18n } from "vue-i18n";
import { authorized, client, pendingPair, reachable } from "./api/client.ts";
import { isDevice } from "./api/session.ts";
import AwayBanner from "./components/AwayBanner.vue";
import KillSwitch from "./components/KillSwitch.vue";
import ProjectsTree from "./components/ProjectsTree.vue";
import PairView from "./views/PairView.vue";
import { connected, onEvent, onReconnect, subscribe } from "./api/stream.ts";
import { locales, setLocale, type Locale } from "./i18n.ts";
import TokenView from "./views/TokenView.vue";
import { useApprovalsStore, useAwayStore, useCiStore, useFleetStore, useInboxStore, useProjectsStore, useRunsStore, useSpecsStore, useSummaryStore, usePrinciplesStore, useUsageStore, useMetricsStore } from "./stores/runs.ts";

const { t, locale } = useI18n();
const runs = useRunsStore();
const approvals = useApprovalsStore();
const fleet = useFleetStore();
const inbox = useInboxStore();
const projects = useProjectsStore();
const usage = useUsageStore();
const away = useAwayStore();
const principles = usePrinciplesStore();
const stores = [runs, approvals, fleet, inbox, projects, usage, useMetricsStore(), away, useCiStore(), useSummaryStore(), useSpecsStore(), principles];

const offs: (() => void)[] = [];
/** Loads everything again, for the "Try again" of the unreachable notice. */
function retry() {
  stores.forEach((s) => void s.load());
}

function start() {
  if (offs.length) return;
  offs.push(
    subscribe("runs"),
    onEvent((e) => stores.forEach((s) => s.apply(e))),
    onReconnect(() => stores.forEach((s) => void s.load())),
  );
  stores.forEach((s) => void s.load());
}

onMounted(() => {
  if (authorized.value) start();
});
watch(authorized, (ok) => {
  if (ok) start();
});
onUnmounted(() => offs.splice(0).forEach((off) => off()));

/** Away from the PC (the tailnet name), signing in means pairing; on the PC, the local token. */
const onPc = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(window.location.hostname);
const mobile = computed(() => client() === "mobile");
const items = computed(() => {
  const home = { to: "/home", label: t("nav.home"), icon: House, badge: 0, tone: "neutral" };
  const runsItem = { to: "/runs", label: t("nav.runs"), icon: ListChecks, badge: 0, tone: "neutral" };
  const fleetItem = { to: "/fleet", label: t("nav.fleet"), icon: Ship, badge: fleet.running, tone: "info" };
  const approvalsItem = { to: "/approvals", label: t("nav.approvals"), icon: Hand, badge: approvals.pending.length, tone: "warning" };
  if (mobile.value) return [home, { to: "/chat", label: t("nav.chat"), icon: MessageSquare, badge: 0, tone: "neutral" }, approvalsItem, runsItem, fleetItem, { to: "/device", label: t("nav.device"), icon: Smartphone, badge: 0, tone: "neutral" }];
  // The Inbox is a desktop tab; phones reach it from Home.
  const inboxItem = { to: "/inbox", label: t("nav.inbox"), icon: Inbox, badge: inbox.open.length, tone: "info" };
  // Usage is a desktop tab too; phones reach it from Home's cost card.
  const usageItem = { to: "/usage", label: t("nav.usage"), icon: Wallet, badge: 0, tone: "neutral" };
  // Flow Studio is desktop only (ADR 0033).
  const awayItem = { to: "/away", label: t("nav.away"), icon: ShieldCheck, badge: away.active ? 1 : 0, tone: "warning" };
  // Specs are a desktop tab; the data is readable from a phone, but there is no tab for it.
  const specsItem = { to: "/specs", label: t("nav.specs"), icon: FileCheck, badge: 0, tone: "neutral" };
  // Rules are a desktop tab; the badge counts rules agents proposed that wait for a decision.
  const rulesItem = { to: "/rules", label: t("nav.rules"), icon: ScrollText, badge: principles.pending, tone: "warning" };
  const flowsItem = { to: "/flows", label: t("nav.flows"), icon: Workflow, badge: 0, tone: "neutral" };
  return [home, inboxItem, approvalsItem, runsItem, fleetItem, awayItem, flowsItem, specsItem, rulesItem, usageItem, { to: "/settings/devices", label: t("nav.settings"), icon: Settings, badge: 0, tone: "neutral" }];
});
</script>

<template>
  <PairView v-if="!authorized && (pendingPair || !onPc)" />
  <TokenView v-else-if="!authorized" />
  <div v-else class="flex h-full min-h-0">
    <nav :aria-label="t('nav.main')" class="flex w-56 shrink-0 flex-col border-r border-line bg-surface max-md:hidden">
      <div class="flex items-center gap-2.5 px-4 py-4">
        <img src="/favicon.svg" alt="" class="size-7" />
        <span class="text-base font-semibold tracking-tight">{{ t("app.name") }}</span>
      </div>
      <RouterLink
        v-for="item in items"
        :key="item.to"
        :to="item.to"
        class="mx-2 flex min-h-10 items-center gap-3 rounded-md px-3 text-muted hover:bg-surface-2 hover:text-fg"
        active-class="bg-surface-2 !text-fg"
      >
        <component :is="item.icon" :size="18" aria-hidden="true" />
        <span>{{ item.label }}</span>
        <span
          v-if="item.badge"
          :class="`tone-${item.tone}`"
          class="ml-auto rounded-full px-1.5 text-xs font-semibold"
          style="background: var(--tone); color: var(--bg)"
        >{{ item.badge }}</span>
      </RouterLink>
      <ProjectsTree class="min-h-0 overflow-auto" />
      <KillSwitch compact class="mx-2 mt-auto" />
      <label class="relative mx-2 mt-2 flex min-h-10 items-center gap-3 rounded-md px-3 text-muted focus-within:outline-2 focus-within:outline-accent hover:bg-surface-2 hover:text-fg">
        <Languages :size="18" aria-hidden="true" />
        <select
          :value="locale"
          :aria-label="t('nav.language')"
          class="min-w-0 flex-1 cursor-pointer bg-transparent text-sm outline-none"
          @change="setLocale(($event.target as HTMLSelectElement).value as Locale)"
        >
          <option v-for="l in locales" :key="l.code" :value="l.code" :lang="l.code" class="bg-surface text-fg">{{ l.name }}</option>
        </select>
      </label>
      <div class="flex items-center gap-2 px-4 py-3 text-xs text-muted" role="status">
        <component :is="connected ? Wifi : WifiOff" :size="14" :class="connected ? 'tone-success' : 'tone-warning'" style="color: var(--tone)" aria-hidden="true" />
        <span>{{ connected ? t("nav.live") : t("nav.offline") }}</span>
      </div>
    </nav>
    <main class="min-w-0 flex-1 overflow-auto max-md:pb-[calc(4rem+env(safe-area-inset-bottom))]">
      <!-- The daemon does not answer: say so and why it may be, instead of empty lists (go/no-go F2). -->
      <div v-if="!reachable" class="tone-warning m-6 rounded-lg border p-4 max-md:m-4" style="border-color: color-mix(in srgb, var(--tone) 45%, transparent)" role="alert">
        <p class="flex items-center gap-2 font-semibold" style="color: var(--tone)"><WifiOff :size="18" aria-hidden="true" />{{ t("offline.title") }}</p>
        <p class="mt-1 text-sm text-muted">{{ isDevice ? t("offline.phone") : t("offline.desktop") }}</p>
        <button type="button" class="mt-3 inline-flex min-h-11 items-center gap-2 rounded-md border border-line px-4 text-sm font-medium hover:bg-surface-2" @click="retry">
          <RefreshCw :size="16" aria-hidden="true" />{{ t("offline.retry") }}
        </button>
      </div>
      <p v-else-if="!connected" class="tone-warning flex items-center gap-2 border-b border-line px-4 py-1.5 text-xs md:hidden" style="color: var(--tone)" role="status">
        <WifiOff :size="14" aria-hidden="true" />{{ t("nav.offline") }}
      </p>
      <AwayBanner />
      <RouterView />
    </main>
    <!-- Phones: a bottom tab bar with large targets (spec §15.4), above the home indicator. -->
    <nav
      :aria-label="t('nav.main')"
      class="fixed inset-x-0 bottom-0 z-20 flex border-t border-line bg-surface pb-[env(safe-area-inset-bottom)] md:hidden"
    >
      <RouterLink
        v-for="item in items"
        :key="item.to"
        :to="item.to"
        class="relative flex min-h-16 flex-1 flex-col items-center justify-center gap-1 text-[11px] text-muted"
        active-class="!text-accent"
      >
        <component :is="item.icon" :size="22" aria-hidden="true" />
        <span class="max-w-full truncate px-1">{{ item.label }}</span>
        <span
          v-if="item.badge"
          :class="`tone-${item.tone}`"
          class="absolute top-1.5 left-1/2 ml-2 rounded-full px-1.5 text-[10px] font-semibold"
          style="background: var(--tone); color: var(--bg)"
        >{{ item.badge }}</span>
      </RouterLink>
    </nav>
  </div>
</template>
