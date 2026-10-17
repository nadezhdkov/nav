<script setup lang="ts">
import { Check, CircleDashed, GitPullRequestDraft, Hand, LoaderCircle, Pause, Play, RotateCcw, X } from "@lucide/vue";
import { computed, onBeforeUnmount, onMounted, reactive, ref } from "vue";

/**
 * A scripted run of the `fix-issue` Flow, replayed in a loop: triage, plan, the plan approval,
 * implement ⇄ verify with one failed check, review on another provider, and the draft PR waiting
 * for a human. It is an illustration; every status pairs an icon with a word.
 */

type State = "pending" | "running" | "waiting" | "done" | "failed";
type NodeKey = "triage" | "plan" | "approve" | "implement" | "verify" | "review" | "pr";

const NODES: { key: NodeKey; label: string; agent?: string; gate?: boolean }[] = [
  { key: "triage", label: "Triage", agent: "grok" },
  { key: "plan", label: "Plan", agent: "claude-code" },
  { key: "approve", label: "Approve", gate: true },
  { key: "implement", label: "Implement", agent: "codex" },
  { key: "verify", label: "Verify", agent: "make test" },
  { key: "review", label: "Review", agent: "gemini-cli" },
  { key: "pr", label: "Draft PR", gate: true },
];

type Step = { set?: Partial<Record<NodeKey, State>>; log: string; tone?: "accent" | "success" | "warning" | "danger"; cost?: number; iteration?: number; wait: number };

const SCRIPT: Step[] = [
  { log: "run.created      issue acme/shop#42 → brave-frigate", wait: 900 },
  { set: { triage: "running" }, log: "model.routed     triage → grok · tier fast", tone: "accent", wait: 1300 },
  { set: { triage: "done", plan: "running" }, log: "triage           Kind: bug · Complexity: 2", cost: 0.02, wait: 1500 },
  { set: { plan: "done", approve: "waiting" }, log: "approval.request plan · waiting for you", tone: "warning", cost: 0.11, wait: 1900 },
  { set: { approve: "done", implement: "running" }, log: "approval.decided approved from your phone", tone: "success", wait: 1500 },
  { set: { implement: "done", verify: "running" }, log: "worktree         navarch/brave-frigate/fix-issue · 3 files", cost: 0.24, wait: 1300 },
  { set: { verify: "failed" }, log: "verify           1 test failed → fix loop 2/3", tone: "danger", wait: 1400 },
  { set: { verify: "pending", implement: "running" }, iteration: 2, log: "implement        iteration 2 · resumes the same session", wait: 1500 },
  { set: { implement: "done", verify: "running" }, log: "verify           make test", cost: 0.29, wait: 1200 },
  { set: { verify: "done", review: "running" }, log: "verify           all checks passed", tone: "success", wait: 1300 },
  { set: { review: "done", pr: "waiting" }, log: "review           Verdict: approve · other provider", cost: 0.34, wait: 1700 },
  { set: { pr: "done" }, log: "github.pr        draft #128 opened · you review and merge", tone: "success", wait: 3600 },
];

const states = reactive<Record<NodeKey, State>>(blank());
const log = ref<{ id: number; text: string; tone?: Step["tone"] }[]>([]);
const cost = ref(0);
const iteration = ref(1);
const playing = ref(true);
let step = 0;
let seq = 0;
let timer: ReturnType<typeof setTimeout> | undefined;

function blank(): Record<NodeKey, State> {
  return { triage: "pending", plan: "pending", approve: "pending", implement: "pending", verify: "pending", review: "pending", pr: "pending" };
}

function apply(s: Step) {
  Object.assign(states, s.set ?? {});
  if (s.cost !== undefined) cost.value = s.cost;
  if (s.iteration) iteration.value = s.iteration;
  log.value = [...log.value, { id: ++seq, text: s.log, tone: s.tone }].slice(-5);
}

