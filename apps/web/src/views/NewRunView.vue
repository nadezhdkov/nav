<script setup lang="ts">
import { ATTACHMENT_LIMITS, type GitHubRepoView, type RunAttachment } from "@navarch/contracts";
import { FileText, Paperclip, Play, X } from "@lucide/vue";
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useRouter } from "vue-router";
import { api } from "../api/client.ts";
import { isDevice } from "../api/session.ts";
import RepoPicker from "../components/RepoPicker.vue";
import { repoOptions, type RepoOption } from "../lib/repos.ts";

/**
 * A prompt run in a registered project, a repository of earlier runs or, on the desktop, any GitHub
 * repository the token reaches, cloned on start (spec §6.12.4 "new work", ADR 0020, 0021, 0026),
 * with documents (a spec, notes) every agent reads after its task.
 */
const { t, n } = useI18n();
const router = useRouter();
const options = ref<RepoOption[]>([]);
/** GitHub repositories with no local clone yet; picking one clones it first. */
const remote = ref<GitHubRepoView[]>([]);
const githubError = ref<string | null>(null);
/** `local:<path>` or `github:<owner/name>`. */
const repo = ref("");
const cloning = ref<string | null>(null);
const picked = computed(() => (repo.value.startsWith("github:") ? remote.value.find((r) => `github:${r.repo}` === repo.value) : undefined));
const prompt = ref("");
/**
 * How the agents work: one agent (`task`), a team with a lead (ADR 0022), or several competing
 * on the same task (ADR 0031). Phones keep the daemon's defaults (ADR 0020).
 */
const mode = ref<"task" | "team" | "compete">("task");
const flow = computed(() => (isDevice.value ? "task" : mode.value));
/** Compete needs a budget the user chose: N agents cost about N times one. */
const competitors = ref(3);
const budget = ref<number | null>(null);
const competeReady = computed(() => flow.value !== "compete" || (budget.value !== null && budget.value > 0 && competitors.value >= 2 && competitors.value <= 5));
const busy = ref(false);
const error = ref<string | null>(null);
const loaded = ref(false);

const attachments = ref<(RunAttachment & { bytes: number })[]>([]);
const attachErrors = ref<string[]>([]);
const fileInput = ref<HTMLInputElement | null>(null);
const dragging = ref(false);
const totalBytes = computed(() => attachments.value.reduce((s, a) => s + a.bytes, 0));
const kb = (bytes: number) => `${n(Math.max(0.1, bytes / 1000), { maximumFractionDigits: 1 })} kB`;
const TEXT_TYPES = ".md,.markdown,.txt,.rst,.adoc,.org,.json,.yaml,.yml,.toml,.csv,.tsv,.xml,.html,.sql,.graphql,.proto,.ini,.env.example,text/*";

async function addFiles(files: FileList | File[] | null | undefined) {
  attachErrors.value = [];
  for (const file of Array.from(files ?? [])) {
    if (file.size > ATTACHMENT_LIMITS.fileBytes) {
      attachErrors.value.push(t("newRun.files.tooBig", { name: file.name, max: kb(ATTACHMENT_LIMITS.fileBytes) }));
      continue;
    }
    const content = await file.text();
    if (content.includes("\u0000") || content.includes("�")) {
      attachErrors.value.push(t("newRun.files.notText", { name: file.name }));
      continue;
    }
    const name = file.name.replace(/[^\p{L}\p{N} ._-]/gu, "_").replace(/^[ .]+/, "").slice(0, 100) || "document.txt";
    const bytes = new TextEncoder().encode(content).length;
    const rest = attachments.value.filter((a) => a.name !== name);
    if (rest.length >= ATTACHMENT_LIMITS.files) {
      attachErrors.value.push(t("newRun.files.tooMany", { max: ATTACHMENT_LIMITS.files }));
      break;
    }
    if (rest.reduce((s, a) => s + a.bytes, 0) + bytes > ATTACHMENT_LIMITS.totalBytes) {
      attachErrors.value.push(t("newRun.files.totalTooBig", { name, max: kb(ATTACHMENT_LIMITS.totalBytes) }));
      continue;
    }
    attachments.value = [...rest, { name, content, bytes }];
  }
  if (fileInput.value) fileInput.value.value = "";
}

