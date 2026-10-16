<script setup lang="ts">
import type { FlowProblem } from "@navarch/contracts";
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";

/** Flow Studio's YAML view (ADR 0033): the document itself, with line numbers and problem markers. */
const props = defineProps<{ text: string; problems: FlowProblem[]; readOnly: boolean }>();
const emit = defineEmits<{ "update:text": [text: string] }>();
const { t } = useI18n();
const area = ref<HTMLTextAreaElement | null>(null);
const gutter = ref<HTMLElement | null>(null);

const lines = computed(() => props.text.split("\n").length);
const marks = computed(() => {
  const out = new Map<number, "error" | "warning">();
  for (const p of props.problems) if (p.line && out.get(p.line) !== "error") out.set(p.line, p.severity);
  return out;
});

/** Puts the caret at the start of a line and scrolls to it (from the Problems list). */
function goTo(line: number) {
  const el = area.value;
  if (!el) return;
  const offset = props.text.split("\n").slice(0, line - 1).reduce((n, l) => n + l.length + 1, 0);
  el.focus();
  el.setSelectionRange(offset, offset);
  el.scrollTop = Math.max(0, (line - 4) * 20);
}
defineExpose({ goTo });

function onKey(e: KeyboardEvent) {
  // Tab inserts two spaces: YAML is indented with spaces.
  if (e.key !== "Tab" || e.shiftKey || props.readOnly) return;
  e.preventDefault();
  const el = e.target as HTMLTextAreaElement;
  const { selectionStart: a, selectionEnd: b } = el;
  emit("update:text", props.text.slice(0, a) + "  " + props.text.slice(b));
  requestAnimationFrame(() => el.setSelectionRange(a + 2, a + 2));
}
</script>

<template>
  <div class="flex h-full min-h-0 overflow-hidden bg-bg font-mono text-[13px] leading-5">
    <div ref="gutter" class="shrink-0 overflow-hidden border-r border-line py-3 text-right text-muted select-none" aria-hidden="true">
      <div v-for="n in lines" :key="n" class="flex h-5 items-center justify-end gap-1 pr-2 pl-1">
        <span
          v-if="marks.get(n)"
          class="size-2 rounded-full"
          :class="marks.get(n) === 'error' ? 'tone-danger' : 'tone-warning'"
          style="background: var(--tone)"
          :title="marks.get(n) === 'error' ? t('studio.problems.error') : t('studio.problems.warning')"
        />
        <span class="w-7">{{ n }}</span>
      </div>
    </div>
    <textarea
      ref="area"
      :value="text"
      :readonly="readOnly"
      spellcheck="false"
      autocapitalize="off"
      autocomplete="off"
      wrap="off"
      class="h-full min-w-0 flex-1 resize-none bg-transparent px-3 py-3 outline-none"
      :aria-label="t('studio.yaml')"
      @input="emit('update:text', ($event.target as HTMLTextAreaElement).value)"
      @keydown="onKey"
      @scroll="gutter && (gutter.scrollTop = ($event.target as HTMLTextAreaElement).scrollTop)"
    />
  </div>
</template>
