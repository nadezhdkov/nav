<script setup lang="ts">
import type { RepoView } from "@navarch/contracts";
import { Play } from "@lucide/vue";
import { onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useRouter } from "vue-router";
import { api } from "../api/client.ts";

/** A prompt run in a registered project or a repository of earlier runs (spec §6.12.4 "new work", ADR 0020, 0021). */
const { t } = useI18n();
const router = useRouter();
const repos = ref<RepoView[]>([]);
const repo = ref("");
const prompt = ref("");
const busy = ref(false);
const error = ref<string | null>(null);
const loaded = ref(false);

onMounted(async () => {
  try {
    const [projects, earlier] = await Promise.all([api.projects(), api.repos()]);
    // Registered projects first, then the other repositories earlier runs used.
    const known = new Set(projects.map((p) => p.path));
    repos.value = [...projects.map((p) => ({ path: p.path, last_run_at: p.added_at })), ...earlier.filter((r) => !known.has(r.path))];
    repo.value = repos.value[0]?.path ?? "";
  } catch (err) {
    error.value = (err as Error).message;
  } finally {
    loaded.value = true;
  }
});

async function start() {
  if (!repo.value || !prompt.value.trim()) return;
  busy.value = true;
  error.value = null;
  try {
    const run = await api.startRun({ repo_path: repo.value, prompt: prompt.value.trim() });
    await router.push(`/runs/${run.id}`);
  } catch (err) {
    error.value = (err as Error).message;
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section class="mx-auto max-w-2xl p-6 max-md:p-4">
    <h1 class="mb-4 text-xl font-semibold">{{ t("newRun.title") }}</h1>
    <p v-if="loaded && !repos.length" class="rounded-lg border border-dashed border-line p-6 text-center text-muted">{{ t("newRun.noRepos") }}</p>
    <form v-else class="space-y-4" @submit.prevent="start">
      <div>
        <label for="repo" class="mb-1 block text-sm text-muted">{{ t("newRun.repo") }}</label>
        <select id="repo" v-model="repo" class="min-h-11 w-full rounded-md border border-line bg-bg px-3 font-mono text-sm">
          <option v-for="r in repos" :key="r.path" :value="r.path">{{ r.path }}</option>
        </select>
      </div>
      <div>
        <label for="prompt" class="mb-1 block text-sm text-muted">{{ t("newRun.prompt") }}</label>
        <textarea id="prompt" v-model="prompt" rows="6" :placeholder="t('newRun.placeholder')" class="w-full rounded-md border border-line bg-bg px-3 py-2 text-base" />
      </div>
      <p class="text-xs text-muted">{{ t("newRun.note") }}</p>
      <button type="submit" :disabled="busy || !prompt.trim() || !repo" class="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-md bg-accent px-4 font-semibold text-bg disabled:opacity-60">
        <Play :size="18" aria-hidden="true" />{{ t("newRun.start") }}
      </button>
    </form>
    <p v-if="error" class="tone-danger mt-3 text-sm" style="color: var(--tone)" role="alert">{{ error }}</p>
  </section>
</template>
