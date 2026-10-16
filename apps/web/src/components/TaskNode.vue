<script setup lang="ts">
import { Bot, Flag, GitPullRequestDraft, Hand, Split, Swords, Users, Workflow, Zap } from "@lucide/vue";
import { Handle, Position } from "@vue-flow/core";
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import type { GraphNode } from "../lib/graph.ts";
import { nodeLook } from "../lib/status.ts";

const props = defineProps<{ data: GraphNode }>();
const { t } = useI18n();

const kindIcon = { trigger: Flag, agent: Bot, action: Zap, github: GitPullRequestDraft, approval: Hand, loop: Bot, team: Users, compete: Swords, subflow: Workflow, parallel: Split };
const look = computed(() => nodeLook[props.data.state]);
const gate = computed(() => props.data.kind === "approval" || props.data.state === "waiting_approval");
const live = computed(() => props.data.state === "running" || props.data.state === "waiting_approval");
const meta = computed(() => {
  const task = props.data.task;
  if (!task) return props.data.detail;
  if (props.data.kind === "agent") return task.model ?? task.adapter;
  return props.data.detail;
});
</script>

<template>
  <div
    class="flex h-[96px] w-[200px] flex-col justify-between rounded-lg border bg-surface px-3 py-2.5"
    :class="[`tone-${look.tone}`, { pulse: live, 'border-dashed': gate && data.state === 'not_started' }]"
    :style="{
      borderColor: data.state === 'not_started' ? 'var(--border)' : 'color-mix(in srgb, var(--tone) 60%, transparent)',
      boxShadow: live || data.state === 'succeeded' ? 'var(--glow)' : 'var(--card-shadow)',
      background: gate ? 'color-mix(in srgb, var(--tone-warning) 8%, var(--surface))' : undefined,
    }"
    :aria-label="`${t(`node.kind.${data.kind}`)} ${data.label}: ${t(`status.${data.state}`)}`"
  >
    <Handle type="target" :position="Position.Left" :connectable="false" />
    <Handle id="out" type="source" :position="Position.Right" :connectable="false" />
    <Handle id="back-out" type="source" :position="Position.Bottom" :connectable="false" />
    <Handle id="back-in" type="target" :position="Position.Bottom" :connectable="false" />
    <div class="flex items-center gap-2">
      <span
        class="grid size-6 shrink-0 place-items-center rounded-md"
        :class="gate ? 'tone-warning' : 'tone-neutral'"
        style="background: color-mix(in srgb, var(--tone) 16%, transparent); color: var(--tone)"
      >
        <component :is="kindIcon[data.kind]" :size="14" aria-hidden="true" />
      </span>
      <span class="truncate font-medium">{{ data.label }}</span>
      <span v-if="data.iteration && data.iteration > 1" class="ml-auto font-mono text-[11px] text-muted">×{{ data.iteration }}</span>
    </div>
    <div class="truncate font-mono text-[11px] text-muted">{{ meta ?? t(`node.kind.${data.kind}`) }}</div>
    <div class="flex items-center gap-1.5 text-xs font-medium" style="color: var(--tone)">
      <component :is="look.icon" :size="13" :class="{ spin: look.spin }" aria-hidden="true" />
      {{ t(`status.${data.state}`) }}
    </div>
  </div>
</template>
