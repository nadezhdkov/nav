<script setup lang="ts">
import { computed, ref } from "vue";
import CopyButton from "./CopyButton.vue";

/** Install steps as tabs, like a package manager picker. Navarch installs from source for now. */
const TABS = [
  {
    id: "install",
    label: "Install",
    lines: [
      ["# Node.js ≥ 22.18, pnpm and git", true],
      ["git clone https://github.com/nadezhdkov/nav.git navarch && cd navarch", false],
      ["make install && make web-build", false],
      ["alias navarch=\"node $PWD/apps/cli/src/main.ts\"", false],
    ],
  },
  {
    id: "run",
    label: "First run",
    lines: [
      ["# start the daemon, then give an agent a task in its own worktree", true],
      ["navarch daemon start", false],
      ["navarch run --repo ~/code/my-repo --budget 1 --follow \"Fix the failing date parser test\"", false],
    ],
  },
  {
    id: "issue",
    label: "From an issue",
    lines: [
      ["# a fine-grained GitHub token, kept in your OS keychain", true],
      ["navarch secret set github/token", false],
      ["navarch run --issue owner/repo#42 --repo ~/code/repo", false],
      ["navarch web   # follow it live, approve the plan and the PR", false],
    ],
  },
] as const;

const active = ref<(typeof TABS)[number]["id"]>("install");
const tab = computed(() => TABS.find((t) => t.id === active.value)!);
const commands = computed(() => tab.value.lines.filter(([, comment]) => !comment).map(([line]) => line).join("\n"));

function onKey(e: KeyboardEvent, i: number) {
  const next = e.key === "ArrowRight" ? i + 1 : e.key === "ArrowLeft" ? i - 1 : undefined;
  if (next === undefined) return;
  const t = TABS[(next + TABS.length) % TABS.length]!;
  active.value = t.id;
  document.getElementById(`install-tab-${t.id}`)?.focus();
}
</script>

<template>
  <div class="card overflow-hidden text-left">
    <div class="flex items-center justify-between gap-3 border-b border-border px-2 sm:px-3">
      <div role="tablist" aria-label="Install steps" class="flex overflow-x-auto">
        <button
          v-for="(t, i) in TABS"
          :id="`install-tab-${t.id}`"
          :key="t.id"
          type="button"
          role="tab"
          :aria-selected="active === t.id"
          aria-controls="install-panel"
          :tabindex="active === t.id ? 0 : -1"
          class="relative whitespace-nowrap px-3 py-3 font-mono text-sm transition-colors"
          :class="active === t.id ? 'text-text' : 'text-muted hover:text-text'"
          @click="active = t.id"
          @keydown="onKey($event, i)"
        >
          {{ t.label }}
          <span v-if="active === t.id" class="absolute inset-x-3 bottom-0 h-0.5 rounded bg-accent" aria-hidden="true" />
        </button>
      </div>
      <CopyButton :text="commands" class="shrink-0" />
    </div>
    <pre
      id="install-panel"
      role="tabpanel"
      :aria-labelledby="`install-tab-${active}`"
      class="overflow-x-auto px-4 py-4 font-mono text-[0.8rem] leading-7 sm:px-5 sm:text-sm"
    ><code><template v-for="([line, comment], i) in tab.lines" :key="i"><span v-if="comment" class="text-muted">{{ line }}</span><span v-else><span class="select-none text-accent">$ </span>{{ line }}</span>
</template></code></pre>
  </div>
</template>
