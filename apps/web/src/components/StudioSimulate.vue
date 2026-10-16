<script setup lang="ts">
import type { SimulatedOutcome, SimulationRequest, SimulationResult } from "@navarch/contracts";
import { CircleCheck, CircleSlash, CircleX, FlaskConical, OctagonAlert } from "@lucide/vue";
import { computed, reactive, ref } from "vue";
import { useI18n } from "vue-i18n";
import type { DraftView } from "../lib/flowDoc.ts";

/**
 * Dry run (spec §6.2.3, ADR 0033): the daemon walks the Flow with the engine's step function and
 * outputs chosen here. Nothing runs: no tasks, no agents, no cost.
 */
const props = defineProps<{ view: DraftView; result: SimulationResult | null; busy: boolean; canRun: boolean }>();
const emit = defineEmits<{ run: [req: Omit<SimulationRequest, "yaml">] }>();
const { t } = useI18n();

const autonomy = ref(2);
const params = reactive<Record<string, string>>({});
/** Per node: fail it, how many times a verification fails first, or outputs as `key=value, …`. */
const fail = reactive<Record<string, boolean>>({});
const failFirst = reactive<Record<string, number>>({});
const outputs = reactive<Record<string, string>>({});

const rows = computed(() =>
  props.view.nodes
    .flatMap((n) => [n, ...n.body])
    .filter((n) => n.type !== "trigger" && n.type !== "loop")
    .map((n) => ({ id: n.id, type: n.type, verify: n.type === "action" && n.raw.uses === "verification.run" })),
);

function parseOutputs(text: string): Record<string, string | number | boolean> | undefined {
  const out: Record<string, string | number | boolean> = {};
  for (const part of text.split(",")) {
    const [k, ...v] = part.split("=");
    const key = k?.trim();
    if (!key) continue;
    const raw = v.join("=").trim();
    out[key] = /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw === "true" || raw === "false" ? raw === "true" : raw;
  }
  return Object.keys(out).length ? out : undefined;
}

function run() {
  const outcomes: Record<string, SimulatedOutcome> = {};
  for (const r of rows.value) {
    if (fail[r.id]) outcomes[r.id] = { fail: true };
    else if (r.verify && (failFirst[r.id] ?? 0) > 0) outcomes[r.id] = { outputs: [...Array.from({ length: failFirst[r.id]! }, () => ({ passed: false })), { passed: true }] };
    else if (outputs[r.id]?.trim()) {
      const o = parseOutputs(outputs[r.id]!);
      if (o) outcomes[r.id] = { outputs: o };
    }
  }
  const given: Record<string, string | number | boolean> = {};
  for (const [name, p] of Object.entries(props.view.params)) {
    const v = params[name]?.trim();
    if (!v) continue;
    given[name] = p.type === "int" || p.type === "money" ? Number(v) : p.type === "bool" ? v === "true" : v;
  }
  emit("run", { autonomy_level: autonomy.value, outcomes, ...(Object.keys(given).length ? { params: given } : {}) });
}

const stepIcon = { succeeded: CircleCheck, failed: CircleX, cancelled: CircleSlash };
const input = "min-h-9 rounded-md border border-line bg-bg px-2 text-sm focus:border-accent focus:outline-none";
</script>

