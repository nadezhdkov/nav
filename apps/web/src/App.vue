<script setup lang="ts">
import { Hand, ListChecks, Wifi, WifiOff } from "@lucide/vue";
import { onMounted, onUnmounted, watch } from "vue";
import { useI18n } from "vue-i18n";
import { authorized } from "./api/client.ts";
import { connected, onEvent, onReconnect, subscribe } from "./api/stream.ts";
import TokenView from "./views/TokenView.vue";
import { useApprovalsStore, useRunsStore } from "./stores/runs.ts";

const { t } = useI18n();
const runs = useRunsStore();
const approvals = useApprovalsStore();

const offs: (() => void)[] = [];
function start() {
  if (offs.length) return;
  offs.push(
    subscribe("runs"),
    onEvent((e) => {
      runs.apply(e);
      approvals.apply(e);
    }),
    onReconnect(() => {
      void runs.load();
      void approvals.load();
    }),
  );
  void runs.load();
  void approvals.load();
}

onMounted(() => {
  if (authorized.value) start();
});
watch(authorized, (ok) => {
  if (ok) start();
});
onUnmounted(() => offs.splice(0).forEach((off) => off()));
</script>

<template>
  <TokenView v-if="!authorized" />
  <div v-else class="flex h-full min-h-0">
    <nav :aria-label="t('nav.main')" class="flex w-56 shrink-0 flex-col border-r border-line bg-surface max-md:w-16">
      <div class="flex items-center gap-2.5 px-4 py-4">
        <img src="/favicon.svg" alt="" class="size-7" />
        <span class="text-base font-semibold tracking-tight max-md:hidden">{{ t("app.name") }}</span>
      </div>
      <RouterLink
        v-for="item in [
          { to: '/runs', label: t('nav.runs'), icon: ListChecks, badge: 0 },
          { to: '/approvals', label: t('nav.approvals'), icon: Hand, badge: approvals.pending.length },
        ]"
        :key="item.to"
        :to="item.to"
        class="mx-2 flex min-h-10 items-center gap-3 rounded-md px-3 text-muted hover:bg-surface-2 hover:text-fg"
        active-class="bg-surface-2 !text-fg"
      >
        <component :is="item.icon" :size="18" aria-hidden="true" />
        <span class="max-md:sr-only">{{ item.label }}</span>
        <span
          v-if="item.badge"
          class="tone-warning ml-auto rounded-full px-1.5 text-xs font-semibold max-md:absolute max-md:ml-6 max-md:-mt-5"
          style="background: var(--tone); color: var(--bg)"
        >{{ item.badge }}</span>
      </RouterLink>
      <div class="mt-auto flex items-center gap-2 px-4 py-3 text-xs text-muted" role="status">
        <component :is="connected ? Wifi : WifiOff" :size="14" :class="connected ? 'tone-success' : 'tone-warning'" style="color: var(--tone)" aria-hidden="true" />
        <span class="max-md:sr-only">{{ connected ? t("nav.live") : t("nav.offline") }}</span>
      </div>
    </nav>
    <main class="min-w-0 flex-1 overflow-auto">
      <RouterView />
    </main>
  </div>
</template>
