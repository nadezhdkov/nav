<script setup lang="ts">
import { Check, Copy } from "@lucide/vue";
import { ref } from "vue";

const props = defineProps<{ text: string }>();
const copied = ref(false);

async function copy() {
  try {
    await navigator.clipboard.writeText(props.text);
    copied.value = true;
    setTimeout(() => (copied.value = false), 1600);
  } catch {
    copied.value = false;
  }
}
</script>

<template>
  <button
    type="button"
    class="flex h-9 items-center gap-1.5 rounded-md border border-border bg-surface px-2.5 font-mono text-xs text-muted transition hover:text-text"
    :aria-label="copied ? 'Copied' : 'Copy to clipboard'"
    @click="copy"
  >
    <Check v-if="copied" :size="14" class="text-success" aria-hidden="true" />
    <Copy v-else :size="14" aria-hidden="true" />
    <span aria-live="polite">{{ copied ? "Copied" : "Copy" }}</span>
  </button>
</template>
