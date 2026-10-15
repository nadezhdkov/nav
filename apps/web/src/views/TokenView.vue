<script setup lang="ts">
import { KeyRound } from "@lucide/vue";
import { ref } from "vue";
import { useI18n } from "vue-i18n";
import { api } from "../api/client.ts";
import { clearToken, setToken } from "../api/token.ts";

const { t } = useI18n();
const value = ref("");
const failed = ref(false);
const busy = ref(false);

async function connect() {
  if (!value.value.trim()) return;
  busy.value = true;
  setToken(value.value);
  try {
    await api.health();
  } catch {
    clearToken();
    failed.value = true;
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="grid-canvas flex min-h-full items-center justify-center p-4">
    <form class="w-full max-w-md rounded-xl border border-line bg-surface p-6 shadow-2xl" @submit.prevent="connect">
      <div class="mb-4 flex items-center gap-3">
        <img src="/favicon.svg" alt="" class="size-9" />
        <div>
          <h1 class="text-lg font-semibold">{{ t("token.title") }}</h1>
          <p class="text-xs text-muted">{{ t("app.tagline") }}</p>
        </div>
      </div>
      <p class="text-sm text-muted">{{ t("token.body") }}</p>
      <pre class="my-3 rounded-md border border-line bg-bg px-3 py-2 font-mono text-sm">navarch web</pre>
      <label for="token" class="mt-4 block text-sm text-muted">{{ t("token.paste") }}</label>
      <div class="mt-2 flex gap-2">
        <input
          id="token"
          v-model="value"
          type="password"
          autocomplete="off"
          :aria-label="t('token.label')"
          class="min-h-10 flex-1 rounded-md border border-line bg-bg px-3 font-mono text-sm"
        />
        <button
          type="submit"
          :disabled="busy"
          class="inline-flex min-h-10 items-center gap-2 rounded-md bg-accent px-4 font-medium text-bg disabled:opacity-60"
        >
          <KeyRound :size="16" aria-hidden="true" />{{ t("token.submit") }}
        </button>
      </div>
      <p v-if="failed" class="tone-danger mt-3 text-sm" style="color: var(--tone)" role="alert">
        {{ t("token.invalid") }}
      </p>
    </form>
  </div>
</template>
