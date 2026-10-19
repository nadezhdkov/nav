<script setup lang="ts">
import type { AutoMergeStatus, AutoMergeView, ReauthPurpose, SecurityKeysView } from "@navarch/contracts";
import { KeyRound, ShieldCheck, TriangleAlert } from "@lucide/vue";
import { onMounted, reactive, ref } from "vue";
import { useI18n } from "vue-i18n";
import { api } from "../api/client.ts";
import { createKey, useKey, webauthnSupported } from "../lib/webauthn.ts";
import { ago } from "../lib/status.ts";

/**
 * Settings → Security (spec §11.1, ADR 0062): security keys, and opt-in auto-merge per repository.
 * With a key registered, turning auto-merge on, and adding or removing keys, asks for a touch first.
 * Error texts come from the daemon; the repository's name and check reasons are plain text.
 */
const { t } = useI18n();
const keys = ref<SecurityKeysView | null>(null);
const merge = ref<AutoMergeStatus | null>(null);
const error = ref<string | null>(null);
const busy = ref<string | null>(null);
const keyName = ref("");
const confirming = reactive<Record<string, string>>({});
const supported = webauthnSupported();

async function load() {
  try {
    [keys.value, merge.value] = await Promise.all([api.securityKeys(), api.autoMerge()]);
    error.value = null;
  } catch (err) {
    error.value = (err as Error).message;
  }
}
onMounted(load);

/** The touch: asks the daemon for a challenge, the user's key signs it, and the daemon hands back a single-use token. */
async function touch(purpose: ReauthPurpose): Promise<string> {
  const options = await api.reauthOptions(purpose);
  const answer = await useKey(options);
  return (await api.reauthVerify({ challenge_id: options.challenge_id, ...answer })).token;
}

async function run(name: string, fn: () => Promise<void>) {
  busy.value = name;
  error.value = null;
  try {
    await fn();
    await load();
  } catch (err) {
    error.value = (err as Error).message;
  } finally {
    busy.value = null;
  }
}

const addKey = () =>
  run("add", async () => {
    const reauth = keys.value?.keys.length ? await touch("webauthn.change") : undefined;
    const options = await api.registrationOptions();
    const created = await createKey(options);
    await api.registerKey({ challenge_id: options.challenge_id, name: keyName.value.trim() || "Security key", ...(reauth ? { reauth } : {}), ...created });
    keyName.value = "";
  });

const removeKey = (id: string, name: string) =>
  run(`rm-${id}`, async () => {
    if (!window.confirm(t("security.keys.confirmRemove", { name }))) return;
    await api.removeKey(id, await touch("webauthn.change"));
  });

const enable = (p: AutoMergeView) =>
  run(`on-${p.project_id}`, async () => {
    const reauth = keys.value?.keys.length ? await touch("automerge.enable") : undefined;
    await api.setAutoMerge(p.project_id, { enabled: true, confirm: confirming[p.project_id] ?? "", ...(reauth ? { reauth } : {}) });
    delete confirming[p.project_id];
  });

const disable = (p: AutoMergeView) => run(`off-${p.project_id}`, async () => void (await api.setAutoMerge(p.project_id, { enabled: false })));
</script>

