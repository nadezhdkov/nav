<script setup lang="ts">
import { CircleX, Repeat, Unplug } from "@lucide/vue";
import { Handle, Position } from "@vue-flow/core";
import { useI18n } from "vue-i18n";
import type { StudioNode } from "../lib/studioGraph.ts";

/** A loop's lane in Flow Studio: selectable, connectable at its edges, holding its body nodes. */
defineProps<{ data: StudioNode; readOnly: boolean; selected: boolean }>();
const { t } = useI18n();
</script>

<template>
  <div
    class="rounded-xl border-2 border-dashed"
    :class="data.errors ? 'tone-danger' : 'tone-neutral'"
    :style="{
      width: `${data.width}px`,
      height: `${data.height}px`,
      borderColor: selected ? 'var(--accent)' : 'color-mix(in srgb, var(--tone) 45%, transparent)',
      background: 'color-mix(in srgb, var(--tone) 4%, transparent)',
    }"
    :aria-label="`${t('node.kind.loop')} ${data.label}`"
  >
    <Handle type="target" :position="Position.Left" :connectable="!readOnly" />
    <Handle id="out" type="source" :position="Position.Right" :connectable="!readOnly" />
    <div class="flex items-center gap-2 px-3 py-2 text-xs" style="color: var(--tone)">
      <Repeat :size="13" aria-hidden="true" />
      <span class="font-medium tracking-wide uppercase">{{ data.label }}</span>
      <span class="text-muted">{{ data.detail }}</span>
      <span v-if="data.errors" class="ml-auto inline-flex items-center gap-1"><CircleX :size="12" aria-hidden="true" />{{ t("studio.problems.errors", { n: data.errors }) }}</span>
      <span v-if="!data.connected" class="ml-auto inline-flex items-center gap-1 text-muted"><Unplug :size="12" aria-hidden="true" />{{ t("studio.disconnected") }}</span>
    </div>
  </div>
</template>
