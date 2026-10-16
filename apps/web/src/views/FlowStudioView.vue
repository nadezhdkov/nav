<script setup lang="ts">
import type { FlowCatalogView, FlowDetail, FlowProblem, SimulationRequest, SimulationResult } from "@navarch/contracts";
import { AlertTriangle, ArrowLeft, CircleCheck, CircleX, Copy, FlaskConical, ListChecks, Loader, Save, Trash2, Upload } from "@lucide/vue";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { onBeforeRouteLeave, useRouter } from "vue-router";
import type { Document } from "yaml";
import { api, ApiError } from "../api/client.ts";
import { isDevice } from "../api/session.ts";
import StudioCanvas from "../components/StudioCanvas.vue";
import StudioLibrary from "../components/StudioLibrary.vue";
import StudioProperties from "../components/StudioProperties.vue";
import StudioPublish from "../components/StudioPublish.vue";
import StudioSimulate from "../components/StudioSimulate.vue";
import StudioYaml from "../components/StudioYaml.vue";
import { addNode, connect, duplicateYaml, edit, readDraft, removeNode, type DraftView, type NodeType } from "../lib/flowDoc.ts";
import { ago } from "../lib/status.ts";
import { findDraftNode } from "../lib/studioGraph.ts";

/**
 * Flow Studio (spec §6.2.3, ADR 0033): a canvas, a node library and a properties panel over the
 * Flow's YAML, which stays the source of truth; live validation and a dry run from the daemon;
 * Save draft and Publish. Built-in Flows and past versions open read-only.
 */
const props = defineProps<{ name: string }>();
const { t } = useI18n();
const router = useRouter();

const detail = ref<FlowDetail | null>(null);
const catalog = ref<FlowCatalogView | null>(null);
const text = ref("");
const savedText = ref("");
const revision = ref<number | null>(null);
/** A past published version opened read-only (`?v=N`). */
const viewing = ref<number | null>(null);
const loadError = ref<string | null>(null);
const conflict = ref(false);
const flash = ref<string | null>(null);
const busy = ref(false);

const MODE_KEY = "navarch.studio.mode";
const mode = ref<"visual" | "yaml">(readMode());
function readMode(): "visual" | "yaml" {
  try {
    return localStorage.getItem(MODE_KEY) === "yaml" ? "yaml" : "visual";
  } catch {
    return "visual";
  }
}
watch(mode, (m) => {
  try {
    localStorage.setItem(MODE_KEY, m);
  } catch {
    /* a per-browser convenience only */
  }
});

const selected = ref<string | null>(null);
const problems = ref<FlowProblem[]>([]);
const validating = ref(false);
const sim = ref<SimulationResult | null>(null);
const simBusy = ref(false);
const panel = ref<"problems" | "simulate" | null>(null);
const publishing = ref(false);
const duplicating = ref(false);
const dupName = ref("");
const properties = ref<InstanceType<typeof StudioProperties> | null>(null);
const yamlView = ref<InstanceType<typeof StudioYaml> | null>(null);

const builtin = computed(() => detail.value?.source === "builtin");
const readOnly = computed(() => builtin.value || viewing.value !== null);
const dirty = computed(() => !readOnly.value && text.value !== savedText.value);
const errors = computed(() => problems.value.filter((p) => p.severity === "error").length);
const warnings = computed(() => problems.value.length - errors.value);
/** The canvas keeps the last document that parsed while the YAML view is mid-edit. */
const lastView = ref<DraftView>({ name: null, description: null, params: {}, nodes: [], chain: [] });
const parsed = computed(() => readDraft(text.value));
watch(parsed, (v) => v && (lastView.value = v), { immediate: true });
const view = computed(() => parsed.value ?? lastView.value);
const node = computed(() => findDraftNode(view.value, selected.value));
const nextVersion = computed(() => (detail.value?.published_version ?? 0) + 1);

async function load() {
  loadError.value = null;
  conflict.value = false;
  try {
    const [flow, cat] = await Promise.all([api.flow(props.name), catalog.value ? Promise.resolve(catalog.value) : api.flowCatalog()]);
    catalog.value = cat;
    detail.value = flow;
    const v = Number(router.currentRoute.value.query.v);
    viewing.value = Number.isInteger(v) && v > 0 && flow.source === "studio" ? v : null;
    const yaml = viewing.value ? (await api.flowVersion(props.name, viewing.value)).yaml : (flow.draft_yaml ?? flow.published_yaml ?? "");
    text.value = yaml;
    savedText.value = yaml;
    revision.value = flow.draft?.revision ?? null;
    sim.value = null;
  } catch (err) {
    loadError.value = (err as Error).message;
  }
}
onMounted(load);
watch(() => [props.name, router.currentRoute.value.query.v], load);

