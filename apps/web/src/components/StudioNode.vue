<script setup lang="ts">
import { AlertTriangle, CircleCheck, CircleSlash, CircleX, Unplug } from "@lucide/vue";
import { Handle, Position } from "@vue-flow/core";
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { kindIcon, kindTone } from "../lib/nodeKinds.ts";
import type { StudioNode } from "../lib/studioGraph.ts";

/** A node of the Flow Studio canvas: its kind, problems and dry-run outcome, with connectable handles. */
const props = defineProps<{ data: StudioNode; readOnly: boolean }>();
const { t } = useI18n();

const tone = computed(() => (props.data.errors ? "danger" : props.data.warnings ? "warning" : kindTone[props.data.type] ?? "neutral"));
const simIcon = { succeeded: CircleCheck, failed: CircleX, skipped: CircleSlash };
const simTone = { succeeded: "success", failed: "danger", skipped: "muted" };
const known = computed(() => props.data.type in kindIcon);
/** Only top-level nodes connect: a loop body runs in order. */
const connectable = computed(() => !props.readOnly && !props.data.parent);
</script>

<template>
  <div
    class="flex h-[96px] w-[200px] flex-col justify-between rounded-lg border bg-surface px-3 py-2.5"
    :class="[`tone-${tone}`, { 'border-dashed': !data.connected }]"
    :style="{
      borderColor: data.errors || data.warnings ? 'color-mix(in srgb, var(--tone) 70%, transparent)' : 'var(--border)',
      boxShadow: data.sim === 'succeeded' ? '0 0 0 1px var(--tone-success), var(--card-shadow)' : 'var(--card-shadow)',
      opacity: data.sim === 'skipped' ? 0.6 : 1,
    }"
    :aria-label="`${known ? t(`node.kind.${data.type}`) : data.type} ${data.label}${data.errors ? `, ${t('studio.problems.errors', { n: data.errors })}` : ''}${data.connected ? '' : `, ${t('studio.disconnected')}`}`"
  >
    <Handle type="target" :position="Position.Left" :connectable="connectable && data.type !== 'trigger'" />
    <Handle id="out" type="source" :position="Position.Right" :connectable="connectable" />
    <Handle id="back-out" type="source" :position="Position.Bottom" :connectable="false" />
    <Handle id="back-in" type="target" :position="Position.Bottom" :connectable="false" />
    <div class="flex items-center gap-2">
      <span class="grid size-6 shrink-0 place-items-center rounded-md" :class="`tone-${kindTone[data.type] ?? 'neutral'}`" style="background: color-mix(in srgb, var(--tone) 16%, transparent); color: var(--tone)">
        <component :is="kindIcon[data.type] ?? AlertTriangle" :size="14" aria-hidden="true" />
      </span>
      <span class="truncate font-medium">{{ data.label }}</span>
      <span v-if="data.runs > 1" class="ml-auto font-mono text-[11px] text-muted">×{{ data.runs }}</span>
    </div>
    <div class="truncate font-mono text-[11px] text-muted">{{ data.detail ?? (known ? t(`node.kind.${data.type}`) : data.type || "?") }}</div>
    <div class="flex items-center gap-2 text-xs font-medium">
      <span v-if="data.errors" class="tone-danger inline-flex items-center gap-1" style="color: var(--tone)">
        <CircleX :size="13" aria-hidden="true" />{{ t("studio.problems.errors", { n: data.errors }) }}
      </span>
      <span v-else-if="data.warnings" class="tone-warning inline-flex items-center gap-1" style="color: var(--tone)">
        <AlertTriangle :size="13" aria-hidden="true" />{{ t("studio.problems.warnings", { n: data.warnings }) }}
      </span>
      <span v-if="!data.connected" class="inline-flex items-center gap-1 text-muted"><Unplug :size="13" aria-hidden="true" />{{ t("studio.disconnected") }}</span>
      <span v-if="data.sim" class="ml-auto inline-flex items-center gap-1" :class="`tone-${simTone[data.sim]}`" style="color: var(--tone)">
        <component :is="simIcon[data.sim]" :size="13" aria-hidden="true" />{{ t(`studio.sim.state.${data.sim}`) }}
      </span>
    </div>
  </div>
</template>
