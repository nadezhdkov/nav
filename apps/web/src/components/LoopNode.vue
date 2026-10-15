<script setup lang="ts">
import { Repeat } from "@lucide/vue";
import { Handle, Position } from "@vue-flow/core";
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import type { GraphNode } from "../lib/graph.ts";
import { nodeLook } from "../lib/status.ts";

/** A dashed lane around a loop body, labelled with its iteration (spec §6.2.4). */
const props = defineProps<{ data: GraphNode }>();
const { t } = useI18n();
const look = computed(() => nodeLook[props.data.state]);
</script>

<template>
  <div
    class="rounded-xl border-2 border-dashed"
    :class="`tone-${look.tone}`"
    :style="{
      width: `${data.width}px`,
      height: `${data.height}px`,
      borderColor: 'color-mix(in srgb, var(--tone) 45%, transparent)',
      background: 'color-mix(in srgb, var(--tone) 4%, transparent)',
    }"
    :aria-label="`${t('node.kind.loop')} ${data.label}: ${t(`status.${data.state}`)}`"
  >
    <Handle type="target" :position="Position.Left" :connectable="false" />
    <Handle id="out" type="source" :position="Position.Right" :connectable="false" />
    <div class="flex items-center gap-2 px-3 py-2 text-xs" style="color: var(--tone)">
      <Repeat :size="13" aria-hidden="true" />
      <span class="font-medium tracking-wide uppercase">{{ data.label }}</span>
      <span v-if="data.iteration" class="text-muted">
        {{ t("node.iterationOf", { n: data.iteration, max: data.maxIterations ?? "?" }) }}
      </span>
      <span class="ml-auto inline-flex items-center gap-1">
        <component :is="look.icon" :size="12" :class="{ spin: look.spin }" aria-hidden="true" />
        {{ t(`status.${data.state}`) }}
      </span>
    </div>
  </div>
</template>