// Live validation, about 300 ms after the last change.
let timer: ReturnType<typeof setTimeout> | undefined;
let asked = 0;
watch(text, () => {
  clearTimeout(timer);
  timer = setTimeout(async () => {
    const mine = ++asked;
    validating.value = true;
    try {
      const res = await api.validateFlow(text.value, builtin.value ? undefined : props.name);
      if (mine === asked) problems.value = res.problems;
    } catch (err) {
      if (mine === asked) problems.value = [{ severity: "error", message: (err as Error).message }];
    } finally {
      if (mine === asked) validating.value = false;
    }
  }, 300);
});

function apply(change: (doc: Document) => void) {
  if (readOnly.value) return;
  try {
    text.value = edit(text.value, change);
    sim.value = null;
  } catch (err) {
    show((err as Error).message);
  }
}

function show(message: string) {
  flash.value = message;
  setTimeout(() => flash.value === message && (flash.value = null), 5000);
}

function add(type: NodeType, after: string | null = selected.value, connected = true) {
  const out: { id?: string } = {};
  apply(addNode(type, after, connected, out));
  if (out.id) selected.value = out.id;
}

function removeSelected(id: string) {
  apply(removeNode(id));
  selected.value = null;
}

async function save(): Promise<boolean> {
  if (readOnly.value || busy.value) return false;
  busy.value = true;
  try {
    const flow = await api.saveFlowDraft(props.name, text.value, revision.value);
    detail.value = flow;
    revision.value = flow.draft?.revision ?? null;
    savedText.value = text.value;
    return true;
  } catch (err) {
    if (err instanceof ApiError && err.status === 409) conflict.value = true;
    else show((err as Error).message);
    return false;
  } finally {
    busy.value = false;
  }
}

async function publish() {
  if (dirty.value || revision.value === null) {
    if (!(await save())) return;
  }
  busy.value = true;
  try {
    const flow = await api.publishFlow(props.name, revision.value!);
    detail.value = flow;
    revision.value = null;
    savedText.value = text.value;
    publishing.value = false;
    show(t("studio.published", { version: flow.published_version ?? 0 }));
  } catch (err) {
    if (err instanceof ApiError && err.status === 409) conflict.value = true;
    else show((err as Error).message);
  } finally {
    busy.value = false;
  }
}

async function discard() {
  // A Flow never published is deleted with its draft.
  const confirm = detail.value?.published_version ? t("studio.discardConfirm") : t("studio.deleteConfirm");
  if (revision.value === null || !window.confirm(confirm)) return;
  try {
    const res = await api.discardFlowDraft(props.name, revision.value);
    savedText.value = text.value;
    if (!res.flow) await router.push("/flows");
    else await load();
  } catch (err) {
    show((err as Error).message);
  }
}

async function duplicate() {
  const name = dupName.value.trim();
  if (!/^[a-z][a-z0-9-]*$/.test(name)) return show(t("flows.nameRule"));
  try {
    await api.saveFlowDraft(name, duplicateYaml(text.value, name), null);
    duplicating.value = false;
    await router.push(`/flows/${name}`);
  } catch (err) {
    show((err as Error).message);
  }
}

async function simulate(req: Omit<SimulationRequest, "yaml">) {
  simBusy.value = true;
  try {
    sim.value = await api.simulateFlow({ ...req, yaml: text.value });
  } catch (err) {
    show((err as Error).message);
  } finally {
    simBusy.value = false;
  }
}

function openProblem(p: FlowProblem) {
  if (p.node && findDraftNode(view.value, p.node)) {
    mode.value = "visual";
    selected.value = p.node;
  } else if (p.line) {
    mode.value = "yaml";
    setTimeout(() => yamlView.value?.goTo(p.line!), 0);
  }
}

function onKey(e: KeyboardEvent) {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
    e.preventDefault();
    void save();
  }
}
const beforeUnload = (e: BeforeUnloadEvent) => {
  if (dirty.value) e.preventDefault();
};
onMounted(() => {
  window.addEventListener("keydown", onKey);
  window.addEventListener("beforeunload", beforeUnload);
});
onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKey);
  window.removeEventListener("beforeunload", beforeUnload);
  clearTimeout(timer);
});
onBeforeRouteLeave(() => !dirty.value || window.confirm(t("studio.leave")));

