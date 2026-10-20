<script setup lang="ts">
import type { ProjectFileEntry, ProjectView, ProposalView } from "@navarch/contracts";
import { FileText, Folder, FolderGit2, Mic, MicOff, Paperclip, Plus, SendHorizontal, X } from "@lucide/vue";
import { nextTick, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { ApiError, api } from "../api/client.ts";
import { composeMessage, fits, folderListing, isText, mentionAt, MESSAGE_MAX, splitMention, type ChatFile } from "../lib/chat.ts";

/**
 * Chat with the concierge from the phone (ADR 0063). Text, dictation by the browser and text files,
 * which go inside the message. Actions are proposals; the phone confirms them as itself, within what a
 * paired device may do. Everything the model or a file says is shown as plain text.
 */
const { t, locale } = useI18n();

type Line = { role: "user" | "assistant" | "error"; text: string; proposals?: ProposalView[] };
const lines = ref<Line[]>([]);
const draft = ref("");
const files = ref<ChatFile[]>([]);
const notes = ref<string[]>([]);
const busy = ref(false);
const scroller = ref<HTMLElement | null>(null);
let conversation: string | undefined;

async function scroll() {
  await nextTick();
  scroller.value?.scrollTo({ top: scroller.value.scrollHeight });
}

/** The daemon forgets conversations on restart; a 404 opens a fresh one and tries again once. */
async function withConversation<T>(run: (id: string) => Promise<T>): Promise<T> {
  conversation ??= (await api.conciergeOpen()).id;
  try {
    return await run(conversation);
  } catch (err) {
    if (!(err instanceof ApiError) || err.status !== 404) throw err;
    conversation = (await api.conciergeOpen()).id;
    return run(conversation);
  }
}

async function send() {
  const text = draft.value.trim();
  if (busy.value || (!text && !files.value.length)) return;
  if (!fits(text, files.value)) {
    notes.value = [t("chat.attachTooBig", { name: files.value.at(-1)?.name ?? "", max: MESSAGE_MAX })];
    return;
  }
  const message = composeMessage(text, files.value);
  lines.value.push({ role: "user", text: files.value.length ? `${text}\n${files.value.map((f) => `📎 ${f.name}`).join("\n")}`.trim() : text });
  draft.value = "";
  files.value = [];
  notes.value = [];
  busy.value = true;
  void scroll();
  try {
    const turn = await withConversation((id) => api.conciergeSend(id, message));
    lines.value.push({ role: "assistant", text: turn.reply, proposals: turn.proposals });
  } catch (err) {
    lines.value.push({ role: "error", text: t("chat.error", { message: (err as Error).message }) });
  } finally {
    busy.value = false;
    void scroll();
  }
}

async function decide(proposal: ProposalView, decision: "approve" | "reject") {
  busy.value = true;
  try {
    const done = await withConversation((id) => api.conciergeDecide(id, proposal.id, decision));
    proposal.status = done.proposal.status;
    lines.value.push({ role: "assistant", text: done.reply });
  } catch (err) {
    lines.value.push({ role: "error", text: t("chat.error", { message: (err as Error).message }) });
  } finally {
    busy.value = false;
    void scroll();
  }
}

async function pick(event: Event) {
  const input = event.target as HTMLInputElement;
  notes.value = [];
  for (const file of Array.from(input.files ?? [])) {
    const content = await file.text();
    if (!isText(content)) {
      notes.value.push(t("chat.attachNotText", { name: file.name }));
      continue;
    }
    const next = [...files.value.filter((f) => f.name !== file.name), { name: file.name, content }];
    if (!fits(draft.value, next)) {
      notes.value.push(t("chat.attachTooBig", { name: file.name, max: MESSAGE_MAX }));
      continue;
    }
    files.value = next;
  }
  input.value = "";
}

// `@` mentions (ADR 0073): files and folders of the registered projects, read by the daemon from git's own
// file list, so ignored files and secrets never show up. A picked file joins the message like an attachment.
type Suggestion = { key: string; kind: "project" | "dir" | "file" | "folder"; label: string; hint?: string; project?: ProjectView; path?: string };
const suggestions = ref<Suggestion[]>([]);
let projects: ProjectView[] | undefined;
let lookup = 0;
watch(draft, async (text) => {
  const mention = mentionAt(text);
  const mine = ++lookup;
  if (!mention) {
    suggestions.value = [];
    return;
  }
  try {
    projects ??= await api.projects();
    const parts = splitMention(mention.token);
    let next: Suggestion[];
    if ("projectQuery" in parts) {
      const q = parts.projectQuery.toLowerCase();
      next = projects.filter((p) => p.name.toLowerCase().includes(q)).slice(0, 8).map((p) => ({ key: p.id, kind: "project" as const, label: p.name, hint: p.repo, project: p }));
    } else {
      const project = projects.find((p) => p.name === parts.project);
      if (!project) return void (suggestions.value = []);
      const { entries } = await api.projectFiles(project.id, { prefix: parts.dir, q: parts.query, limit: 12 });
      next = entries.map((e: ProjectFileEntry) => ({ key: e.path, kind: e.kind, label: e.path.slice(parts.dir.length), project, path: e.path }));
      if (parts.dir && !parts.query) next.unshift({ key: `folder:${parts.dir}`, kind: "folder", label: t("chat.mentionFolder", { dir: parts.dir }), project, path: parts.dir });
    }
    if (mine === lookup) suggestions.value = next;
  } catch {
    if (mine === lookup) suggestions.value = [];
  }
});

async function choose(s: Suggestion) {
  const mention = mentionAt(draft.value);
  if (!mention) return;
  const head = draft.value.slice(0, mention.start);
  if (s.kind === "project") {
    draft.value = `${head}@${s.project!.name}/`;
    return;
  }
  if (s.kind === "dir") {
    draft.value = `${head}@${s.project!.name}/${s.path}`;
    return;
  }
  draft.value = head;
  suggestions.value = [];
  try {
    const name = `${s.project!.name}/${s.path}`;
    let content: string;
    if (s.kind === "folder") {
      const { entries, truncated } = await api.projectFiles(s.project!.id, { prefix: s.path!, kind: "file", limit: 200 });
      content = folderListing(entries.map((e) => e.path), truncated);
    } else {
      content = (await api.projectFile(s.project!.id, s.path!)).content;
    }
    const next = [...files.value.filter((f) => f.name !== name), { name: s.kind === "folder" ? `${name} (files)` : name, content }];
    if (!fits(draft.value, next)) {
      notes.value = [t("chat.attachTooBig", { name, max: MESSAGE_MAX })];
      return;
    }
    notes.value = [];
    files.value = next;
  } catch (err) {
    notes.value = [(err as Error).message];
  }
}

function newChat() {
  conversation = undefined;
  lines.value = [];
  files.value = [];
  notes.value = [];
}

// Dictation is the browser's own (SpeechRecognition): nothing is uploaded by Navarch.
type Recognition = { lang: string; interimResults: boolean; continuous: boolean; onresult: ((e: any) => void) | null; onend: (() => void) | null; onerror: (() => void) | null; start(): void; stop(): void };
const Speech = (window as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition }).SpeechRecognition ??
  (window as unknown as { webkitSpeechRecognition?: new () => Recognition }).webkitSpeechRecognition;
