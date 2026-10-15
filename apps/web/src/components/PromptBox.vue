<script setup lang="ts">
import type { RunMessage } from "@navarch/contracts";
import { Send } from "@lucide/vue";
import { ref } from "vue";
import { useI18n } from "vue-i18n";
import { api } from "../api/client.ts";

/**
 * A one-line instruction to one agent on its tree card (slice 10). It always goes for the next
 * turn; interrupting a running agent stays in the agent panel, behind its warning.
 */
const props = defineProps<{ runId: string; taskId: string; label: string }>();
const emit = defineEmits<{ sent: [message: RunMessage] }>();
const { t } = useI18n();
const text = ref("");
const busy = ref(false);
const error = ref<string | null>(null);

async function send() {
  const body = text.value.trim();
  if (!body || busy.value) return;
  busy.value = true;
  error.value = null;
  try {
    const message = await api.sendMessage(props.runId, { text: body, delivery: "next", task_id: props.taskId });
    text.value = "";
    emit("sent", message);
  } catch (err) {
    error.value = (err as Error).message;
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <!-- nodrag/nopan: typing and selecting text must not move the canvas; keys stay in the box. -->
  <form class="nodrag nopan flex items-center gap-1 rounded-md border border-line bg-bg px-2 focus-within:border-accent" @submit.prevent="send" @click.stop @keydown.stop>
    <input
      v-model="text"
      maxlength="4000"
      :placeholder="t('tree.prompt')"
      :aria-label="t('tree.promptLabel', { agent: label })"
      class="min-h-8 min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted"
      :aria-invalid="error ? 'true' : undefined"
      :title="error ?? ''"
    />
    <button type="submit" :disabled="busy || !text.trim()" class="grid size-7 shrink-0 place-items-center rounded text-accent disabled:opacity-40" :aria-label="t('instruct.send')">
      <Send :size="13" aria-hidden="true" />
    </button>
  </form>
  <p v-if="error" class="tone-danger mt-0.5 truncate text-[11px]" style="color: var(--tone)" role="alert">{{ error }}</p>
</template>
