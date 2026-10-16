<script setup lang="ts">
import type { FlowCatalogView, FlowProblem } from "@navarch/contracts";
import { ArrowLeft, ArrowRight, Plus, Trash2, Unplug, X } from "@lucide/vue";
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import type { Document } from "yaml";
import { disconnect, moveNode, placeAfter, removeNode, renameNode, setField, setMeta, setParam, type DraftNode, type DraftView } from "../lib/flowDoc.ts";

/**
 * Flow Studio's properties panel (spec §6.2.3): a form per node type, or the Flow's description
 * and params when no node is selected. Every change becomes one edit of the YAML document.
 */
const props = defineProps<{
  view: DraftView;
  node: DraftNode | null;
  catalog: FlowCatalogView | null;
  problems: FlowProblem[];
  readOnly: boolean;
}>();
const emit = defineEmits<{ op: [change: (doc: Document) => void]; select: [id: string | null] }>();
const { t } = useI18n();
const root = ref<HTMLElement | null>(null);
defineExpose({ focus: () => root.value?.querySelector<HTMLElement>("input, select, textarea, button")?.focus() });

const raw = computed(() => (props.node?.raw ?? {}) as Record<string, unknown>);
const nested = (key: string, sub: string) => (raw.value[key] as Record<string, unknown> | undefined)?.[sub];
const nodeProblems = computed(() => props.problems.filter((p) => props.node && p.node === props.node.id));
const connected = computed(() => !!props.node && !props.node.parent && props.view.chain.includes(props.node.id));
const profiles = computed(() => props.catalog?.profiles.map((p) => p.id) ?? []);
const childFlow = computed(() => props.catalog?.flows.find((f) => f.name === raw.value.flow));

/** A number when it looks like one, a boolean for true/false, else the text (an expression). */
function scalar(text: string): unknown {
  const v = text.trim();
  if (v === "") return undefined;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if (v === "true" || v === "false") return v === "true";
  return v;
}
const str = (v: unknown) => (v === undefined || v === null ? "" : String(v));
const value = (e: Event) => (e.target as HTMLInputElement).value;
const checked = (e: Event) => (e.target as HTMLInputElement).checked;

function set(path: (string | number)[], v: unknown) {
  if (props.node) emit("op", setField(props.node.id, path, v));
}

function rename(e: Event) {
  const to = value(e).trim();
  if (!props.node || !to || to === props.node.id) return;
  emit("op", renameNode(props.node.id, to));
  emit("select", to);
}

// Key/value lists: `inputs` of agents and subflows, `with` of subflows.
const pairs = (key: string) => Object.entries((raw.value[key] as Record<string, unknown> | undefined) ?? {});
const newKey = ref<Record<string, string>>({});
const newVal = ref<Record<string, string>>({});
function renameKey(key: string, from: string, e: Event) {
  const to = value(e).trim();
  if (!to || to === from) return;
  const current = (raw.value[key] as Record<string, unknown>)[from];
  if (props.node) {
    const id = props.node.id;
    emit("op", (doc) => {
      setField(id, [key, from], undefined)(doc);
      setField(id, [key, to], current)(doc);
    });
  }
}
function addKey(key: string) {
  const name = (newKey.value[key] ?? "").trim();
  const v = scalar(newVal.value[key] ?? "") ?? (key === "with" ? childFlow.value?.params[name]?.default : undefined);
  if (!/^[a-z][a-z0-9_]*$/.test(name) || v === undefined || v === "") return;
  set([key, name], v);
  newKey.value[key] = "";
  newVal.value[key] = "";
}
function removeKey(key: string, name: string) {
  if (!props.node) return;
  const id = props.node.id;
  const left = pairs(key).length;
  emit("op", left > 1 ? setField(id, [key, name], undefined) : setField(id, [key], undefined));
}

// Flow params, when nothing is selected.
const newParam = ref("");
function addParam() {
  const name = newParam.value.trim();
  if (!/^[a-z][a-z0-9_]*$/.test(name)) return;
  emit("op", setParam(name, { type: "int", default: 1 }));
  newParam.value = "";
}
function changeParam(name: string, field: "type" | "default", e: Event) {
  const p = props.view.params[name]!;
  const next = { ...p, [field]: field === "type" ? value(e) : scalar(value(e)) ?? "" };
  if (field === "type") next.default = next.type === "bool" ? false : next.type === "string" ? "" : 0;
  emit("op", setParam(name, next));
}

const input = "min-h-10 w-full rounded-md border border-line bg-bg px-2.5 text-sm focus:border-accent focus:outline-none disabled:opacity-60";
const mono = `${input} font-mono`;
const label = "mb-1 block text-xs font-medium text-muted";
</script>