function reset() {
  Object.assign(states, blank());
  cost.value = 0;
  iteration.value = 1;
  log.value = [];
  step = 0;
}

function tick() {
  if (!playing.value) return;
  if (step >= SCRIPT.length) reset();
  const s = SCRIPT[step++]!;
  apply(s);
  timer = setTimeout(tick, s.wait);
}

function toggle() {
  playing.value = !playing.value;
  clearTimeout(timer);
  if (playing.value) tick();
}

function onVisibility() {
  if (document.hidden) clearTimeout(timer);
  else if (playing.value) {
    clearTimeout(timer);
    timer = setTimeout(tick, 600);
  }
}

onMounted(() => {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
    // The finished run, without motion.
    playing.value = false;
    for (const s of SCRIPT) apply(s);
    return;
  }
  document.addEventListener("visibilitychange", onVisibility);
  timer = setTimeout(tick, 500);
});
onBeforeUnmount(() => {
  clearTimeout(timer);
  document.removeEventListener("visibilitychange", onVisibility);
});

const doneCount = computed(() => NODES.filter((n) => states[n.key] === "done").length);
const progress = computed(() => doneCount.value / NODES.length);
const status = computed(() => {
  if (states.pr === "done") return { text: "Draft PR opened", tone: "text-success" };
  if (Object.values(states).includes("waiting")) return { text: "Waiting for you", tone: "text-warning" };
  if (Object.values(states).includes("failed")) return { text: "Fixing", tone: "text-danger" };
  return { text: "Running", tone: "text-accent" };
});

const STATE_TEXT: Record<State, string> = { pending: "queued", running: "running", waiting: "needs you", done: "done", failed: "checks failed" };
const TONE: Record<State, string> = {
  pending: "text-muted",
  running: "text-accent",
  waiting: "text-warning",
  done: "text-success",
  failed: "text-danger",
};
const LOG_TONE = { accent: "text-accent", success: "text-success", warning: "text-warning", danger: "text-danger" } as const;
</script>

