<script setup lang="ts">
import type { DeviceView } from "@navarch/contracts";
import { Bell, BellOff, LogOut } from "@lucide/vue";
import { onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { api, authorized } from "../api/client.ts";
import { forgetDevice } from "../api/session.ts";
import type { Locale } from "../i18n.ts";
import { disablePush, enablePush, pushState, type PushState } from "../lib/push.ts";

/** This phone (spec §15.1 "Dispositivo/Conta"): its name, notifications, and signing out. */
const { t, locale } = useI18n();
const device = ref<DeviceView | null>(null);
const push = ref<PushState>("unsupported");
const busy = ref(false);
const error = ref<string | null>(null);

onMounted(async () => {
  push.value = await pushState().catch(() => "unsupported" as const);
  try {
    device.value = await api.me();
  } catch (err) {
    error.value = (err as Error).message;
  }
});

async function toggle() {
  busy.value = true;
  error.value = null;
  try {
    push.value = push.value === "on" ? await disablePush() : await enablePush(locale.value as Locale);
  } catch (err) {
    error.value = (err as Error).message;
  } finally {
    busy.value = false;
  }
}

async function signOut() {
  if (!device.value || !window.confirm(t("device.confirmSignOut"))) return;
  await disablePush().catch(() => {});
  await api.revokeDevice(device.value.id).catch(() => {});
  forgetDevice();
  authorized.value = false;
}
</script>

<template>
  <section class="mx-auto max-w-2xl space-y-5 p-6 max-md:p-4">
    <h1 class="text-xl font-semibold">{{ t("device.title") }}</h1>
    <dl v-if="device" class="divide-y divide-line rounded-lg border border-line bg-surface text-sm">
      <div class="flex gap-3 px-4 py-3"><dt class="w-28 text-muted">{{ t("device.name") }}</dt><dd class="font-medium">{{ device.name }}</dd></div>
      <div class="flex gap-3 px-4 py-3"><dt class="w-28 text-muted">{{ t("device.paired") }}</dt><dd>{{ new Date(device.paired_at).toLocaleString(locale) }}</dd></div>
    </dl>

    <div class="rounded-lg border border-line bg-surface p-4">
      <h2 class="mb-1 font-medium">{{ t("device.notifications") }}</h2>
      <p class="text-sm text-muted" role="status">{{ t(`device.push.${push}`) }}</p>
      <button
        v-if="push === 'on' || push === 'off'"
        type="button"
        :disabled="busy"
        class="mt-3 inline-flex min-h-11 items-center gap-2 rounded-md border border-line px-4 font-medium hover:bg-surface-2 disabled:opacity-60"
        @click="toggle"
      >
        <component :is="push === 'on' ? BellOff : Bell" :size="18" aria-hidden="true" />{{ push === "on" ? t("device.disable") : t("device.enable") }}
      </button>
    </div>

    <button type="button" class="tone-danger inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-md border px-4 font-medium" style="color: var(--tone); border-color: var(--tone)" @click="signOut">
      <LogOut :size="18" aria-hidden="true" />{{ t("device.signOut") }}
    </button>
    <p v-if="error" class="tone-danger text-sm" style="color: var(--tone)" role="alert">{{ error }}</p>
  </section>
</template>