<template>
  <div class="flex min-h-0 gap-4 overflow-auto p-3 max-lg:flex-col">
    <form class="w-[28rem] shrink-0 space-y-3 max-lg:w-full" @submit.prevent="run">
      <div class="flex flex-wrap items-end gap-3">
        <label class="text-xs text-muted">
          <span class="mb-1 block font-medium">{{ t("studio.sim.autonomy") }}</span>
          <select v-model.number="autonomy" :class="input">
            <option v-for="l in [0, 1, 2, 3]" :key="l" :value="l">{{ l }}</option>
          </select>
        </label>
        <label v-for="(p, name) in view.params" :key="name" class="text-xs text-muted">
          <span class="mb-1 block font-mono font-medium">{{ name }}</span>
          <input v-model="params[name]" :class="input" class="w-24" :placeholder="String(p.default)" />
        </label>
        <button type="submit" :disabled="busy || !canRun" class="ml-auto inline-flex min-h-10 items-center gap-2 rounded-md bg-accent px-4 text-sm font-semibold text-bg disabled:opacity-60">
          <FlaskConical :size="16" aria-hidden="true" />{{ t("studio.sim.run") }}
        </button>
      </div>
      <p v-if="!canRun" class="text-xs text-muted">{{ t("studio.sim.fixFirst") }}</p>
      <table class="w-full text-sm">
        <thead>
          <tr class="text-left text-xs text-muted">
            <th class="py-1 font-medium">{{ t("studio.sim.node") }}</th>
            <th class="py-1 font-medium">{{ t("studio.sim.fails") }}</th>
            <th class="py-1 font-medium">{{ t("studio.sim.outputs") }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in rows" :key="r.id" class="border-t border-line">
            <td class="py-1 pr-2 font-mono text-xs">{{ r.id }}</td>
            <td class="py-1 pr-2"><input v-model="fail[r.id]" type="checkbox" class="size-4" :aria-label="t('studio.sim.failNode', { node: r.id })" /></td>
            <td class="py-1">
              <label v-if="r.verify" class="flex items-center gap-2 text-xs text-muted">
                <input v-model.number="failFirst[r.id]" type="number" min="0" max="20" :class="input" class="w-16" />{{ t("studio.sim.failFirst") }}
              </label>
              <input v-else-if="r.type === 'agent' || r.type === 'team' || r.type === 'compete'" v-model="outputs[r.id]" :class="input" class="w-full font-mono" placeholder="kind=code" :aria-label="t('studio.sim.outputsOf', { node: r.id })" />
            </td>
          </tr>
        </tbody>
      </table>
    </form>

    <div class="min-w-0 flex-1" aria-live="polite">
      <p v-if="!result" class="text-sm text-muted">{{ t("studio.sim.intro") }}</p>
      <template v-else-if="result.end">
        <p
          class="mb-2 flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium"
          :class="result.end.kind === 'done' ? 'tone-success' : result.end.kind === 'fail' ? 'tone-danger' : 'tone-warning'"
          style="background: color-mix(in srgb, var(--tone) 12%, transparent); color: var(--tone)"
        >
          <component :is="result.end.kind === 'done' ? CircleCheck : result.end.kind === 'fail' ? CircleX : OctagonAlert" :size="16" aria-hidden="true" />
          <span v-if="result.end.kind === 'done'">{{ result.end.pr_opened ? t("studio.sim.donePr") : t("studio.sim.done") }}</span>
          <span v-else-if="result.end.kind === 'fail'">{{ t("studio.sim.failed", { reason: result.end.reason }) }}</span>
          <span v-else>{{ t("studio.sim.limit") }}</span>
        </p>
        <ol class="space-y-0.5 text-sm">
          <li v-for="(s, i) in result.steps" :key="i" class="flex items-center gap-2">
            <span class="w-6 text-right font-mono text-xs text-muted">{{ i + 1 }}</span>
            <template v-if="s.kind === 'start'">
              <component :is="stepIcon[s.status]" :size="14" :class="s.status === 'failed' ? 'tone-danger' : s.status === 'cancelled' ? 'tone-neutral' : 'tone-success'" style="color: var(--tone)" aria-hidden="true" />
              <span class="font-mono">{{ s.node }}</span>
              <span v-if="s.iteration > 1" class="text-xs text-muted">×{{ s.iteration }}</span>
              <span class="text-xs text-muted">{{ t(`status.${s.stage}`) }}</span>
              <span v-if="s.status === 'failed'" class="text-xs" style="color: var(--tone-danger)">{{ t("studio.sim.state.failed") }}</span>
              <span v-else-if="s.status === 'cancelled'" class="text-xs text-muted">{{ t("studio.sim.state.cancelled") }}</span>
            </template>
            <template v-else>
              <CircleSlash :size="14" class="text-muted" aria-hidden="true" />
              <span class="font-mono text-muted">{{ s.node }}</span>
              <span class="text-xs text-muted">{{ t("studio.sim.skipped", { reason: s.reason }) }}</span>
            </template>
          </li>
        </ol>
      </template>
      <p v-else class="text-sm text-muted">{{ t("studio.sim.notRun") }}</p>
    </div>
  </div>
</template>
