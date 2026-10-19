<script setup lang="ts">
/**
 * A two-level team, drawn from a made-up run: a lead delegates to members and to sub-leads, and each
 * sub-lead runs a small team of its own, in its own worktree. It follows what the Fleet tree shows
 * (lead → sub-lead → members); the names, tasks and numbers are illustrations, not real output.
 */

type Member = { key: string; role: string; task: string; state: "done" | "running" | "waiting" };
type Sub = { key: string; role: string; task: string; state: Member["state"]; branch: string; members: Member[] };

const direct: Member[] = [{ key: "api-design", role: "architecture", task: "Interfaces for the settings page", state: "done" }];
const subs: Sub[] = [
  {
    key: "web",
    role: "sublead",
    task: "Build the settings page",
    state: "running",
    branch: "navarch/<run>/team-web",
    members: [
      { key: "form", role: "frontend", task: "Form and validation", state: "done" },
      { key: "styles", role: "frontend", task: "Dark theme and phone layout", state: "running" },
      { key: "web-tests", role: "qa", task: "Component tests", state: "waiting" },
    ],
  },
  {
    key: "api",
    role: "sublead",
    task: "Store and serve the settings",
    state: "done",
    branch: "navarch/<run>/team-api",
    members: [
      { key: "store", role: "backend", task: "Table and migration", state: "done" },
      { key: "routes", role: "backend", task: "GET and PUT routes", state: "done" },
      { key: "api-tests", role: "qa", task: "Route tests", state: "done" },
    ],
  },
];

const LABEL = { done: "merged", running: "working", waiting: "after form" } as const;
const TONE = { done: "text-success", running: "text-accent", waiting: "text-muted" } as const;
</script>

<template>
  <figure class="card min-w-0 p-5 sm:p-6" aria-label="A two-level team: a lead, two sub-leads and their members">
    <div class="flex flex-wrap items-center gap-2 font-mono text-xs text-muted">
      <span class="rounded bg-surface-2 px-2 py-1">flow team</span><span>turn 2 of 8</span><span aria-hidden="true">·</span><span>illustration</span>
    </div>

    <div class="mt-4 rounded-lg border border-accent/50 bg-surface-2 p-3">
      <p class="font-mono text-xs text-accent">lead · expert</p>
      <p class="mt-0.5 text-sm font-medium">Add a settings page, front and back</p>
    </div>

    <ul class="mt-3 space-y-3 border-l border-border pl-4 sm:pl-6">
      <li v-for="m in direct" :key="m.key" class="rounded-lg border border-border bg-surface p-3">
        <p class="font-mono text-xs text-muted">{{ m.role }} · {{ m.key }}</p>
        <p class="text-sm">{{ m.task }}</p>
        <p class="mt-1 font-mono text-xs" :class="TONE[m.state]">{{ LABEL[m.state] }}</p>
      </li>

      <li v-for="s in subs" :key="s.key" class="rounded-lg border border-border bg-surface p-3">
        <div class="flex flex-wrap items-baseline gap-x-3">
          <p class="font-mono text-xs text-accent">{{ s.role }} · {{ s.key }}</p>
          <p class="font-mono text-xs" :class="TONE[s.state]">{{ s.state === "done" ? "merged into the run" : "leading its team" }}</p>
        </div>
        <p class="text-sm font-medium">{{ s.task }}</p>
        <p class="mt-0.5 break-all font-mono text-[0.7rem] text-muted">{{ s.branch }}</p>
        <ul class="mt-3 grid gap-2 border-l border-border pl-3 sm:grid-cols-3">
          <li v-for="m in s.members" :key="m.key" class="rounded-md border border-border bg-bg/60 p-2.5">
            <p class="font-mono text-[0.7rem] text-muted">{{ m.role }}</p>
            <p class="text-xs leading-5">{{ m.task }}</p>
            <p class="mt-1 font-mono text-[0.7rem]" :class="TONE[m.state]">{{ m.state === "waiting" ? "waits for form" : LABEL[m.state] }}</p>
          </li>
        </ul>
      </li>
    </ul>
  </figure>
</template>