<template>
  <section class="max-w-4xl space-y-6 p-6 max-md:p-4">
    <h1 class="text-xl font-semibold">{{ t("nav.settings") }} · {{ t("security.title") }}</h1>
    <p v-if="error" class="text-sm" style="color: var(--tone-danger)" role="alert">{{ error }}</p>

    <div class="rounded-lg border border-line bg-surface p-4" data-testid="security-keys">
      <h2 class="mb-1 flex items-center gap-2 font-medium"><KeyRound :size="16" class="text-accent" aria-hidden="true" />{{ t("security.keys.title") }}</h2>
      <p class="mb-3 text-sm text-muted">{{ t("security.keys.intro") }}</p>
      <p v-if="!supported" class="text-sm" style="color: var(--tone-warning)"><TriangleAlert :size="14" class="mr-1 inline" aria-hidden="true" />{{ t("security.keys.unsupported") }}</p>
      <p v-else-if="keys?.unavailable" class="text-sm" style="color: var(--tone-warning)"><TriangleAlert :size="14" class="mr-1 inline" aria-hidden="true" />{{ keys.unavailable }}</p>
      <ul v-if="keys?.keys.length" class="mb-3 space-y-2">
        <li v-for="k in keys.keys" :key="k.id" class="flex items-center gap-3 rounded-md border border-line p-2.5 text-sm">
          <div class="min-w-0 flex-1">
            <p class="truncate font-medium">{{ k.name }}</p>
            <p class="truncate text-xs text-muted">{{ k.rp_id }} · {{ k.last_used_at ? t("security.keys.lastUsed", { when: ago(k.last_used_at) }) : t("security.keys.neverUsed") }}</p>
          </div>
          <button type="button" class="min-h-10 rounded-md border border-line px-3 hover:bg-surface-2 disabled:opacity-60" :disabled="busy !== null" @click="removeKey(k.id, k.name)">{{ t("security.keys.remove") }}</button>
        </li>
      </ul>
      <p v-else class="mb-3 text-sm text-muted">{{ t("security.keys.none") }}</p>
      <div class="flex flex-wrap items-center gap-2">
        <input v-model="keyName" type="text" maxlength="60" :placeholder="t('security.keys.namePlaceholder')" :aria-label="t('security.keys.name')" class="min-h-10 rounded-md border border-line bg-bg px-3 text-sm" />
        <button type="button" class="min-h-10 rounded-md bg-accent px-3 text-sm font-semibold text-bg disabled:opacity-60" :disabled="busy !== null || !supported || !!keys?.unavailable" @click="addKey">
          {{ busy === "add" ? t("security.keys.adding") : t("security.keys.add") }}
        </button>
      </div>
    </div>

    <div v-if="merge" class="rounded-lg border border-line bg-surface p-4" data-testid="auto-merge">
      <h2 class="mb-1 flex items-center gap-2 font-medium"><ShieldCheck :size="16" class="text-accent" aria-hidden="true" />{{ t("security.merge.title") }}</h2>
      <p class="mb-2 text-sm text-muted">{{ t("security.merge.intro") }}</p>
      <ul class="mb-4 list-disc space-y-0.5 pl-5 text-xs text-muted">
        <li v-for="c in merge.conditions" :key="c">{{ c }}</li>
      </ul>
      <p v-if="!merge.projects.length" class="text-sm text-muted">{{ t("security.merge.noProjects") }}</p>
      <ul class="space-y-3">
        <li v-for="p in merge.projects" :key="p.project_id" class="rounded-md border border-line p-3 text-sm">
          <div class="flex flex-wrap items-center gap-2">
            <span class="flex-1 font-medium">{{ p.repo }}</span>
            <span v-if="p.enabled" class="tone-warning" style="color: var(--tone)">{{ t("security.merge.on", { when: p.since ? ago(p.since) : "", strategy: p.strategy }) }}</span>
            <span v-else class="text-muted">{{ t("security.merge.off") }}</span>
            <button v-if="p.enabled" type="button" class="min-h-10 rounded-md border border-line px-3 hover:bg-surface-2 disabled:opacity-60" :disabled="busy !== null" @click="disable(p)">{{ t("security.merge.disable") }}</button>
          </div>
          <div v-if="!p.enabled" class="mt-2 flex flex-wrap items-center gap-2">
            <label class="text-xs text-muted" :for="`confirm-${p.project_id}`">{{ t("security.merge.confirmLabel", { repo: p.repo }) }}</label>
            <input :id="`confirm-${p.project_id}`" v-model="confirming[p.project_id]" type="text" autocomplete="off" spellcheck="false" class="min-h-10 flex-1 rounded-md border border-line bg-bg px-3 font-mono text-sm" />
            <button type="button" class="min-h-10 rounded-md bg-accent px-3 text-sm font-semibold text-bg disabled:opacity-60" :disabled="busy !== null || (confirming[p.project_id] ?? '').trim().toLowerCase() !== p.repo.toLowerCase()" @click="enable(p)">
              {{ busy === `on-${p.project_id}` ? t("security.merge.touch") : t("security.merge.enable") }}
            </button>
          </div>
          <ul v-if="p.waiting.length" class="mt-2 space-y-0.5 text-xs text-muted">
            <li v-for="w in p.waiting" :key="w.number">#{{ w.number }}: {{ w.reason }}</li>
          </ul>
        </li>
      </ul>
    </div>
  </section>
</template>
