<script setup lang="ts">
import type { ProjectView, ProjectFileEntry, SessionDetail, SessionItem, SessionsListing, SessionView } from "@navarch/contracts";
import { Check, FileText, Folder, ImagePlus, Play, SendHorizontal, Square, X } from "@lucide/vue";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { api } from "../api/client.ts";
import { mentionAt } from "../lib/chat.ts";
import { prepareImage, type SessionImage } from "../lib/session.ts";

/**
 * A live conversation with Claude Code in one of the registered projects (ADR 0074). The daemon holds the
 * agent's process; this page polls the transcript, shows the answer as it is written, and asks the user
 * about every permission the agent needs. Everything the agent or the files say is shown as plain text.
 */
const { t } = useI18n();
const listing = ref<SessionsListing | null>(null);
const projects = ref<ProjectView[]>([]);
const error = ref<string | null>(null);
const projectId = ref("");
const mode = ref<"default" | "acceptEdits">("default");
const opening = ref(false);

const session = ref<SessionDetail | null>(null);
const items = ref<SessionItem[]>([]);
const draft = ref("");
const images = ref<SessionImage[]>([]);
const sending = ref(false);
const scroller = ref<HTMLElement | null>(null);
let timer: ReturnType<typeof setTimeout> | undefined;
let alive = true;

const open = computed(() => session.value && session.value.status !== "closed");
const earlier = computed(() => (listing.value?.sessions ?? []).filter((s) => s.status === "closed" && s.claude_session_id).slice(0, 5));

async function load() {
  try {
    [listing.value, projects.value] = await Promise.all([api.sessions(), api.projects()]);
    projectId.value ||= projects.value[0]?.id ?? "";
    const running = listing.value.sessions.find((s) => s.status !== "closed");
    if (running && !session.value) await attach(running.id);
  } catch (err) {
    error.value = (err as Error).message;
  }
}

async function attach(id: string) {
  items.value = [];
  session.value = await api.session(id, 0);
  items.value = session.value.items;
  poll();
}

function poll() {
  clearTimeout(timer);
  if (!alive || !session.value) return;
  timer = setTimeout(async () => {
    try {
      const after = items.value.at(-1)?.seq ?? 0;
      const next = await api.session(session.value!.id, after);
      // Permission answers change an old item, so those are refreshed by seq.
      const known = new Map(items.value.map((i) => [i.seq, i]));
      for (const i of next.items) known.set(i.seq, i);
      const merged = [...known.values()].sort((a, b) => a.seq - b.seq);
      const grew = merged.length !== items.value.length || next.live !== session.value!.live;
      items.value = merged;
      session.value = next;
      if (grew) void scroll();
    } catch (err) {
      error.value = (err as Error).message;
    }
    if (session.value?.status !== "closed") poll();
  }, session.value.status === "idle" ? 1500 : 700);
}

async function scroll() {
  await nextTick();
  scroller.value?.scrollTo({ top: scroller.value.scrollHeight });
}

async function start(resume?: SessionView) {
  if (!projectId.value && !resume) return;
  opening.value = true;
  error.value = null;
  try {
    const opened = await api.openSession({ project_id: resume?.project_id ?? projectId.value, permission_mode: mode.value, ...(resume ? { resume: resume.id } : {}) });
    await attach(opened.id);
    listing.value = await api.sessions();
  } catch (err) {
    error.value = (err as Error).message;
  } finally {
    opening.value = false;
  }
}

async function send() {
  const text = draft.value.trim();
  if (!session.value || !open.value || sending.value || !text) return;
  sending.value = true;
  error.value = null;
  try {
    session.value = await api.sessionSend(session.value.id, { text, images: images.value.map(({ media_type, data }) => ({ media_type, data })) });
    items.value = [...items.value.filter((i) => !session.value!.items.some((n) => n.seq === i.seq)), ...session.value.items];
    draft.value = "";
    images.value = [];
    suggestions.value = [];
    void scroll();
    poll();
  } catch (err) {
    error.value = (err as Error).message;
  } finally {
    sending.value = false;
  }
}

async function answer(item: SessionItem, decision: "allow" | "deny") {
  if (!session.value || !item.request_id) return;
  try {
    session.value = await api.sessionAnswer(session.value.id, item.request_id, decision);
    const mine = items.value.find((i) => i.seq === item.seq);
    if (mine) mine.status = decision === "allow" ? "allowed" : "denied";
    poll();
  } catch (err) {
    error.value = (err as Error).message;
  }
}

async function close() {
  if (!session.value) return;
  session.value = await api.sessionClose(session.value.id);
  listing.value = await api.sessions();
}

function leave() {
  session.value = null;
  items.value = [];
  clearTimeout(timer);
  void load();
}

async function pickImages(event: Event) {
  const input = event.target as HTMLInputElement;
  error.value = null;
  for (const file of Array.from(input.files ?? [])) {
    if (images.value.length >= 3) break;
    try {
      images.value = [...images.value, await prepareImage(file)];
    } catch {
      error.value = t("session.imageFailed", { name: file.name });
    }
  }
  input.value = "";
}

