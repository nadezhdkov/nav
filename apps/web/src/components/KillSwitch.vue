<script setup lang="ts">
import { isTerminalRun } from "@navarch/contracts";
import { OctagonX } from "@lucide/vue";
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { api } from "../api/client.ts";
import { useRunsStore } from "../stores/runs.ts";

/** The kill switch (spec §6.12.4): pauses every active run after saying exactly that. */
const props = defineProps<{ compact?: boolean }>();
const { t } = useI18n();
const runs = useRunsStore();
const busy = ref(false);
const message = ref<string | null>(null);
const active = computed(() => runs.runs.filter((r) => !isTerminalRun(r.status) && r.status !== "paused" && r.status !== "budget_exceeded").length);

async function stop() {
  message.value = null;
  if (!active.value) return void (message.value = t("kill.none"));
  if (!window.confirm(t("kill.confirm", { n: active.value }))) return;
  busy.value = true;
  try {
    const result = await api.stopAll();
    message.value = t("kill.done", { n: result.paused.length });
    await runs.load();
  } catch (err) {
    message.value = (err as Error).message;
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div>
    <button
      type="button"
      :disabled="busy"
      class="tone-danger inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-md border px-4 font-semibold disabled:opacity-60"
      :class="props.compact ? 'text-sm' : ''"
      style="color: var(--tone); border-color: var(--tone); background: color-mix(in srgb, var(--tone) 12%, transparent)"
      @click="stop"
    >
      <OctagonX :size="18" aria-hidden="true" />
      <span :class="props.compact ? 'max-md:sr-only' : ''">{{ t("kill.button") }}</span>
    </button>
    <p v-if="message" class="mt-2 text-sm text-muted" role="status">{{ message }}</p>
  </div>
</template>