const chip = computed(() => {
  const f = detail.value;
  if (!f) return "";
  if (f.source === "builtin") return t("flows.builtin");
  if (viewing.value) return t("studio.viewing", { version: viewing.value });
  const parts = [f.published_version ? `v${f.published_version}` : t("flows.unpublished")];
  if (revision.value) parts.push(t("flows.draftRev", { n: revision.value }));
  return parts.join(" · ");
});
const btn = "inline-flex min-h-10 items-center gap-2 rounded-md border border-line px-3 text-sm hover:bg-surface-2 disabled:opacity-50";
</script>

<template>
  <section v-if="isDevice" class="p-6 text-muted">{{ t("studio.desktopOnly") }}</section>
  <section v-else class="flex h-full min-h-0 flex-col">
    <!-- Top bar -->
    <header class="flex flex-wrap items-center gap-2 border-b border-line bg-surface px-3 py-2">
      <RouterLink to="/flows" class="grid size-10 place-items-center rounded-md text-muted hover:text-fg" :aria-label="t('studio.back')"><ArrowLeft :size="18" aria-hidden="true" /></RouterLink>
      <h1 class="font-mono text-base font-semibold">{{ name }}</h1>
      <span v-if="detail" class="rounded-full border border-line px-2 py-0.5 text-xs text-muted">{{ chip }}</span>
      <span v-if="dirty" class="text-xs text-muted">• {{ t("studio.unsaved") }}</span>
      <div class="mx-2 inline-flex rounded-md border border-line p-0.5" role="group" :aria-label="t('studio.viewMode')">
        <button v-for="m in (['visual', 'yaml'] as const)" :key="m" type="button" class="min-h-9 rounded px-3 text-sm" :class="mode === m ? 'bg-surface-2 text-fg' : 'text-muted'" :aria-pressed="mode === m" @click="mode = m">{{ t(`studio.mode.${m}`) }}</button>
      </div>
      <button type="button" class="inline-flex min-h-10 items-center gap-1.5 rounded-md px-2 text-sm" :class="errors ? 'tone-danger' : warnings ? 'tone-warning' : 'tone-success'" style="color: var(--tone)" :aria-expanded="panel === 'problems'" @click="panel = panel === 'problems' ? null : 'problems'">
        <Loader v-if="validating" :size="15" class="spin" aria-hidden="true" />
        <component :is="errors ? CircleX : warnings ? AlertTriangle : CircleCheck" v-else :size="15" aria-hidden="true" />
        {{ errors || warnings ? t("studio.problems.summary", { errors, warnings }) : t("studio.problems.valid") }}
      </button>
      <div class="ml-auto flex flex-wrap items-center gap-2">
        <button type="button" :class="btn" :aria-expanded="panel === 'simulate'" @click="panel = panel === 'simulate' ? null : 'simulate'"><FlaskConical :size="16" aria-hidden="true" />{{ t("studio.simulate") }}</button>
        <button type="button" :class="btn" @click="duplicating = !duplicating; dupName = `${name}-copy`"><Copy :size="16" aria-hidden="true" />{{ t("flows.duplicate") }}</button>
        <template v-if="!readOnly">
          <button v-if="revision !== null" type="button" :class="btn" @click="discard">
            <Trash2 :size="16" aria-hidden="true" />{{ detail?.published_version ? t("studio.discard") : t("studio.deleteFlow") }}
          </button>
          <button type="button" :class="btn" :disabled="busy || !dirty" :title="t('studio.saveHint')" @click="save"><Save :size="16" aria-hidden="true" />{{ t("studio.save") }}</button>
          <button type="button" class="inline-flex min-h-10 items-center gap-2 rounded-md bg-accent px-3 text-sm font-semibold text-bg disabled:opacity-60" :disabled="busy || errors > 0 || (!dirty && revision === null)" @click="publishing = true">
            <Upload :size="16" aria-hidden="true" />{{ t("studio.publishButton") }}
          </button>
        </template>
      </div>
      <form v-if="duplicating" class="flex w-full items-center gap-2 pt-1" @submit.prevent="duplicate">
        <label for="dup-name" class="text-sm text-muted">{{ t("flows.newName") }}</label>
        <input id="dup-name" v-model="dupName" class="min-h-10 w-64 rounded-md border border-line bg-bg px-2.5 font-mono text-sm focus:border-accent focus:outline-none" />
        <button type="submit" :class="btn">{{ t("flows.duplicate") }}</button>
        <span class="text-xs text-muted">{{ t("flows.nameRule") }}</span>
      </form>
    </header>

    <p v-if="loadError" class="tone-danger m-4 text-sm" style="color: var(--tone)" role="alert">{{ loadError }}</p>
    <div v-if="conflict" class="tone-warning flex items-center gap-3 border-b border-line px-4 py-2 text-sm" style="color: var(--tone)" role="alert">
      {{ t("studio.conflict") }}
      <button type="button" :class="btn" @click="load">{{ t("studio.reload") }}</button>
    </div>
    <p v-if="readOnly && detail" class="border-b border-line px-4 py-1.5 text-xs text-muted">{{ builtin ? t("studio.builtinNote") : t("studio.versionNote", { version: viewing ?? 0 }) }}</p>
    <p v-if="detail?.shadowed" class="tone-warning border-b border-line px-4 py-1.5 text-xs" style="color: var(--tone)">{{ t("flows.shadowed") }}</p>
    <p v-if="flash" class="border-b border-line bg-surface-2 px-4 py-1.5 text-sm" role="status">{{ flash }}</p>

    <!-- Library | canvas or YAML | properties -->
    <div class="flex min-h-0 flex-1">
      <StudioLibrary v-if="mode === 'visual'" :disabled="readOnly || !parsed" @add="add($event)" />
      <div class="min-w-0 flex-1">
        <StudioCanvas
          v-if="mode === 'visual'"
          :view="view"
          :problems="problems"
          :sim="sim"
          :selected="selected"
          :read-only="readOnly || !parsed"
          @select="selected = $event"
          @connect="(s, tgt) => apply(connect(s, tgt))"
          @remove="removeSelected"
          @drop="(type, onto) => add(type, onto, onto !== null)"
          @properties="properties?.focus()"
        />
        <StudioYaml v-else ref="yamlView" v-model:text="text" :problems="problems" :read-only="readOnly" />
      </div>
      <StudioProperties v-if="mode === 'visual'" ref="properties" :view="view" :node="node" :catalog="catalog" :problems="problems" :read-only="readOnly || !parsed" @op="apply" @select="selected = $event" />
    </div>
    <p v-if="mode === 'visual' && !parsed" class="tone-warning border-t border-line px-4 py-1.5 text-xs" style="color: var(--tone)">{{ t("studio.yamlBroken") }}</p>

    <!-- Bottom panels -->
    <div v-if="panel" class="h-72 shrink-0 overflow-auto border-t border-line bg-surface">
      <div class="flex items-center gap-2 border-b border-line px-3 py-1.5 text-sm font-medium">
        <component :is="panel === 'problems' ? ListChecks : FlaskConical" :size="15" aria-hidden="true" />
        {{ panel === "problems" ? t("studio.problems.title") : t("studio.sim.title") }}
      </div>
      <ul v-if="panel === 'problems'" class="divide-y divide-line">
        <li v-if="!problems.length" class="px-4 py-3 text-sm text-muted">{{ t("studio.problems.none") }}</li>
        <li v-for="(p, i) in problems" :key="i">
          <button type="button" class="flex min-h-10 w-full items-center gap-2 px-4 py-1.5 text-left text-sm hover:bg-surface-2" @click="openProblem(p)">
            <component :is="p.severity === 'error' ? CircleX : AlertTriangle" :size="14" :class="p.severity === 'error' ? 'tone-danger' : 'tone-warning'" style="color: var(--tone)" aria-hidden="true" />
            <span class="sr-only">{{ p.severity === "error" ? t("studio.problems.error") : t("studio.problems.warning") }}</span>
            <span class="min-w-0 flex-1">{{ p.message }}</span>
            <span v-if="p.line" class="font-mono text-xs text-muted">{{ t("studio.problems.line", { n: p.line }) }}</span>
          </button>
        </li>
      </ul>
      <StudioSimulate v-else :view="view" :result="sim" :busy="simBusy" :can-run="errors === 0 && !!parsed" @run="simulate" />
    </div>

    <p v-if="detail?.versions.length" class="border-t border-line px-4 py-1.5 text-xs text-muted">
      {{ t("studio.versions") }}
      <template v-for="v in [...detail.versions].reverse()" :key="v.version">
        <RouterLink :to="{ path: `/flows/${name}`, query: { v: v.version } }" class="ml-2 underline hover:text-fg" :title="`${ago(v.published_at)} · ${v.actor}`">v{{ v.version }}</RouterLink>
      </template>
      <RouterLink v-if="viewing" :to="`/flows/${name}`" class="ml-3 underline hover:text-fg">{{ t("studio.backToDraft") }}</RouterLink>
    </p>

    <StudioPublish
      v-if="publishing"
      :name="name"
      :from="detail?.published_yaml ?? null"
      :to="text"
      :version="nextVersion"
      :errors="errors"
      :warnings="warnings"
      :busy="busy"
      @cancel="publishing = false"
      @confirm="publish"
    />
  </section>
</template>