<template>
  <aside ref="root" class="flex w-80 shrink-0 flex-col overflow-auto border-l border-line bg-surface" :aria-label="t('studio.props.title')">
    <!-- A node -->
    <div v-if="node" class="space-y-4 p-4">
      <div class="flex items-center gap-2">
        <h2 class="text-sm font-semibold">{{ t("studio.props.node", { type: t(`node.kind.${node.type}`) }) }}</h2>
        <button type="button" class="ml-auto grid size-9 place-items-center rounded-md text-muted hover:text-fg" :aria-label="t('node.close')" @click="emit('select', null)"><X :size="16" aria-hidden="true" /></button>
      </div>
      <ul v-if="nodeProblems.length" class="space-y-1">
        <li v-for="(p, i) in nodeProblems" :key="i" class="rounded-md px-2.5 py-1.5 text-xs" :class="p.severity === 'error' ? 'tone-danger' : 'tone-warning'" style="background: color-mix(in srgb, var(--tone) 12%, transparent); color: var(--tone)">
          {{ p.message }}
        </li>
      </ul>
      <fieldset :disabled="readOnly" class="space-y-3">
        <label class="block"><span :class="label">{{ t("studio.props.id") }}</span><input :class="mono" :value="node.id" @change="rename" /></label>
        <label class="block"><span :class="label">{{ t("studio.props.name") }}</span><input :class="input" :value="str(raw.name)" @change="set(['name'], value($event).trim())" /></label>

        <template v-if="node.type === 'agent'">
          <label class="block">
            <span :class="label">{{ t("node.profile") }}</span>
            <select :class="input" :value="str(raw.profile)" @change="set(['profile'], value($event))">
              <option v-if="!profiles.includes(str(raw.profile))" :value="str(raw.profile)">{{ str(raw.profile) || "—" }}</option>
              <option v-for="p in profiles" :key="p" :value="p">{{ p }}</option>
            </select>
          </label>
          <label class="block">
            <span :class="label">{{ t("node.adapter") }}</span>
            <select :class="input" :value="str(raw.adapter)" @change="set(['adapter'], value($event))">
              <option value="">{{ t("studio.props.routed") }}</option>
              <option v-for="a in catalog?.adapters ?? []" :key="a" :value="a">{{ a }}</option>
            </select>
          </label>
        </template>

        <label v-if="node.type === 'action' || node.type === 'github'" class="block">
          <span :class="label">{{ t("studio.props.uses") }}</span>
          <select :class="input" :value="str(raw.uses)" @change="set(['uses'], value($event))">
            <option v-for="u in catalog?.uses[node.type] ?? []" :key="u" :value="u">{{ u }}</option>
          </select>
        </label>

        <label v-if="node.type === 'approval'" class="block">
          <span :class="label">{{ t("studio.props.show") }}</span>
          <input :class="mono" :value="Array.isArray(raw.show) ? raw.show.join(', ') : ''" placeholder="nodes.plan.outputs.summary" @change="set(['show'], value($event).split(',').map((s) => s.trim()).filter(Boolean).length ? value($event).split(',').map((s) => s.trim()).filter(Boolean) : undefined)" />
        </label>

        <template v-if="node.type === 'loop'">
          <label class="block"><span :class="label">{{ t("studio.props.maxIterations") }}</span><input :class="mono" :value="str(raw.max_iterations)" @change="set(['max_iterations'], scalar(value($event)))" /></label>
          <label class="block"><span :class="label">{{ t("studio.props.until") }}</span><input :class="mono" :value="str(raw.until)" @change="set(['until'], value($event).trim())" /></label>
        </template>

        <template v-if="node.type === 'team'">
          <label class="block">
            <span :class="label">{{ t("studio.props.lead") }}</span>
            <select :class="input" :value="str(nested('lead', 'profile'))" @change="set(['lead', 'profile'], value($event))">
              <option v-for="p in profiles" :key="p" :value="p">{{ p }}</option>
            </select>
          </label>
          <label class="block"><span :class="label">{{ t("studio.props.maxTurns") }}</span><input :class="mono" :value="str(raw.max_turns)" @change="set(['max_turns'], scalar(value($event)))" /></label>
          <label class="block"><span :class="label">{{ t("studio.props.maxMembers") }}</span><input :class="mono" :value="str(raw.max_members)" placeholder="12" @change="set(['max_members'], scalar(value($event)))" /></label>
          <label class="flex min-h-10 items-center gap-2 text-sm"><input type="checkbox" class="size-4" :checked="raw.parallel === true" @change="set(['parallel'], checked($event) || undefined)" />{{ t("studio.props.parallel") }}</label>
          <label class="flex min-h-10 items-center gap-2 text-sm"><input type="checkbox" class="size-4" :checked="raw.approve_first_plan === true" @change="set(['approve_first_plan'], checked($event) || undefined)" />{{ t("studio.props.approveFirstPlan") }}</label>
        </template>

        <template v-if="node.type === 'compete'">
          <label class="block"><span :class="label">{{ t("studio.props.competitors") }}</span><input :class="mono" :value="str(raw.competitors)" @change="set(['competitors'], scalar(value($event)))" /></label>
          <label class="block">
            <span :class="label">{{ t("studio.props.judge") }}</span>
            <select :class="input" :value="str(nested('judge', 'profile'))" @change="set(['judge', 'profile'], value($event))">
              <option v-for="p in profiles" :key="p" :value="p">{{ p }}</option>
            </select>
          </label>
          <label class="block"><span :class="label">{{ t("studio.props.maxFixIterations") }}</span><input :class="mono" :value="str(raw.max_fix_iterations)" placeholder="2" @change="set(['max_fix_iterations'], scalar(value($event)))" /></label>
          <label class="flex min-h-10 items-center gap-2 text-sm"><input type="checkbox" class="size-4" :checked="raw.approve_pick === true" @change="set(['approve_pick'], checked($event) || undefined)" />{{ t("studio.props.approvePick") }}</label>
        </template>

        <template v-if="node.type === 'parallel'">
          <label class="block">
            <span :class="label">{{ t("studio.props.join") }}</span>
            <input :class="mono" :value="str(raw.join ?? 'all')" list="join-modes" @change="set(['join'], value($event).trim() || undefined)" />
            <datalist id="join-modes"><option value="all" /><option value="any" /><option value="quorum:2" /></datalist>
            <span class="mt-1 block text-xs text-muted">{{ t("studio.props.joinHelp") }}</span>
          </label>
          <div>
            <span :class="label">{{ t("studio.props.branches") }}</span>
            <ul class="space-y-1 text-sm">
              <li v-for="(list, key) in (raw.branches as Record<string, { id?: string; profile?: string; uses?: string }[]> | undefined) ?? {}" :key="key">
                <span class="font-medium">{{ key }}</span>
                <span class="font-mono text-xs text-muted"> · {{ (Array.isArray(list) ? list : []).map((b) => `${b.id ?? "?"}${b.profile ? ` (${b.profile})` : b.uses ? ` (${b.uses})` : ""}`).join(" → ") }}</span>
              </li>
            </ul>
            <span class="mt-1 block text-xs text-muted">{{ t("studio.props.branchesHelp") }}</span>
          </div>
        </template>

        <label v-if="node.type === 'subflow'" class="block">
          <span :class="label">{{ t("studio.props.flow") }}</span>
          <select :class="input" :value="str(raw.flow)" @change="set(['flow'], value($event))">
            <option v-if="!catalog?.flows.some((f) => f.name === raw.flow)" :value="str(raw.flow)">{{ str(raw.flow) || "—" }}</option>
            <option v-for="f in catalog?.flows ?? []" :key="f.name" :value="f.name">{{ f.name }}</option>
          </select>
        </label>

        <!-- Key/value lists: params of a subflow's child, inputs of agents and subflows -->
        <div v-for="key in node.type === 'subflow' ? ['with', 'inputs'] : node.type === 'agent' ? ['inputs'] : []" :key="key">
          <span :class="label">{{ t(`studio.props.${key}`) }}</span>
          <div v-for="[k, v] in pairs(key)" :key="k" class="mb-1.5 flex gap-1.5">
            <input :class="mono" class="!w-28 shrink-0" :value="k" :aria-label="t('studio.props.key')" @change="renameKey(key, k, $event)" />
            <input :class="mono" :value="str(v).trim()" :aria-label="t('studio.props.valueOf', { key: k })" @change="scalar(value($event)) !== undefined && set([key, k], scalar(value($event)))" />
            <button type="button" class="grid size-10 shrink-0 place-items-center rounded-md text-muted hover:text-fg" :aria-label="t('studio.props.removeKey', { key: k })" @click="removeKey(key, k)"><X :size="14" aria-hidden="true" /></button>
          </div>
          <div class="flex gap-1.5">
            <input v-model="newKey[key]" :class="mono" class="!w-28 shrink-0" :placeholder="key === 'with' ? Object.keys(childFlow?.params ?? {})[0] ?? 'name' : t('studio.props.newInput')" :aria-label="t('studio.props.key')" @keydown.enter.prevent="addKey(key)" />
            <input v-model="newVal[key]" :class="mono" :placeholder="t('studio.props.value')" :aria-label="t('studio.props.value')" @keydown.enter.prevent="addKey(key)" />
            <button type="button" class="grid size-10 shrink-0 place-items-center rounded-md border border-line hover:bg-surface-2" :aria-label="t('studio.props.addKey')" @click="addKey(key)"><Plus :size="14" aria-hidden="true" /></button>
          </div>
        </div>

        <label v-if="node.type !== 'trigger'" class="block">
          <span :class="label">{{ t("studio.props.when") }}</span>
          <input :class="mono" :value="str(raw.when)" placeholder="${{ project.autonomy_level < 3 }}" @change="set(['when'], value($event).trim())" />
          <span class="mt-1 block text-xs text-muted">{{ t("studio.props.whenHint") }}</span>
        </label>
        <p v-else class="text-xs text-muted">{{ t("studio.props.triggerHint") }}</p>
      </fieldset>

      <label v-if="!readOnly && !node.parent && !connected && node.type !== 'trigger'" class="block border-t border-line pt-3">
        <span :class="label">{{ t("studio.props.connectAfter") }}</span>
        <select :class="input" value="" @change="emit('op', placeAfter(node.id, value($event) === '^' ? null : value($event)))">
          <option value="" disabled>{{ t("studio.props.connectPick") }}</option>
          <option value="^">{{ t("studio.props.connectFirst") }}</option>
          <option v-for="id in view.chain" :key="id" :value="id">{{ id }}</option>
        </select>
      </label>
      <div v-if="!readOnly" class="flex flex-wrap gap-2 border-t border-line pt-3">
        <button type="button" class="inline-flex min-h-10 items-center gap-1.5 rounded-md border border-line px-3 text-sm hover:bg-surface-2" @click="emit('op', moveNode(node.id, -1))"><ArrowLeft :size="14" aria-hidden="true" />{{ t("studio.props.earlier") }}</button>
        <button type="button" class="inline-flex min-h-10 items-center gap-1.5 rounded-md border border-line px-3 text-sm hover:bg-surface-2" @click="emit('op', moveNode(node.id, 1))">{{ t("studio.props.later") }}<ArrowRight :size="14" aria-hidden="true" /></button>
        <button v-if="connected" type="button" class="inline-flex min-h-10 items-center gap-1.5 rounded-md border border-line px-3 text-sm hover:bg-surface-2" @click="emit('op', disconnect(node.id))"><Unplug :size="14" aria-hidden="true" />{{ t("studio.props.disconnect") }}</button>
        <button type="button" class="tone-danger inline-flex min-h-10 items-center gap-1.5 rounded-md border border-line px-3 text-sm hover:bg-surface-2" style="color: var(--tone)" @click="emit('op', removeNode(node.id)); emit('select', null)"><Trash2 :size="14" aria-hidden="true" />{{ t("studio.props.delete") }}</button>
      </div>
    </div>

    <!-- The Flow itself -->
    <div v-else class="space-y-4 p-4">
      <h2 class="text-sm font-semibold">{{ t("studio.props.flowTitle") }}</h2>
      <fieldset :disabled="readOnly" class="space-y-3">
        <label class="block">
          <span :class="label">{{ t("studio.props.description") }}</span>
          <textarea :class="input" class="py-2" rows="3" :value="view.description ?? ''" @change="emit('op', setMeta('description', value($event).trim()))" />
        </label>
        <div>
          <span :class="label">{{ t("studio.props.params") }}</span>
          <p class="mb-2 text-xs text-muted">{{ t("studio.props.paramsHint") }}</p>
          <div v-for="(p, name) in view.params" :key="name" class="mb-1.5 flex items-center gap-1.5">
            <span class="w-24 shrink-0 truncate font-mono text-xs" :title="String(name)">{{ name }}</span>
            <select :class="input" class="!w-24 shrink-0" :value="p.type" :aria-label="t('studio.props.paramType', { name })" @change="changeParam(String(name), 'type', $event)">
              <option v-for="ty in ['int', 'money', 'string', 'bool']" :key="ty" :value="ty">{{ ty }}</option>
            </select>
            <input :class="mono" :value="str(p.default)" :aria-label="t('studio.props.paramDefault', { name })" @change="changeParam(String(name), 'default', $event)" />
            <button type="button" class="grid size-10 shrink-0 place-items-center rounded-md text-muted hover:text-fg" :aria-label="t('studio.props.removeKey', { key: name })" @click="emit('op', setParam(String(name), null))"><X :size="14" aria-hidden="true" /></button>
          </div>
          <div class="flex gap-1.5">
            <input v-model="newParam" :class="mono" :placeholder="t('studio.props.newParam')" :aria-label="t('studio.props.newParam')" @keydown.enter.prevent="addParam" />
            <button type="button" class="grid size-10 shrink-0 place-items-center rounded-md border border-line hover:bg-surface-2" :aria-label="t('studio.props.addParam')" @click="addParam"><Plus :size="14" aria-hidden="true" /></button>
          </div>
        </div>
      </fieldset>
      <p class="text-xs text-muted">{{ t("studio.props.selectHint") }}</p>
    </div>
  </aside>
</template>
