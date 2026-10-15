<script setup lang="ts">
import type { RunMessage, TaskStatus } from "@navarch/contracts";
import { Send, Zap } from "@lucide/vue";
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { api } from "../api/client.ts";

/**
 * Sends an instruction to a run, or to one agent of it (ADR 0019). "Next turn" waits for the next
 * agent attempt; "Interrupt now" is offered only for a running task whose adapter can resume, and
 * says what it does before it is sent.
 */
const props = defineProps<{
  runId: string;
  agent?: { id: string; node_id: string; status: TaskStatus; resumable: boolean } | null;
}>();
const emit = defineEmits<{ sent: [message: RunMessage] }>();
const { t } = useI18n();

const text = ref("");
const now = ref(false);
const busy = ref(false);
const error = ref<string | null>(null);
const sent = ref(false);

const canInterrupt = computed(() => Boolean(props.agent && props.agent.status === "running" && props.agent.resumable));
watch(canInterrupt, (ok) => {
  if (!ok) now.value = false;
});
watch(
  () => props.agent?.id,
  () => {
    now.value = false;
    error.value = null;
    sent.value = false;
  },
);

const target = computed(() => (props.agent ? props.agent.node_id : t("instruct.wholeRun")));

async function send() {
  const body = text.value.trim();
  if (!body || busy.value) return;
  busy.value = true;
  error.value = null;
  sent.value = false;
  try {
    const message = await api.sendMessage(props.runId, {
      text: body,
      delivery: now.value ? "now" : "next",
      ...(props.agent ? { task_id: props.agent.id } : {}),
    });
    text.value = "";
    now.value = false;
    sent.value = true;
    emit("sent", message);
  } catch (err) {
    error.value = (err as Error).message;
  } finally {
    busy.value = false;
  }
}

function onKey(e: KeyboardEvent) {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    void send();
  }
}
</script>

<template>
  <form class="space-y-2" @submit.prevent="send">
    <label :for="`instruct-${runId}`" class="block text-xs text-muted">{{ t("instruct.label", { target }) }}</label>
    <div class="flex items-end gap-2 rounded-lg border border-line bg-bg p-2 focus-within:border-accent">
      <textarea
        :id="`instruct-${runId}`"
        v-model="text"
        rows="2"
        maxlength="4000"
        :placeholder="t('instruct.placeholder')"
        class="min-h-10 flex-1 resize-none bg-transparent text-sm outline-none placeholder:text-muted"
        @keydown="onKey"
      />
      <button
        type="submit"
        :disabled="busy || !text.trim()"
        class="grid size-10 shrink-0 place-items-center rounded-md bg-accent text-bg disabled:opacity-40"
        :aria-label="t('instruct.send')"
        :title="t('instruct.send')"
      >
        <Send :size="16" aria-hidden="true" />
      </button>
    </div>
    <div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs" role="radiogroup" :aria-label="t('instruct.delivery')">
      <label class="inline-flex min-h-8 cursor-pointer items-center gap-1.5">
        <input v-model="now" type="radio" :value="false" class="accent-[var(--accent)]" />{{ t("instruct.next") }}
      </label>
      <label class="inline-flex min-h-8 items-center gap-1.5" :class="canInterrupt ? 'cursor-pointer' : 'cursor-not-allowed opacity-50'" :title="canInterrupt ? '' : t('instruct.nowUnavailable')">
        <input v-model="now" type="radio" :value="true" :disabled="!canInterrupt" class="accent-[var(--accent)]" />
        <Zap :size="12" aria-hidden="true" />{{ t("instruct.now") }}
      </label>
    </div>
    <p v-if="now && agent" class="tone-warning rounded-md border px-2 py-1.5 text-xs" style="color: var(--tone); border-color: color-mix(in srgb, var(--tone) 40%, transparent)">
      {{ t("instruct.nowWarning", { agent: agent.node_id }) }}
    </p>
    <p v-if="error" class="tone-danger text-xs" style="color: var(--tone)" role="alert">{{ error }}</p>
    <p v-else-if="sent" class="tone-success text-xs" style="color: var(--tone)" role="status">{{ t("instruct.sent") }}</p>
  </form>
</template>
