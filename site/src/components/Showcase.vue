<script setup lang="ts">
import { computed, ref } from "vue";
import { asset } from "../lib/site.ts";

/** The Web UI in tabs, Orca-style: one real screenshot per tab with what it shows. */
const SHOTS = [
  { id: "fleet", label: "Fleet", src: "shots/fleet-tree.png", title: "Every agent at work, as a tree", text: "Project → run → agents, with step progress, cost against budget, adapter and model. In a team run the lead sits above the members it delegates to. Type into any card to steer that agent." },
  { id: "graph", label: "Run graph", src: "shots/run-graph-dark.png", title: "The live task graph of a run", text: "Every node of the run's Flow with its status, agent and model, the fix loop, and the amber gate where a human decides. The timeline beside it is the run's full event log." },
  { id: "worktree", label: "Worktree", src: "shots/fleet-worktree.png", title: "What the agent changed, live", text: "Files changed since the base commit with added and removed lines, and each file's diff, read without touching the agent's index." },
  { id: "approvals", label: "Approvals", src: "shots/approvals.png", title: "What, why and the cost, then you decide", text: "A plan or a PR waits for you with what will happen, why it needs you and what the run has cost so far. Approve, or reject with a reason." },
  { id: "runs", label: "Runs", src: "shots/runs.png", title: "Every run at a glance", text: "Status, Flow, repository and cost against budget, with codenames you can type anywhere a run id goes." },
] as const;

const active = ref<(typeof SHOTS)[number]["id"]>("fleet");
const shot = computed(() => SHOTS.find((s) => s.id === active.value)!);

function onKey(e: KeyboardEvent, i: number) {
  const next = e.key === "ArrowRight" ? i + 1 : e.key === "ArrowLeft" ? i - 1 : undefined;
  if (next === undefined) return;
  const s = SHOTS[(next + SHOTS.length) % SHOTS.length]!;
  active.value = s.id;
  document.getElementById(`shot-tab-${s.id}`)?.focus();
}
</script>

<template>
  <div>
    <div role="tablist" aria-label="Web UI screens" class="mx-auto flex w-fit max-w-full gap-1 overflow-x-auto rounded-xl border border-border bg-surface p-1">
      <button
        v-for="(s, i) in SHOTS"
        :id="`shot-tab-${s.id}`"
        :key="s.id"
        type="button"
        role="tab"
        :aria-selected="active === s.id"
        aria-controls="shot-panel"
        :tabindex="active === s.id ? 0 : -1"
        class="whitespace-nowrap rounded-lg px-3.5 py-2 text-sm transition-colors"
        :class="active === s.id ? 'bg-surface-2 text-text shadow-sm' : 'text-muted hover:text-text'"
        @click="active = s.id"
        @keydown="onKey($event, i)"
      >
        {{ s.label }}
      </button>
    </div>
    <div id="shot-panel" role="tabpanel" :aria-labelledby="`shot-tab-${active}`" class="mt-6">
      <Transition name="shot" mode="out-in">
        <figure :key="shot.id" class="grid items-start gap-6 lg:grid-cols-[1fr_17rem]">
          <div class="card min-w-0 overflow-hidden p-1.5">
            <img :src="asset(shot.src)" :alt="shot.title" class="block h-auto w-full rounded-[10px]" decoding="async" />
          </div>
          <figcaption class="lg:pt-4">
            <h3 class="text-lg font-semibold tracking-tight">{{ shot.title }}</h3>
            <p class="mt-2 text-sm leading-6 text-muted">{{ shot.text }}</p>
          </figcaption>
        </figure>
      </Transition>
    </div>
  </div>
</template>

<style scoped>
.shot-enter-active,
.shot-leave-active {
  transition:
    opacity 0.25s ease,
    transform 0.25s ease;
}
.shot-enter-from {
  opacity: 0;
  transform: translateY(8px);
}
.shot-leave-to {
  opacity: 0;
}
</style>
