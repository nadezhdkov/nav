<script setup lang="ts">
import type { FleetAgent } from "@navarch/contracts";
import { Clock, GitBranch, MessageSquare } from "@lucide/vue";
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { iconFor, shortBranch } from "../lib/fleet.ts";
import { money, nodeLook } from "../lib/status.ts";
import StatusBadge from "./StatusBadge.vue";

/** One agent at work (ADR 0019): who it is, where it runs, what it last did. Status is icon + text. */
const props = defineProps<{ agent: FleetAgent; selected?: boolean }>();
defineEmits<{ select: [] }>();
const { t, locale } = useI18n();

const look = computed(() => nodeLook[props.agent.status]);
const live = computed(() => props.agent.status === "running");
const until = computed(() =>
  props.agent.waiting?.until ? new Date(props.agent.waiting.until).toLocaleTimeString(locale.value, { hour: "2-digit", minute: "2-digit" }) : "",
);
</script>

<template>
  <button
    type="button"
    class="flex w-full flex-col gap-2 rounded-lg border bg-surface p-3 text-left transition-colors hover:bg-surface-2"
    :class="[`tone-${look.tone}`, { pulse: live }]"
    :style="{
      borderColor: selected ? 'var(--accent)' : agent.status === 'pending' ? 'var(--border)' : 'color-mix(in srgb, var(--tone) 55%, transparent)',
      boxShadow: selected ? '0 0 0 1px var(--accent)' : live ? 'var(--glow)' : 'var(--card-shadow)',
    }"
    :aria-pressed="selected"
    :aria-label="`${agent.node_id} (${agent.profile}): ${t(`status.${agent.status}`)}`"
    @click="$emit('select')"
  >
    <div class="flex items-center gap-2">
      <span class="grid size-8 shrink-0 place-items-center rounded-md bg-surface-2" style="color: var(--tone)">
        <component :is="iconFor(agent.profile)" :size="16" aria-hidden="true" />
      </span>
      <div class="min-w-0 flex-1">
        <p class="truncate font-medium">{{ agent.node_id }}</p>
        <p class="truncate text-xs text-muted">{{ agent.profile }}</p>
      </div>
      <span v-if="agent.pending_messages" class="tone-info inline-flex items-center gap-1 text-xs" style="color: var(--tone)" :title="t('fleet.pendingMessages', { n: agent.pending_messages })">
        <MessageSquare :size="12" aria-hidden="true" />{{ agent.pending_messages }}
      </span>
    </div>

    <StatusBadge :look="look" :status="agent.status" />

    <dl class="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-xs">
      <dt class="text-muted">{{ t("node.adapter") }}</dt>
      <dd class="truncate font-mono">{{ agent.adapter }}<template v-if="agent.model"> · {{ agent.model }}</template></dd>
      <template v-if="agent.iteration > 1 || agent.attempt > 1">
        <dt class="text-muted">{{ t("node.iteration") }}</dt>
        <dd>{{ agent.iteration }}<template v-if="agent.attempt > 1"> · {{ t("node.attempt") }} {{ agent.attempt }}</template></dd>
      </template>
      <dt class="text-muted">{{ t("node.cost") }}</dt>
      <dd class="font-mono">{{ money(agent.cost) }}</dd>
    </dl>

    <p v-if="agent.branch" class="flex items-center gap-1 truncate font-mono text-xs text-muted" :title="agent.branch">
      <GitBranch :size="12" class="shrink-0" aria-hidden="true" />{{ shortBranch(agent.branch) }}
    </p>

    <!-- The status badge already says it waits for approval; a quota wait adds when it ends. -->
    <p v-if="agent.waiting?.kind === 'quota'" class="tone-warning flex items-center gap-1 text-xs" style="color: var(--tone)">
      <Clock :size="12" aria-hidden="true" />{{ t("fleet.waitingQuota", { until }) }}
    </p>
    <p v-else-if="agent.last_activity" class="truncate border-t border-line pt-2 text-xs text-muted" :title="agent.last_activity.text">
      <span v-if="agent.last_activity.tool" class="font-mono text-fg">{{ agent.last_activity.tool }} · </span>{{ agent.last_activity.text }}
    </p>
  </button>
</template>
