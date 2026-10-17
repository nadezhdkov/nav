<script setup lang="ts">
import type { AwayDelegate } from "@navarch/contracts";
import { ShieldCheck } from "@lucide/vue";
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { useAwayStore } from "../stores/runs.ts";

/**
 * Shown on every screen while Away mode is on (ADR 0039): the user must never forget that an
 * agent is approving in their place. Icon and text, never color alone.
 */
const { t } = useI18n();
const away = useAwayStore();
const view = computed(() => away.view);
const what = computed(() => (view.value?.settings?.delegate ?? []).map((s: AwayDelegate) => t(`away.subject.${s}`).toLowerCase()).join(", "));
const until = computed(() => {
  const at = view.value?.settings?.until;
  return at ? t("away.until", { time: new Date(at).toLocaleString() }) : t("away.untilOff");
});
</script>

<template>
  <div v-if="view?.active" class="tone-warning flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-4 py-2 text-sm" style="border-color: color-mix(in srgb, var(--tone) 45%, transparent)" role="status">
    <ShieldCheck :size="18" aria-hidden="true" style="color: var(--tone)" />
    <span class="font-semibold" style="color: var(--tone)">{{ t("away.on") }}</span>
    <span class="text-muted">{{ t("away.banner", { what }) }} {{ until }}.</span>
    <span class="text-muted">{{ t("away.summary", view.counts) }}</span>
    <RouterLink to="/away" class="ml-auto inline-flex min-h-8 items-center rounded-md border border-line px-3 font-medium hover:bg-surface-2">{{ t("away.details") }}</RouterLink>
  </div>
</template>
