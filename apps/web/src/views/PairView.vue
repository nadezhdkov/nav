<script setup lang="ts">
import { Smartphone } from "@lucide/vue";
import { ref } from "vue";
import { useI18n } from "vue-i18n";
import { authorized, pendingPair } from "../api/client.ts";
import { pairDevice } from "../api/session.ts";

/** Pairing on the phone (ADR 0020): the code came in the QR link's fragment; the user names the device. */
const { t } = useI18n();
const name = ref(guessName(navigator.userAgent));
const busy = ref(false);
const failed = ref(false);

function guessName(ua: string): string {
  const model = /Android [\d.]+; ([^;)]+)/.exec(ua)?.[1]?.trim();
  if (model && model !== "K") return model;
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Android/.test(ua)) return "Android";
  return "Phone";
}

async function pair() {
  if (!pendingPair.value || !name.value.trim()) return;
  busy.value = true;
  failed.value = false;
  try {
    if (await pairDevice(pendingPair.value, name.value.trim())) {
      pendingPair.value = null;
      authorized.value = true;
    } else failed.value = true;
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="grid-canvas flex min-h-full items-center justify-center p-4">
    <form class="w-full max-w-md rounded-xl border border-line bg-surface p-6 shadow-2xl" @submit.prevent="pair">
      <div class="mb-4 flex items-center gap-3">
        <img src="/favicon.svg" alt="" class="size-9" />
        <h1 class="text-lg font-semibold">{{ t("pair.title") }}</h1>
      </div>
      <template v-if="pendingPair">
        <p class="text-sm text-muted">{{ t("pair.body") }}</p>
        <label for="device-name" class="mt-4 block text-sm text-muted">{{ t("pair.name") }}</label>
        <input id="device-name" v-model="name" maxlength="80" autocomplete="off" class="mt-1 min-h-11 w-full rounded-md border border-line bg-bg px-3 text-base" />
        <button type="submit" :disabled="busy || !name.trim()" class="mt-4 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-md bg-accent px-4 font-semibold text-bg disabled:opacity-60">
          <Smartphone :size="18" aria-hidden="true" />{{ t("pair.submit") }}
        </button>
        <p v-if="failed" class="tone-danger mt-3 text-sm" style="color: var(--tone)" role="alert">{{ t("pair.failed") }}</p>
      </template>
      <p v-else class="text-sm text-muted">{{ t("pair.notPaired") }}</p>
    </form>
  </div>
</template>
