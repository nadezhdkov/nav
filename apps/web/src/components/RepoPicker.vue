<script setup lang="ts">
import { Check, ChevronsUpDown, CloudDownload, FolderGit2, History, Lock, Search, X } from "@lucide/vue";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { groupOptions, type RepoOption } from "../lib/repos.ts";

/**
 * The repository a new run starts in: a button showing the choice by name, opening a searchable
 * list grouped by kind. On phones the list is a bottom sheet with large rows; on the desktop a
 * dropdown. Arrow keys move, Enter picks, Esc closes (WAI-ARIA listbox).
 */
const props = defineProps<{ options: RepoOption[]; modelValue: string; labelId: string }>();
const emit = defineEmits<{ "update:modelValue": [value: string] }>();
const { t } = useI18n();

const open = ref(false);
const query = ref("");
const active = ref(0);
const root = ref<HTMLElement | null>(null);
const search = ref<HTMLInputElement | null>(null);
const list = ref<HTMLElement | null>(null);
const phone = ref(false);
let media: MediaQueryList | undefined;
const onMedia = () => (phone.value = Boolean(media?.matches));

const selected = computed(() => props.options.find((o) => o.value === props.modelValue));
const groups = computed(() => groupOptions(props.options, query.value));
const flat = computed(() => groups.value.flatMap((g) => g.options));
const optionId = (i: number) => `${props.labelId}-option-${i}`;
const indexOf = (o: RepoOption) => flat.value.indexOf(o);
const groupLabel = (g: { group: RepoOption["group"]; owner?: string }) =>
  g.group === "github" ? t("newRun.github", { owner: g.owner }) : t(`newRun.groups.${g.group}`);
const icon = (o: RepoOption) => (o.group === "github" ? CloudDownload : o.group === "earlier" ? History : FolderGit2);

async function show() {
  open.value = true;
  query.value = "";
  active.value = Math.max(0, flat.value.findIndex((o) => o.value === props.modelValue));
  await nextTick();
  (props.options.length > 6 ? search.value : list.value)?.focus();
  scrollActive();
}

function close(refocus = true) {
  open.value = false;
  if (refocus) root.value?.querySelector<HTMLButtonElement>("button[aria-haspopup]")?.focus();
}

function pick(o: RepoOption) {
  emit("update:modelValue", o.value);
  close();
}

function scrollActive() {
  void nextTick(() => document.getElementById(optionId(active.value))?.scrollIntoView({ block: "nearest" }));
}

function onKey(e: KeyboardEvent) {
  const last = flat.value.length - 1;
  if (e.key === "ArrowDown") active.value = Math.min(last, active.value + 1);
  else if (e.key === "ArrowUp") active.value = Math.max(0, active.value - 1);
  else if (e.key === "Home" && e.target === list.value) active.value = 0;
  else if (e.key === "End" && e.target === list.value) active.value = last;
  else if (e.key === "Enter") {
    const o = flat.value[active.value];
    if (o) pick(o);
  } else if (e.key === "Escape") close();
  else return;
  e.preventDefault();
  scrollActive();
}

watch(query, () => (active.value = 0));

function onOutside(e: PointerEvent) {
  if (open.value && !phone.value && root.value && !root.value.contains(e.target as Node)) close(false);
}

onMounted(() => {
  media = window.matchMedia?.("(max-width: 767px)");
  onMedia();
  media?.addEventListener("change", onMedia);
  document.addEventListener("pointerdown", onOutside);
});
onBeforeUnmount(() => {
  media?.removeEventListener("change", onMedia);
  document.removeEventListener("pointerdown", onOutside);
});
</script>