const listening = ref(false);
let recognition: Recognition | undefined;

function dictate() {
  if (!Speech) {
    notes.value = [t("chat.dictateUnsupported")];
    return;
  }
  if (listening.value) return recognition?.stop();
  const base = draft.value ? `${draft.value.trimEnd()} ` : "";
  recognition = new Speech();
  recognition.lang = locale.value;
  recognition.interimResults = true;
  recognition.continuous = false;
  recognition.onresult = (e) => {
    draft.value = base + Array.from(e.results as ArrayLike<{ 0: { transcript: string } }>).map((r) => r[0].transcript).join("");
  };
  recognition.onend = () => (listening.value = false);
  recognition.onerror = () => (listening.value = false);
  listening.value = true;
  recognition.start();
}
onBeforeUnmount(() => recognition?.stop());
</script>

<template>
  <section class="mx-auto flex h-full min-h-0 max-w-2xl flex-col p-6 max-md:p-4">
    <header class="flex items-center gap-3">
      <h1 class="text-xl font-semibold">{{ t("chat.title") }}</h1>
      <RouterLink to="/session" class="ml-auto inline-flex min-h-11 items-center gap-2 rounded-md border border-line px-3 text-sm hover:bg-surface-2">{{ t("chat.sessionLink") }}</RouterLink>
      <button type="button" class="inline-flex min-h-11 items-center gap-2 rounded-md border border-line px-3 text-sm hover:bg-surface-2" @click="newChat">
        <Plus :size="16" aria-hidden="true" />{{ t("chat.newChat") }}
      </button>
    </header>
    <p class="mt-1 text-sm text-muted">{{ t("chat.intro") }}</p>

    <div ref="scroller" class="mt-4 min-h-0 flex-1 space-y-3 overflow-auto" role="log" aria-live="polite">
      <p v-if="!lines.length" class="text-sm text-muted">{{ t("chat.empty") }}</p>
      <div v-for="(line, i) in lines" :key="i" :class="line.role === 'user' ? 'ml-8' : 'mr-8'">
        <p class="mb-0.5 text-xs text-muted">{{ line.role === "user" ? t("chat.you") : t("chat.assistant") }}</p>
        <p
          class="whitespace-pre-wrap break-words rounded-lg border p-3 text-sm"
          :class="line.role === 'user' ? 'border-line bg-surface-2' : line.role === 'error' ? 'tone-danger' : 'border-line bg-surface'"
          :style="line.role === 'error' ? 'border-color: var(--tone); color: var(--tone)' : ''"
        >{{ line.text }}</p>
        <div v-for="p in line.proposals ?? []" :key="p.id" class="mt-2 rounded-lg border border-line bg-surface p-3 text-sm">
          <p class="whitespace-pre-wrap break-words font-medium">{{ p.summary }}</p>
          <div v-if="p.status === 'pending'" class="mt-2">
            <p class="text-xs text-muted">{{ t("chat.confirmNote") }}</p>
            <div class="mt-2 flex gap-2">
              <button type="button" :disabled="busy" class="min-h-11 flex-1 rounded-md bg-accent px-4 font-medium text-bg disabled:opacity-50" @click="decide(p, 'approve')">{{ t("chat.approve") }}</button>
              <button type="button" :disabled="busy" class="min-h-11 flex-1 rounded-md border border-line px-4 font-medium hover:bg-surface-2 disabled:opacity-50" @click="decide(p, 'reject')">{{ t("chat.reject") }}</button>
            </div>
          </div>
          <p v-else class="mt-1 text-xs text-muted">{{ t(`chat.${p.status}`) }}</p>
        </div>
      </div>
      <p v-if="busy" class="text-sm text-muted" role="status">{{ t("chat.thinking") }}…</p>
    </div>

    <ul v-if="notes.length" class="mt-2 space-y-1 text-sm tone-warning" style="color: var(--tone)" role="alert">
      <li v-for="n in notes" :key="n">{{ n }}</li>
    </ul>
    <ul v-if="files.length" class="mt-2 flex flex-wrap gap-2">
      <li v-for="f in files" :key="f.name" class="inline-flex min-h-9 items-center gap-1 rounded-full border border-line bg-surface px-3 text-sm">
        <Paperclip :size="14" aria-hidden="true" />{{ f.name }}
        <button type="button" class="grid size-9 place-items-center" :aria-label="t('chat.attachRemove', { name: f.name })" @click="files = files.filter((x) => x !== f)"><X :size="14" aria-hidden="true" /></button>
      </li>
    </ul>

    <ul v-if="suggestions.length" class="mt-2 max-h-56 overflow-auto rounded-lg border border-line bg-surface" role="listbox" :aria-label="t('chat.mentionList')">
      <li v-for="s in suggestions" :key="s.key" role="option">
        <button type="button" class="flex min-h-11 w-full items-center gap-2 px-3 text-left text-sm hover:bg-surface-2" @click="choose(s)">
          <component :is="s.kind === 'project' ? FolderGit2 : s.kind === 'file' ? FileText : Folder" :size="16" class="shrink-0 text-muted" aria-hidden="true" />
          <span class="min-w-0 flex-1 truncate">{{ s.label }}</span>
          <span v-if="s.hint" class="truncate text-xs text-muted">{{ s.hint }}</span>
        </button>
      </li>
    </ul>

    <form class="mt-3 flex items-end gap-2" @submit.prevent="send">
      <label class="grid size-11 shrink-0 cursor-pointer place-items-center rounded-md border border-line hover:bg-surface-2 focus-within:outline-2 focus-within:outline-accent" :title="t('chat.attach')">
        <Paperclip :size="18" aria-hidden="true" />
        <span class="sr-only">{{ t("chat.attach") }}</span>
        <input type="file" multiple accept=".md,.markdown,.txt,text/*" class="sr-only" @change="pick" />
      </label>
      <textarea
        v-model="draft"
        rows="2"
        :maxlength="MESSAGE_MAX"
        :placeholder="t('chat.placeholder')"
        :aria-label="t('chat.placeholder')"
        class="min-h-11 min-w-0 flex-1 resize-none rounded-md border border-line bg-surface px-3 py-2 text-sm outline-none focus:outline-2 focus:outline-accent"
        @keydown.enter.exact.prevent="send"
      />
      <button type="button" class="grid size-11 shrink-0 place-items-center rounded-md border border-line hover:bg-surface-2" :class="listening ? 'tone-danger' : ''" :style="listening ? 'color: var(--tone)' : ''" :aria-pressed="listening" :aria-label="listening ? t('chat.dictateStop') : t('chat.dictate')" @click="dictate">
        <component :is="listening ? MicOff : Mic" :size="18" aria-hidden="true" />
      </button>
      <button type="submit" :disabled="busy || (!draft.trim() && !files.length)" class="grid size-11 shrink-0 place-items-center rounded-md bg-accent text-bg disabled:opacity-50" :aria-label="t('chat.send')">
        <SendHorizontal :size="18" aria-hidden="true" />
      </button>
    </form>
    <p class="mt-1 text-xs text-muted">{{ t("chat.mentionHint", { at: "@" }) }}</p>
  </section>
</template>
