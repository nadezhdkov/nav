<script setup lang="ts">
import type { QuotaView } from "@navarch/contracts";
import { CircleAlert } from "@lucide/vue";
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { quotaRows } from "../lib/inbox.ts";

/** Agents' quota windows (idea from Orca, ADR 0021): a bar plus the percentage in text, never color alone. */
const props = defineProps<{ quotas: QuotaView[]; compact?: boolean }>();
const { t, te, locale } = useI18n();
const rows = computed(() => quotaRows(props.quotas));

const label = (w: string) => (te(`quota.windows.${w}`) ? t(`quota.windows.${w}`) : w.replace(/_/g, " "));
const pct = (q: QuotaView) => (q.utilization === null ? null : Math.min(100, Math.round(q.utilization * 100)));
const tone = (q: QuotaView) => (q.exhausted ? "danger" : (pct(q) ?? 0) >= 80 ? "warning" : "info");
const when = (iso: string) => new Date(iso).toLocaleString(locale.value, { weekday: "short", hour: "2-digit", minute: "2-digit" });
</script>

<template>
  <p v-if="!rows.length" class="text-sm text-muted">{{ t("quota.none") }}</p>
  <ul v-else class="space-y-3">
    <li v-for="row in rows" :key="row.adapter" class="text-sm">
      <p class="mb-1 font-medium">{{ row.adapter }}</p>
      <ul class="grid gap-2" :class="props.compact ? 'grid-cols-1' : 'grid-cols-[repeat(auto-fill,minmax(12rem,1fr))]'">
        <li v-for="q in row.windows" :key="`${q.window}-${q.model_prefix}`" :class="`tone-${tone(q)}`">
          <div class="flex items-baseline gap-2 text-xs">
            <span class="text-muted">{{ label(q.window) }}<template v-if="q.model_prefix"> · {{ q.model_prefix }}</template></span>
            <span class="ml-auto font-mono" :class="q.exhausted ? '' : 'text-fg'" :style="q.exhausted ? 'color: var(--tone)' : ''">
              <CircleAlert v-if="q.exhausted" :size="12" class="mr-0.5 inline" aria-hidden="true" />
              {{ q.exhausted ? t("quota.exhausted") : pct(q) === null ? "—" : `${pct(q)}%` }}
            </span>
          </div>
          <div
            class="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-2"
            role="meter"
            :aria-label="`${row.adapter} ${label(q.window)}`"
            aria-valuemin="0"
            aria-valuemax="100"
            :aria-valuenow="q.exhausted ? 100 : (pct(q) ?? 0)"
          >
            <div class="h-full rounded-full" :style="{ width: `${q.exhausted ? 100 : (pct(q) ?? 0)}%`, background: 'var(--tone)' }" />
          </div>
          <p v-if="q.resets_at" class="mt-0.5 text-[11px] text-muted">{{ t("quota.resets", { when: when(q.resets_at) }) }}</p>
        </li>
      </ul>
    </li>
  </ul>
</template>
