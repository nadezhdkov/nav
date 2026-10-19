<script setup lang="ts">
import type { DevicePairing, DeviceView, RemoteStatus } from "@navarch/contracts";
import { CircleCheck, CircleX, Smartphone, TriangleAlert } from "@lucide/vue";
import { computed, onMounted, onUnmounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { api } from "../api/client.ts";
import QrCode from "../components/QrCode.vue";
import { ago } from "../lib/status.ts";

/** Settings → Devices on the desktop (spec §6.12.3): remote access, pairing by QR code, revoking. */
const { t } = useI18n();
const remote = ref<RemoteStatus | null>(null);
const devices = ref<DeviceView[]>([]);
const pairing = ref<DevicePairing | null>(null);
const now = ref(Date.now());
const error = ref<string | null>(null);
let tick: ReturnType<typeof setInterval> | undefined;

async function load() {
  try {
    [remote.value, devices.value] = await Promise.all([api.remote(), api.devices()]);
    error.value = null;
  } catch (err) {
    error.value = (err as Error).message;
  }
}
onMounted(() => {
  void load();
  tick = setInterval(() => {
    now.value = Date.now();
    if (pairing.value && Date.parse(pairing.value.expires_at) <= now.value) pairing.value = null;
  }, 1000);
});
onUnmounted(() => clearInterval(tick));

const secondsLeft = computed(() => (pairing.value ? Math.max(0, Math.round((Date.parse(pairing.value.expires_at) - now.value) / 1000)) : 0));
const ready = computed(() => remote.value?.mode === "tailscale" && !!remote.value.url);
const tailscaleText = computed(() => {
  const r = remote.value;
  if (!r) return "";
  if (r.mode === "off") return t("devices.tailscale.off");
  if (!r.installed) return t("devices.tailscale.missing");
  return r.running ? t("devices.tailscale.running") : t("devices.tailscale.stopped");
});

async function pair() {
  error.value = null;
  try {
    pairing.value = await api.pairing();
  } catch (err) {
    error.value = (err as Error).message;
  }
}

async function revoke(d: DeviceView) {
  if (!window.confirm(t("devices.confirmRevoke", { name: d.name }))) return;
  try {
    await api.revokeDevice(d.id);
    await load();
  } catch (err) {
    error.value = (err as Error).message;
  }
}
</script>

<template>
  <section class="max-w-4xl space-y-6 p-6 max-md:p-4">
    <h1 class="text-xl font-semibold">{{ t("nav.settings") }} · {{ t("devices.title") }}</h1>
    <p v-if="error" class="tone-danger text-sm" style="color: var(--tone)" role="alert">{{ error }}</p>
    <RouterLink to="/settings/security" class="inline-block text-sm text-accent hover:underline">{{ t("security.title") }} →</RouterLink>

    <div v-if="remote" class="rounded-lg border border-line bg-surface p-4">
      <h2 class="mb-3 font-medium">{{ t("devices.remote") }}</h2>
      <ul class="space-y-2 text-sm">
        <li class="flex items-center gap-2" :class="remote.running ? 'tone-success' : 'tone-warning'">
          <component :is="remote.running ? CircleCheck : TriangleAlert" :size="16" style="color: var(--tone)" aria-hidden="true" />{{ tailscaleText }}
        </li>
        <li class="flex flex-wrap items-center gap-2">
          <span class="text-muted">{{ t("devices.url") }}:</span>
          <span class="font-mono">{{ remote.url ?? t("devices.unknownUrl") }}</span>
        </li>
        <li v-if="remote.mode === 'tailscale'" class="flex items-start gap-2" :class="remote.serving ? 'tone-success' : 'tone-warning'">
          <component :is="remote.serving ? CircleCheck : TriangleAlert" :size="16" class="mt-0.5 shrink-0" style="color: var(--tone)" aria-hidden="true" />
          <span v-if="remote.serving">{{ t("devices.serving") }}</span>
          <span v-else>{{ t("devices.setup") }} <code class="rounded border border-line bg-bg px-1.5 py-0.5 font-mono">{{ remote.setup_command }}</code></span>
        </li>
      </ul>
    </div>

    <div class="rounded-lg border border-line bg-surface p-4">
      <button type="button" :disabled="!ready" class="inline-flex min-h-10 items-center gap-2 rounded-md bg-accent px-4 font-semibold text-bg disabled:opacity-50" @click="pair">
        <Smartphone :size="18" aria-hidden="true" />{{ t("devices.pair") }}
      </button>
      <div v-if="pairing" class="mt-4 flex flex-wrap items-center gap-6">
        <QrCode :value="pairing.url" :label="t('devices.pair')" class="size-56" />
        <div class="min-w-0 flex-1 space-y-2 text-sm">
          <p>{{ t("devices.scan") }}</p>
          <p class="font-mono text-xs break-all text-muted">{{ pairing.url }}</p>
          <p class="tone-warning" style="color: var(--tone)" role="timer">{{ t("devices.expires", { s: secondsLeft }) }}</p>
        </div>
      </div>
    </div>

    <div>
      <h2 class="mb-2 text-sm font-medium tracking-wide text-muted uppercase">{{ t("devices.list") }}</h2>
      <p v-if="!devices.length" class="rounded-lg border border-dashed border-line p-6 text-center text-muted">{{ t("devices.empty") }}</p>
      <ul v-else class="divide-y divide-line rounded-lg border border-line bg-surface text-sm">
        <li v-for="d in devices" :key="d.id" class="flex flex-wrap items-center gap-3 px-4 py-3" :class="{ 'opacity-60': d.revoked_at }">
          <Smartphone :size="16" class="text-muted" aria-hidden="true" />
          <span class="font-medium">{{ d.name }}</span>
          <span class="font-mono text-xs text-muted">{{ d.id }}</span>
          <span class="text-xs text-muted">{{ d.last_seen_at ? t("devices.lastSeen", { when: ago(d.last_seen_at) }) : t("devices.never") }}</span>
          <span class="text-xs text-muted">{{ d.push ? t("devices.pushOn") : t("devices.pushOff") }}</span>
          <span v-if="d.revoked_at" class="tone-muted ml-auto inline-flex items-center gap-1 text-xs" style="color: var(--tone)">
            <CircleX :size="14" aria-hidden="true" />{{ t("devices.revoked") }}
          </span>
          <button v-else type="button" class="tone-danger ml-auto min-h-9 rounded-md border px-3 text-sm" style="color: var(--tone); border-color: var(--tone)" @click="revoke(d)">
            {{ t("devices.revoke") }}
          </button>
        </li>
      </ul>
    </div>
  </section>
</template>
