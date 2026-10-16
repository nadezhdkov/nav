<script setup lang="ts">
import { CircleCheck, CircleX, LoaderCircle, Trophy } from "@lucide/vue";
import type { CompeteView, CompetitorView } from "@navarch/contracts";
import { computed } from "vue";
import { useI18n } from "vue-i18n";

/** A compete run's competitors (ADR 0031): agent, state, the judge's rank and reason, and the winner. */
const props = defineProps<{ compete: CompeteView }>();
const { t } = useI18n();

const ordered = computed(() => [...props.compete.competitors].sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99) || a.key.localeCompare(b.key)));
const chosen = computed(() => (props.compete.chosen_by ? t(`compete.chosen.${props.compete.chosen_by}`) : null));

function look(c: CompetitorView): { tone: string; icon: typeof CircleCheck; label: string } {
  if (c.key === props.compete.winner) return { tone: "tone-success", icon: Trophy, label: t(props.compete.adopted ? "compete.winner" : "compete.leading") };
  if (c.state === "finalist") return { tone: "tone-info", icon: CircleCheck, label: t("compete.finalist") };
  if (c.state === "out") return { tone: "tone-danger", icon: CircleX, label: t("compete.out") };
  return { tone: "tone-warning", icon: LoaderCircle, label: t("compete.working") };
}
</script>

<template>
  <div class="space-y-3">
    <p v-if="compete.judge_summary" class="text-sm"><span class="text-muted">{{ t("compete.judge") }}:</span> {{ compete.judge_summary }}</p>
    <p v-else-if="compete.judge_error" class="tone-warning text-sm" style="color: var(--tone)">{{ t("compete.judgeError", { error: compete.judge_error }) }}</p>
    <p v-if="compete.winner && chosen" class="text-sm text-muted">{{ chosen }}</p>
    <ul class="divide-y divide-line rounded-md border border-line" :aria-label="t('compete.title')">
      <li v-for="c in ordered" :key="c.key" class="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-3 py-2 text-sm" :class="look(c).tone">
        <span class="inline-flex w-28 shrink-0 items-center gap-1.5 font-medium" style="color: var(--tone)">
          <component :is="look(c).icon" :size="14" aria-hidden="true" />{{ look(c).label }}
        </span>
        <span class="font-mono font-semibold">{{ c.key }}</span>
        <span v-if="c.rank" class="font-mono text-xs">#{{ c.rank }} · {{ c.score }}/10</span>
        <span class="truncate font-mono text-xs text-muted">{{ c.adapter ?? "—" }}<template v-if="c.model"> · {{ c.model }}</template></span>
        <span v-if="c.iterations > 1" class="text-xs text-muted">{{ t("compete.iterations", { n: c.iterations }) }}</span>
        <p v-if="c.judge_reason" class="w-full text-xs">{{ c.judge_reason }}</p>
        <p v-else-if="c.reason" class="w-full text-xs text-muted">{{ c.reason }}</p>
      </li>
    </ul>
  </div>
</template>