<template>
  <figure class="card relative overflow-hidden text-left" aria-label="An animated example run of the fix-issue Flow">
    <!-- Window chrome: the run's name, Flow and cost against its budget. -->
    <div class="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border px-4 py-3 sm:px-5">
      <div class="flex items-center gap-1.5" aria-hidden="true">
        <span class="h-2.5 w-2.5 rounded-full bg-edge" /><span class="h-2.5 w-2.5 rounded-full bg-edge" /><span class="h-2.5 w-2.5 rounded-full bg-edge" />
      </div>
      <p class="font-mono text-sm">
        <span class="font-semibold">brave-frigate</span>
        <span class="text-muted"> · fix-issue · acme/shop#42</span>
      </p>
      <p class="ml-auto flex items-center gap-3 font-mono text-xs text-muted">
        <span :class="status.tone" class="font-semibold">{{ status.text }}</span>
        <span>${{ cost.toFixed(2) }} / $2.00</span>
        <button
          type="button"
          class="grid h-8 w-8 place-items-center rounded-md border border-border text-muted transition hover:text-text"
          :aria-label="playing ? 'Pause the animation' : 'Play the animation'"
          @click="toggle"
        >
          <Pause v-if="playing" :size="14" aria-hidden="true" />
          <Play v-else :size="14" aria-hidden="true" />
        </button>
      </p>
    </div>
    <div class="h-0.5 bg-surface-2" aria-hidden="true">
      <div class="h-full bg-accent transition-[width] duration-700 ease-out" :style="{ width: `${progress * 100}%` }" />
    </div>

    <!-- The Flow: a row of nodes on wide screens, a column on phones. -->
    <ol class="relative grid gap-2.5 p-4 sm:p-5 lg:grid-cols-7 lg:gap-3">
      <li
        v-for="(n, i) in NODES"
        :key="n.key"
        class="node relative flex items-center gap-3 rounded-xl border px-3 py-2.5 transition-all duration-500 lg:flex-col lg:items-start lg:gap-2 lg:py-3"
        :class="[
          `is-${states[n.key]}`,
          n.gate ? 'border-dashed' : '',
          states[n.key] === 'pending' ? 'border-border bg-surface' : 'bg-surface-2',
        ]"
      >
        <span class="flex items-center gap-2 lg:w-full">
          <span class="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-bg/60" :class="TONE[states[n.key]]" aria-hidden="true">
            <LoaderCircle v-if="states[n.key] === 'running'" :size="16" class="animate-spin" />
            <Check v-else-if="states[n.key] === 'done'" :size="16" />
            <X v-else-if="states[n.key] === 'failed'" :size="16" />
            <Hand v-else-if="states[n.key] === 'waiting'" :size="16" />
            <GitPullRequestDraft v-else-if="n.key === 'pr'" :size="16" />
            <CircleDashed v-else :size="16" />
          </span>
          <span class="text-sm font-semibold leading-tight">{{ n.label }}</span>
        </span>
        <span class="ml-auto flex flex-col items-end gap-0.5 lg:ml-0 lg:items-start">
          <span class="font-mono text-[0.7rem]" :class="TONE[states[n.key]]">
            {{ STATE_TEXT[states[n.key]] }}<template v-if="n.key === 'implement' && iteration > 1"> · ×{{ iteration }}</template>
          </span>
          <span class="font-mono text-[0.7rem] text-muted">{{ n.gate ? "human" : n.agent }}</span>
        </span>
        <span v-if="i < NODES.length - 1" class="connector hidden lg:block" :class="{ lit: states[n.key] === 'done' }" aria-hidden="true" />
      </li>
    </ol>

    <!-- The fix loop between implement and verify. -->
    <div class="-mt-2 mb-3 hidden grid-cols-7 gap-3 px-5 lg:grid" aria-hidden="true">
      <span
        class="col-span-2 col-start-4 flex items-center justify-center gap-1.5 rounded-b-lg border border-t-0 border-dashed pb-1 pt-1.5 font-mono text-[0.68rem] transition-colors"
        :class="states.verify === 'failed' ? 'border-danger text-danger' : 'border-edge text-muted'"
      >
        <RotateCcw :size="11" /> fix loop ≤ 3
      </span>
    </div>

    <!-- The event log, as the timeline shows it. -->
    <div class="border-t border-border bg-bg/50 px-4 py-3 sm:px-5" aria-live="off">
      <TransitionGroup tag="ul" name="log" class="min-h-[7.5rem] space-y-1 font-mono text-[0.72rem] leading-5 sm:text-xs">
        <li v-for="l in log" :key="l.id" class="truncate" :class="l.tone ? LOG_TONE[l.tone] : 'text-muted'">
          <span class="text-edge">›</span> {{ l.text }}
        </li>
      </TransitionGroup>
    </div>
  </figure>
</template>

<style scoped>
.node.is-running {
  border-color: color-mix(in srgb, var(--accent) 70%, transparent);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent) 30%, transparent), 0 0 28px -6px var(--glow);
}
.node.is-waiting {
  border-color: var(--tone-warning);
  animation: pulse 1.6s ease-in-out infinite;
}
.node.is-failed {
  border-color: var(--tone-danger);
}
.node.is-done {
  border-color: color-mix(in srgb, var(--tone-success) 45%, var(--border));
}
@keyframes pulse {
  50% {
    box-shadow: 0 0 0 4px color-mix(in srgb, var(--tone-warning) 18%, transparent);
  }
}
.connector {
  position: absolute;
  top: 50%;
  right: -0.75rem;
  width: 0.75rem;
  height: 2px;
  background: var(--border);
  transition: background 0.5s;
}
.connector.lit {
  background: var(--accent);
}
.log-enter-active {
  transition: all 0.35s ease;
}
.log-enter-from {
  opacity: 0;
  transform: translateY(6px);
}
.log-leave-active {
  display: none;
}
</style>