<template>
  <div ref="root" class="relative">
    <button
      type="button"
      aria-haspopup="listbox"
      :aria-expanded="open"
      :aria-labelledby="labelId"
      class="flex min-h-14 w-full items-center gap-3 rounded-lg border border-line bg-surface px-3 py-2 text-left transition-colors hover:border-[var(--edge)] focus-visible:outline-2 focus-visible:outline-accent"
      @click="open ? close() : show()"
    >
      <span class="grid size-9 shrink-0 place-items-center rounded-md bg-surface-2 text-accent">
        <component :is="selected ? icon(selected) : FolderGit2" :size="18" aria-hidden="true" />
      </span>
      <span class="min-w-0 flex-1">
        <span class="block truncate font-medium">{{ selected?.title ?? t("newRun.choose") }}</span>
        <span v-if="selected" class="block truncate text-xs text-muted">{{ selected.subtitle }}</span>
      </span>
      <ChevronsUpDown :size="16" class="shrink-0 text-muted" aria-hidden="true" />
    </button>

    <div v-if="open && phone" class="fixed inset-0 z-40 bg-black/50" aria-hidden="true" @click="close()" />
    <div
      v-if="open"
      :class="
        phone
          ? 'fixed inset-x-0 bottom-0 z-50 flex max-h-[80vh] flex-col rounded-t-2xl border-t border-line bg-surface pb-[env(safe-area-inset-bottom)] shadow-2xl'
          : 'absolute inset-x-0 top-full z-30 mt-1 flex max-h-96 flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-2xl'
      "
    >
      <div v-if="phone" class="flex items-center justify-between px-4 pt-3 pb-1">
        <span class="mx-auto mb-2 h-1 w-10 rounded-full bg-[var(--edge)]" aria-hidden="true" />
      </div>
      <div v-if="phone" class="flex items-center justify-between px-4 pb-2">
        <span class="font-semibold">{{ t("newRun.choose") }}</span>
        <button type="button" class="grid size-11 place-items-center rounded-md text-muted" :aria-label="t('newRun.close')" @click="close()">
          <X :size="20" aria-hidden="true" />
        </button>
      </div>
      <label v-if="options.length > 6" class="mx-3 mt-3 mb-1 flex min-h-11 items-center gap-2 rounded-md border border-line bg-bg px-3 focus-within:border-accent max-md:mt-0">
        <Search :size="16" class="text-muted" aria-hidden="true" />
        <input
          ref="search"
          v-model="query"
          type="search"
          :placeholder="t('newRun.search')"
          :aria-label="t('newRun.search')"
          :aria-controls="`${labelId}-list`"
          :aria-activedescendant="flat.length ? optionId(active) : undefined"
          class="min-w-0 flex-1 bg-transparent text-base outline-none focus-visible:outline-none md:text-sm"
          @keydown="onKey"
        />
      </label>
      <ul
        :id="`${labelId}-list`"
        ref="list"
        role="listbox"
        tabindex="-1"
        :aria-labelledby="labelId"
        :aria-activedescendant="flat.length ? optionId(active) : undefined"
        class="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2 outline-none"
        @keydown="onKey"
      >
        <template v-for="g in groups" :key="g.key">
          <li role="presentation" class="px-2 pt-2 pb-1 text-[11px] font-semibold tracking-wide text-muted uppercase">{{ groupLabel(g) }}</li>
          <li
            v-for="o in g.options"
            :id="optionId(indexOf(o))"
            :key="o.value"
            role="option"
            :aria-selected="o.value === modelValue"
            class="flex min-h-14 cursor-pointer items-center gap-3 rounded-lg px-2 py-2"
            :class="indexOf(o) === active ? 'bg-surface-2' : ''"
            @click="pick(o)"
            @pointermove="active = indexOf(o)"
          >
            <span class="grid size-9 shrink-0 place-items-center rounded-md bg-bg" :class="o.value === modelValue ? 'text-accent' : 'text-muted'">
              <component :is="icon(o)" :size="18" aria-hidden="true" />
            </span>
            <span class="min-w-0 flex-1">
              <span class="flex items-center gap-1.5">
                <span class="truncate font-medium">{{ o.title }}</span>
                <span v-if="o.private" class="inline-flex items-center gap-0.5 rounded border border-line px-1 text-[10px] text-muted">
                  <Lock :size="10" aria-hidden="true" />{{ t("newRun.private") }}
                </span>
                <span v-if="o.canPush === false" class="tone-warning rounded border px-1 text-[10px]" style="color: var(--tone); border-color: var(--tone)">{{ t("newRun.readOnly") }}</span>
              </span>
              <span class="block truncate text-xs text-muted">{{ o.subtitle }}</span>
            </span>
            <Check v-if="o.value === modelValue" :size="18" class="shrink-0 text-accent" :aria-label="t('newRun.selected')" />
          </li>
        </template>
        <li v-if="!flat.length" role="presentation" class="px-3 py-6 text-center text-sm text-muted">{{ t("newRun.noMatch") }}</li>
      </ul>
    </div>
  </div>
</template>
