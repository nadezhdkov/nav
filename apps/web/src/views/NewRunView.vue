<script setup lang="ts">
import type { GitHubRepoView, RepoView } from "@navarch/contracts";
import { Play } from "@lucide/vue";
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useRouter } from "vue-router";
import { api } from "../api/client.ts";
import { isDevice } from "../api/session.ts";

/**
 * A prompt run in a registered project, a repository of earlier runs or, on the desktop, any GitHub
 * repository the token reaches, cloned on start (spec §6.12.4 "new work", ADR 0020, 0021, 0026).
 */
const { t } = useI18n();
const router = useRouter();
const repos = ref<RepoView[]>([]);
/** GitHub repositories with no local clone yet; picking one clones it first. */
const remote = ref<GitHubRepoView[]>([]);
const githubError = ref<string | null>(null);
/** `local:<path>` or `github:<owner/name>`. */
const repo = ref("");
const query = ref("");
const cloning = ref<string | null>(null);

const matches = (text: string) => text.toLowerCase().includes(query.value.trim().toLowerCase());
const shownLocal = computed(() => repos.value.filter((r) => matches(r.path)));
const shownRemote = computed(() => {
  const groups = new Map<string, GitHubRepoView[]>();
  for (const r of remote.value) if (matches(r.repo)) groups.set(r.owner, [...(groups.get(r.owner) ?? []), r]);
  return [...groups.entries()];
});
const picked = computed(() => (repo.value.startsWith("github:") ? remote.value.find((r) => `github:${r.repo}` === repo.value) : undefined));
const prompt = ref("");
/** Team mode (ADR 0022): a lead agent delegates to other agents. Phones keep the daemon's defaults (ADR 0020). */
const team = ref(false);
const busy = ref(false);
const error = ref<string | null>(null);
const loaded = ref(false);

onMounted(async () => {
  try {
    const [projects, earlier] = await Promise.all([api.projects(), api.repos()]);
    // Registered projects first, then the other repositories earlier runs used.
    const known = new Set(projects.map((p) => p.path));
    repos.value = [...projects.map((p) => ({ path: p.path, last_run_at: p.added_at })), ...earlier.filter((r) => !known.has(r.path))];
    repo.value = repos.value[0] ? `local:${repos.value[0].path}` : "";
  } catch (err) {
    error.value = (err as Error).message;
  } finally {
    loaded.value = true;
  }
  // Phones keep to registered projects (ADR 0020); a missing token only hides the GitHub list.
  if (isDevice.value) return;
  try {
    remote.value = (await api.githubRepos()).filter((r) => !r.path);
    if (!repo.value && remote.value[0]) repo.value = `github:${remote.value[0].repo}`;
  } catch (err) {
    githubError.value = (err as Error).message;
  }
});

async function start() {
  if (!repo.value || !prompt.value.trim()) return;
  busy.value = true;
  error.value = null;
  try {
    let path = repo.value.slice("local:".length);
    if (picked.value) {
      cloning.value = picked.value.repo;
      path = (await api.cloneRepo(picked.value.repo)).path;
    }
    const run = await api.startRun({ repo_path: path, prompt: prompt.value.trim(), ...(team.value && !isDevice.value ? { flow: "team" } : {}) });
    await router.push(`/runs/${run.id}`);
  } catch (err) {
    error.value = (err as Error).message;
  } finally {
    busy.value = false;
    cloning.value = null;
  }
}
</script>

<template>
  <section class="mx-auto max-w-2xl p-6 max-md:p-4">
    <h1 class="mb-4 text-xl font-semibold">{{ t("newRun.title") }}</h1>
    <p v-if="loaded && !repos.length && !remote.length" class="rounded-lg border border-dashed border-line p-6 text-center text-muted">{{ t("newRun.noRepos") }}</p>
    <form v-else class="space-y-4" @submit.prevent="start">
      <div>
        <label for="repo" class="mb-1 block text-sm text-muted">{{ t("newRun.repo") }}</label>
        <input
          v-if="repos.length + remote.length > 8"
          v-model="query"
          type="search"
          :placeholder="t('newRun.search')"
          :aria-label="t('newRun.search')"
          class="mb-2 min-h-11 w-full rounded-md border border-line bg-bg px-3 text-sm"
        />
        <select id="repo" v-model="repo" class="min-h-11 w-full rounded-md border border-line bg-bg px-3 font-mono text-sm">
          <optgroup v-if="shownLocal.length" :label="t('newRun.local')">
            <option v-for="r in shownLocal" :key="r.path" :value="`local:${r.path}`">{{ r.path }}</option>
          </optgroup>
          <optgroup v-for="[owner, list] in shownRemote" :key="owner" :label="t('newRun.github', { owner })">
            <option v-for="r in list" :key="r.repo" :value="`github:${r.repo}`">{{ r.repo }}{{ r.private ? ` (${t("newRun.private")})` : "" }}</option>
          </optgroup>
        </select>
        <p v-if="!shownLocal.length && !shownRemote.length" class="mt-1 text-xs text-muted">{{ t("newRun.noMatch") }}</p>
        <p v-if="picked" class="mt-1 text-xs text-muted">{{ t("newRun.willClone", { repo: picked.repo }) }}</p>
        <p v-if="picked && !picked.can_push" class="tone-warning mt-1 text-xs" style="color: var(--tone)">{{ t("newRun.noPush", { repo: picked.repo }) }}</p>
        <p v-if="githubError" class="mt-1 text-xs text-muted">{{ t("newRun.githubUnavailable", { error: githubError }) }}</p>
      </div>
      <div>
        <label for="prompt" class="mb-1 block text-sm text-muted">{{ t("newRun.prompt") }}</label>
        <textarea id="prompt" v-model="prompt" rows="6" :placeholder="t('newRun.placeholder')" class="w-full rounded-md border border-line bg-bg px-3 py-2 text-base" />
      </div>
      <label v-if="!isDevice" class="flex min-h-11 items-start gap-3 rounded-md border border-line px-3 py-2">
        <input v-model="team" type="checkbox" class="mt-1 size-4" />
        <span>
          <span class="block text-sm font-medium">{{ t("newRun.team") }}</span>
          <span class="block text-xs text-muted">{{ t("newRun.teamHint") }}</span>
        </span>
      </label>
      <p class="text-xs text-muted">{{ t("newRun.note", { flow: team && !isDevice ? "team" : "task" }) }}</p>
      <button type="submit" :disabled="busy || !prompt.trim() || !repo" class="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-md bg-accent px-4 font-semibold text-bg disabled:opacity-60">
        <Play :size="18" aria-hidden="true" />{{ cloning ? t("newRun.cloning", { repo: cloning }) : t("newRun.start") }}
      </button>
    </form>
    <p v-if="error" class="tone-danger mt-3 text-sm" style="color: var(--tone)" role="alert">{{ error }}</p>
  </section>
</template>
