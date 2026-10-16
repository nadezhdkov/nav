<script setup lang="ts">
import { CircleCheck, CircleX, Upload, X } from "@lucide/vue";
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { hunks, lineDiff } from "../lib/lineDiff.ts";

/**
 * Publish confirmation (ADR 0033): what changes from the last published version, whether the draft
 * is valid, and what publishing does to runs. Any sensitive action shows what will happen first (AGENTS.md).
 */
const props = defineProps<{ name: string; from: string | null; to: string; version: number; errors: number; warnings: number; busy: boolean }>();
const emit = defineEmits<{ confirm: []; cancel: [] }>();
const { t } = useI18n();
const dialog = ref<HTMLDialogElement | null>(null);
onMounted(() => {
  const el = dialog.value;
  if (el?.showModal) el.showModal();
  else el?.setAttribute("open", "");
});

const diff = computed(() => hunks(lineDiff(props.from ?? "", props.to)));
const stats = computed(() => {
  const d = lineDiff(props.from ?? "", props.to);
  return { add: d.filter((l) => l.kind === "add").length, del: d.filter((l) => l.kind === "del").length };
});
</script>

<template>
  <dialog ref="dialog" class="m-auto w-[min(48rem,calc(100vw-2rem))] rounded-xl border border-line bg-surface p-0 text-fg backdrop:bg-black/60" :aria-label="t('studio.publish.title', { name, version })" @cancel.prevent="emit('cancel')">
    <div class="flex items-center gap-2 border-b border-line px-4 py-3">
      <Upload :size="18" class="text-accent" aria-hidden="true" />
      <h2 class="font-semibold">{{ t("studio.publish.title", { name, version }) }}</h2>
      <button type="button" class="ml-auto grid size-9 place-items-center rounded-md text-muted hover:text-fg" :aria-label="t('node.close')" @click="emit('cancel')"><X :size="16" aria-hidden="true" /></button>
    </div>
    <div class="space-y-3 p-4">
      <p class="flex items-center gap-2 text-sm" :class="errors ? 'tone-danger' : 'tone-success'" style="color: var(--tone)">
        <component :is="errors ? CircleX : CircleCheck" :size="16" aria-hidden="true" />
        {{ errors ? t("studio.publish.invalid", { n: errors }) : warnings ? t("studio.publish.validWarnings", { n: warnings }) : t("studio.publish.valid") }}
      </p>
      <p class="text-sm text-muted">{{ t("studio.publish.effect", { version }) }}</p>
      <div>
        <p class="mb-1 text-xs font-medium text-muted">
          {{ from === null ? t("studio.publish.first") : t("studio.publish.changes", { from: version - 1, add: stats.add, del: stats.del }) }}
        </p>
        <pre class="max-h-[50vh] overflow-auto rounded-md border border-line bg-bg py-2 font-mono text-xs leading-5"><template v-for="(d, i) in diff" :key="i"><span v-if="d === null" class="block px-3 text-muted">⋯</span><span v-else class="block px-3 whitespace-pre" :class="d.kind === 'add' ? 'tone-success' : d.kind === 'del' ? 'tone-danger' : ''" :style="d.kind === 'same' ? '' : 'background: color-mix(in srgb, var(--tone) 14%, transparent)'"><span class="mr-2 inline-block w-3 select-none" aria-hidden="true">{{ d.kind === "add" ? "+" : d.kind === "del" ? "−" : " " }}</span><span class="sr-only">{{ d.kind === "add" ? t("studio.publish.added") : d.kind === "del" ? t("studio.publish.removed") : "" }}</span>{{ d.text }}</span></template></pre>
      </div>
    </div>
    <div class="flex justify-end gap-2 border-t border-line px-4 py-3">
      <button type="button" class="min-h-11 rounded-md border border-line px-4 text-sm hover:bg-surface-2" @click="emit('cancel')">{{ t("studio.publish.cancel") }}</button>
      <button type="button" :disabled="busy || errors > 0" class="inline-flex min-h-11 items-center gap-2 rounded-md bg-accent px-4 text-sm font-semibold text-bg disabled:opacity-60" @click="emit('confirm')">
        <Upload :size="16" aria-hidden="true" />{{ t("studio.publish.confirm", { version }) }}
      </button>
    </div>
  </dialog>
</template>