function remove(name: string) {
  attachments.value = attachments.value.filter((a) => a.name !== name);
  attachErrors.value = [];
}

function onDrop(e: DragEvent) {
  dragging.value = false;
  void addFiles(e.dataTransfer?.files);
}

onMounted(async () => {
  let projects: Awaited<ReturnType<typeof api.projects>> = [];
  let earlier: Awaited<ReturnType<typeof api.repos>> = [];
  try {
    [projects, earlier] = await Promise.all([api.projects(), api.repos()]);
  } catch (err) {
    error.value = (err as Error).message;
  }
  options.value = repoOptions(projects, earlier, []);
  repo.value = options.value[0]?.value ?? "";
  loaded.value = true;
  // Phones keep to registered projects (ADR 0020); a missing token only hides the GitHub list.
  if (isDevice.value) return;
  try {
    remote.value = (await api.githubRepos()).filter((r) => !r.path);
    options.value = repoOptions(projects, earlier, remote.value);
    if (!repo.value) repo.value = options.value[0]?.value ?? "";
  } catch (err) {
    githubError.value = (err as Error).message;
  }
});

async function start() {
  if (!repo.value || !prompt.value.trim() || !competeReady.value) return;
  busy.value = true;
  error.value = null;
  try {
    let path = repo.value.slice("local:".length);
    let warnings: string[] = [];
    if (picked.value) {
      cloning.value = picked.value.repo;
      ({ path, warnings } = await api.cloneRepo(picked.value.repo));
    }
    const run = await api.startRun({
      repo_path: path,
      prompt: prompt.value.trim(),
      ...(flow.value !== "task" ? { flow: flow.value } : {}),
      ...(flow.value === "compete" ? { budget: budget.value!, params: { competitors: competitors.value } } : {}),
      ...(attachments.value.length ? { attachments: attachments.value.map(({ name, content }) => ({ name, content })) } : {}),
    });
    // The run page shows them: the run starts either way, but issue runs there cannot open PRs.
    await router.push({ path: `/runs/${run.id}`, state: warnings.length ? { warnings } : {} });
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
    <p v-if="loaded && !options.length" class="rounded-lg border border-dashed border-line p-6 text-center text-muted">{{ t("newRun.noRepos") }}</p>
    <form v-else-if="loaded" class="space-y-5" @submit.prevent="start">
      <div>
        <span id="repo-label" class="mb-1 block text-sm text-muted">{{ t("newRun.repo") }}</span>
        <RepoPicker v-model="repo" :options="options" label-id="repo-label" />
        <p v-if="picked" class="mt-1 text-xs text-muted">{{ t("newRun.willClone", { repo: picked.repo }) }}</p>
        <p v-if="picked && !picked.can_push" class="tone-warning mt-1 text-xs" style="color: var(--tone)">{{ t("newRun.noPush", { repo: picked.repo }) }}</p>
        <p v-if="githubError" class="mt-1 text-xs text-muted">{{ t("newRun.githubUnavailable", { error: githubError }) }}</p>
      </div>
      <div>
        <label for="prompt" class="mb-1 block text-sm text-muted">{{ t("newRun.prompt") }}</label>
        <textarea id="prompt" v-model="prompt" rows="6" :placeholder="t('newRun.placeholder')" class="w-full rounded-lg border border-line bg-surface px-3 py-2 text-base focus:border-accent focus:outline-none" />
      </div>
      <div>
        <span class="mb-1 block text-sm text-muted">{{ t("newRun.files.label") }}</span>
        <div
          class="rounded-lg border border-dashed p-3 transition-colors"
          :class="dragging ? 'border-accent bg-surface-2' : 'border-line'"
          @dragover.prevent="dragging = true"
          @dragleave="dragging = false"
          @drop.prevent="onDrop"
        >
          <ul v-if="attachments.length" class="mb-2 space-y-1.5" :aria-label="t('newRun.files.list')">
            <li v-for="a in attachments" :key="a.name" class="flex min-h-11 items-center gap-2 rounded-md bg-surface-2 py-1 pr-1 pl-2.5">
              <FileText :size="16" class="shrink-0 text-accent" aria-hidden="true" />
              <span class="min-w-0 flex-1 truncate text-sm">{{ a.name }}</span>
              <span class="shrink-0 font-mono text-xs text-muted">{{ kb(a.bytes) }}</span>
              <button type="button" class="grid size-9 shrink-0 place-items-center rounded-md text-muted hover:text-fg" :aria-label="t('newRun.files.remove', { name: a.name })" @click="remove(a.name)">
                <X :size="16" aria-hidden="true" />
              </button>
            </li>
          </ul>
          <button type="button" class="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-md text-sm font-medium text-accent hover:bg-surface-2" @click="fileInput?.click()">
            <Paperclip :size="16" aria-hidden="true" />{{ attachments.length ? t("newRun.files.addMore") : t("newRun.files.add") }}
          </button>
          <input ref="fileInput" type="file" multiple :accept="TEXT_TYPES" class="sr-only" tabindex="-1" aria-hidden="true" @change="addFiles(($event.target as HTMLInputElement).files)" />
          <p class="mt-1 text-center text-xs text-muted">
            {{ attachments.length ? t("newRun.files.used", { used: kb(totalBytes), max: kb(ATTACHMENT_LIMITS.totalBytes) }) : t("newRun.files.hint", { files: ATTACHMENT_LIMITS.files, max: kb(ATTACHMENT_LIMITS.fileBytes) }) }}
          </p>
        </div>
        <p v-for="msg in attachErrors" :key="msg" class="tone-danger mt-1 text-xs" style="color: var(--tone)" role="alert">{{ msg }}</p>
      </div>
      <fieldset v-if="!isDevice" class="space-y-2">
        <legend class="mb-1 text-sm font-medium">{{ t("newRun.mode") }}</legend>
        <label v-for="m in (['task', 'team', 'compete'] as const)" :key="m" class="flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border px-3 py-2" :class="mode === m ? 'border-accent' : 'border-line'">
          <input v-model="mode" type="radio" name="mode" :value="m" class="mt-1 size-4 shrink-0" />
          <span>
            <span class="block text-sm font-medium">{{ t(`newRun.modes.${m}`) }}</span>
            <span class="block text-xs text-muted">{{ t(`newRun.modes.${m}Hint`) }}</span>
          </span>
        </label>
        <div v-if="mode === 'compete'" class="flex flex-wrap gap-3 rounded-lg border border-line px-3 py-2">
          <label class="flex flex-col gap-1 text-sm">
            <span class="font-medium">{{ t("newRun.competitors") }}</span>
            <input v-model.number="competitors" type="number" min="2" max="5" step="1" class="min-h-11 w-24 rounded-md border border-line bg-bg px-3" />
          </label>
          <label class="flex flex-col gap-1 text-sm">
            <span class="font-medium">{{ t("newRun.budget") }}</span>
            <input v-model.number="budget" type="number" min="0.01" step="0.5" required :placeholder="t('newRun.budgetPlaceholder')" class="min-h-11 w-32 rounded-md border border-line bg-bg px-3" />
          </label>
          <p class="w-full text-xs text-muted">{{ t("newRun.budgetHint", { n: competitors }) }}</p>
        </div>
      </fieldset>
      <p class="text-xs text-muted">{{ flow === "compete" ? t("newRun.noteCompete") : t("newRun.note", { flow }) }}</p>
      <button type="submit" :disabled="busy || !prompt.trim() || !repo || !competeReady" class="inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-lg bg-accent px-4 font-semibold text-bg disabled:opacity-60">
        <Play :size="18" aria-hidden="true" />{{ cloning ? t("newRun.cloning", { repo: cloning }) : t("newRun.start") }}
      </button>
    </form>
    <p v-if="error" class="tone-danger mt-3 text-sm" style="color: var(--tone)" role="alert">{{ error }}</p>
  </section>
</template>