// `@path` in the message is Claude Code's own mention syntax: it reads the file from the project folder.
type Suggestion = { path: string; kind: "file" | "dir" };
const suggestions = ref<Suggestion[]>([]);
let lookup = 0;
watch(draft, async (text) => {
  const mention = mentionAt(text);
  const mine = ++lookup;
  if (!mention || !session.value || !open.value) return void (suggestions.value = []);
  const slash = mention.token.lastIndexOf("/") + 1;
  try {
    const { entries } = await api.projectFiles(session.value.project_id, { prefix: mention.token.slice(0, slash), q: mention.token.slice(slash), limit: 10 });
    if (mine === lookup) suggestions.value = entries.map((e: ProjectFileEntry) => ({ path: e.path, kind: e.kind }));
  } catch {
    if (mine === lookup) suggestions.value = [];
  }
});
function choose(s: Suggestion) {
  const mention = mentionAt(draft.value);
  if (!mention) return;
  draft.value = `${draft.value.slice(0, mention.start)}@${s.path}${s.kind === "file" ? " " : ""}`;
}

onMounted(load);
onBeforeUnmount(() => {
  alive = false;
  clearTimeout(timer);
});
</script>

<template>
  <section class="mx-auto flex h-full min-h-0 max-w-2xl flex-col p-6 max-md:p-4">
    <header class="flex items-center gap-3">
      <h1 class="text-xl font-semibold">{{ t("session.title") }}</h1>
      <span v-if="session" class="rounded-full border border-line px-2 py-0.5 text-xs" :class="session.status === 'waiting' ? 'tone-warning' : ''" :style="session.status === 'waiting' ? 'color: var(--tone)' : ''">{{ t(`session.status.${session.status}`) }}</span>
      <button v-if="open" type="button" class="ml-auto inline-flex min-h-11 items-center gap-2 rounded-md border border-line px-3 text-sm hover:bg-surface-2" @click="close"><Square :size="14" aria-hidden="true" />{{ t("session.close") }}</button>
      <button v-else-if="session" type="button" class="ml-auto inline-flex min-h-11 items-center gap-2 rounded-md border border-line px-3 text-sm hover:bg-surface-2" @click="leave">{{ t("session.back") }}</button>
    </header>

    <p v-if="error" class="mt-2 text-sm tone-danger" style="color: var(--tone)" role="alert">{{ error }}</p>
    <p v-if="listing && !listing.enabled" class="mt-4 rounded-lg border border-dashed border-line p-4 text-sm text-muted">{{ t("session.disabled") }}</p>

    <template v-else-if="listing && !session">
      <p class="mt-1 text-sm text-muted">{{ t("session.intro") }}</p>
      <p v-if="!projects.length" class="mt-4 text-sm text-muted">{{ t("session.noProjects") }}</p>
      <form v-else class="mt-4 space-y-4" @submit.prevent="start()">
        <div>
          <label for="session-project" class="mb-1 block text-sm text-muted">{{ t("session.project") }}</label>
          <select id="session-project" v-model="projectId" class="min-h-11 w-full rounded-lg border border-line bg-surface px-3 text-base">
            <option v-for="p in projects" :key="p.id" :value="p.id">{{ p.name }} · {{ p.repo }}</option>
          </select>
        </div>
        <fieldset class="space-y-2">
          <legend class="mb-1 text-sm text-muted">{{ t("session.mode") }}</legend>
          <label class="flex min-h-11 items-start gap-2 rounded-lg border border-line p-3 text-sm"><input v-model="mode" type="radio" value="default" class="mt-1" /><span><b>{{ t("session.modeAsk") }}</b><br /><span class="text-muted">{{ t("session.modeAskHint") }}</span></span></label>
          <label class="flex min-h-11 items-start gap-2 rounded-lg border border-line p-3 text-sm"><input v-model="mode" type="radio" value="acceptEdits" class="mt-1" /><span><b>{{ t("session.modeEdits") }}</b><br /><span class="text-muted">{{ t("session.modeEditsHint") }}</span></span></label>
        </fieldset>
        <button type="submit" :disabled="opening" class="inline-flex min-h-11 items-center gap-2 rounded-lg bg-accent px-4 font-medium text-bg disabled:opacity-50"><Play :size="16" aria-hidden="true" />{{ opening ? t("session.opening") : t("session.open") }}</button>
      </form>
      <div v-if="earlier.length" class="mt-6">
        <h2 class="mb-2 text-sm text-muted">{{ t("session.earlier") }}</h2>
        <ul class="space-y-2">
          <li v-for="s in earlier" :key="s.id" class="flex items-center gap-2 rounded-lg border border-line p-3 text-sm">
            <span class="min-w-0 flex-1 truncate">{{ s.project_name }} · {{ new Date(s.opened_at).toLocaleString() }}</span>
            <button type="button" class="min-h-11 rounded-md border border-line px-3 hover:bg-surface-2" :disabled="opening" @click="start(s)">{{ t("session.resume") }}</button>
          </li>
        </ul>
      </div>
    </template>

    <template v-else-if="session">
      <p class="mt-1 truncate text-xs text-muted">{{ session.project_name }} · {{ session.path }}</p>
      <div ref="scroller" class="mt-3 min-h-0 flex-1 space-y-2 overflow-auto" role="log" aria-live="polite">
        <template v-for="item in items" :key="item.seq">
          <p v-if="item.kind === 'user'" class="ml-8 whitespace-pre-wrap break-words rounded-lg border border-line bg-surface-2 p-3 text-sm">{{ item.text }}</p>
          <p v-else-if="item.kind === 'assistant'" class="mr-8 whitespace-pre-wrap break-words rounded-lg border border-line bg-surface p-3 text-sm">{{ item.text }}</p>
          <p v-else-if="item.kind === 'tool'" class="mr-8 truncate text-xs text-muted"><FileText :size="12" class="mr-1 inline" aria-hidden="true" />{{ item.text }}</p>
          <p v-else-if="item.kind === 'notice'" class="text-center text-xs text-muted">{{ item.text }}</p>
          <div v-else class="mr-8 rounded-lg border p-3 text-sm" :class="item.status === 'pending' ? 'tone-warning' : 'border-line'" :style="item.status === 'pending' ? 'border-color: var(--tone)' : ''">
            <p class="text-xs text-muted">{{ t("session.asks", { tool: item.tool ?? "" }) }}</p>
            <p class="mt-1 whitespace-pre-wrap break-words font-medium">{{ item.text }}</p>
            <div v-if="item.status === 'pending'" class="mt-2 flex gap-2">
              <button type="button" class="inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-md bg-accent px-4 font-medium text-bg" @click="answer(item, 'allow')"><Check :size="16" aria-hidden="true" />{{ t("session.allow") }}</button>
              <button type="button" class="inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-md border border-line px-4 font-medium hover:bg-surface-2" @click="answer(item, 'deny')"><X :size="16" aria-hidden="true" />{{ t("session.deny") }}</button>
            </div>
            <p v-else class="mt-1 text-xs text-muted">{{ t(`session.answer.${item.status}`) }}</p>
          </div>
        </template>
        <p v-if="session.live" class="mr-8 whitespace-pre-wrap break-words rounded-lg border border-line bg-surface p-3 text-sm opacity-80">{{ session.live }}</p>
        <p v-else-if="session.status === 'working'" class="text-sm text-muted" role="status">{{ t("session.working") }}…</p>
      </div>

      <ul v-if="suggestions.length" class="mt-2 max-h-48 overflow-auto rounded-lg border border-line bg-surface" role="listbox" :aria-label="t('session.files')">
        <li v-for="s in suggestions" :key="s.path" role="option">
          <button type="button" class="flex min-h-11 w-full items-center gap-2 px-3 text-left text-sm hover:bg-surface-2" @click="choose(s)">
            <component :is="s.kind === 'dir' ? Folder : FileText" :size="16" class="shrink-0 text-muted" aria-hidden="true" /><span class="truncate">{{ s.path }}</span>
          </button>
        </li>
      </ul>
      <ul v-if="images.length" class="mt-2 flex gap-2">
        <li v-for="(img, i) in images" :key="i" class="relative">
          <img :src="img.preview" alt="" class="size-14 rounded-md border border-line object-cover" />
          <button type="button" class="absolute -right-2 -top-2 grid size-6 place-items-center rounded-full border border-line bg-surface" :aria-label="t('session.removeImage')" @click="images = images.filter((_, j) => j !== i)"><X :size="12" aria-hidden="true" /></button>
        </li>
      </ul>
      <form v-if="open" class="mt-3 flex items-end gap-2" @submit.prevent="send">
        <label class="grid size-11 shrink-0 cursor-pointer place-items-center rounded-md border border-line hover:bg-surface-2 focus-within:outline-2 focus-within:outline-accent" :title="t('session.attachImage')">
          <ImagePlus :size="18" aria-hidden="true" /><span class="sr-only">{{ t("session.attachImage") }}</span>
          <input type="file" accept="image/*" multiple class="sr-only" @change="pickImages" />
        </label>
        <textarea v-model="draft" rows="2" :placeholder="t('session.placeholder')" :aria-label="t('session.placeholder')" class="min-h-11 min-w-0 flex-1 resize-none rounded-md border border-line bg-surface px-3 py-2 text-sm outline-none focus:outline-2 focus:outline-accent" @keydown.enter.exact.prevent="send" />
        <button type="submit" :disabled="sending || !draft.trim()" class="grid size-11 shrink-0 place-items-center rounded-md bg-accent text-bg disabled:opacity-50" :aria-label="t('session.send')"><SendHorizontal :size="18" aria-hidden="true" /></button>
      </form>
      <p v-if="open" class="mt-1 text-xs text-muted">{{ t("session.hint", { at: "@" }) }}</p>
    </template>
  </section>
</template>
