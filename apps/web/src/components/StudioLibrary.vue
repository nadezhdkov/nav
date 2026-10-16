<script setup lang="ts">
import { useI18n } from "vue-i18n";
import { NODE_TYPES, type NodeType } from "../lib/flowDoc.ts";
import { kindIcon, kindTone } from "../lib/nodeKinds.ts";

/** Flow Studio's library (spec §6.2.3): the node types the engine runs. Click to add, or drag onto the canvas. */
defineProps<{ disabled: boolean }>();
const emit = defineEmits<{ add: [type: NodeType] }>();
const { t } = useI18n();

function onDragStart(e: DragEvent, type: NodeType) {
  e.dataTransfer?.setData("application/x-navarch-node", type);
  if (e.dataTransfer) e.dataTransfer.effectAllowed = "copy";
}
</script>

<template>
  <aside class="flex w-56 shrink-0 flex-col overflow-auto border-r border-line bg-surface" :aria-label="t('studio.library.title')">
    <h2 class="px-3 pt-3 pb-1 text-xs font-semibold tracking-wide text-muted uppercase">{{ t("studio.library.title") }}</h2>
    <p class="px-3 pb-2 text-xs text-muted">{{ t("studio.library.hint") }}</p>
    <ul class="space-y-1 px-2 pb-3">
      <li v-for="type in NODE_TYPES" :key="type">
        <button
          type="button"
          :draggable="!disabled"
          :disabled="disabled"
          class="flex min-h-11 w-full items-start gap-2.5 rounded-md px-2 py-1.5 text-left hover:bg-surface-2 disabled:opacity-50"
          @click="emit('add', type)"
          @dragstart="onDragStart($event, type)"
        >
          <span class="mt-0.5 grid size-6 shrink-0 place-items-center rounded-md" :class="`tone-${kindTone[type]}`" style="background: color-mix(in srgb, var(--tone) 16%, transparent); color: var(--tone)">
            <component :is="kindIcon[type]" :size="14" aria-hidden="true" />
          </span>
          <span class="min-w-0">
            <span class="block text-sm font-medium">{{ t(`node.kind.${type}`) }}</span>
            <span class="block text-xs text-muted">{{ t(`studio.library.about.${type}`) }}</span>
          </span>
        </button>
      </li>
    </ul>
  </aside>
</template>
