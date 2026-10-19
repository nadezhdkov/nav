<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";

/**
 * A terminal that types a few `navarch` sessions, one per tab. The output follows the CLI's real
 * shapes (`run … created`, `run show`, `approvals`); names and numbers are made up.
 */

type Line = { kind: "cmd" | "out" | "dim" | "ok" | "warn" | "you" | "art" | "brand"; text: string };

const SESSIONS: { id: string; label: string; lines: Line[] }[] = [
  {
    id: "run",
    label: "Run a task",
    lines: [
      { kind: "cmd", text: 'navarch run --repo ~/code/shop --budget 1 "Add a unit test for parse_date"' },
      { kind: "out", text: "run brave-frigate (run_01M54A7Q…) created (created)" },
      { kind: "dim", text: "model.routed  implement → claude-code · tier standard" },
      { kind: "dim", text: "implement     editing tests/test_dates.py" },
      { kind: "dim", text: "verify        make test · 214 passed" },
      { kind: "ok", text: "done  $0.00 billed · $0.18 plan-equivalent · branch navarch/run_01M54A7Q…/task" },
    ],
  },
  {
    id: "approve",
    label: "Approve",
    lines: [
      { kind: "cmd", text: "navarch approvals" },
      { kind: "out", text: "apr_01M54B2X…  flow.approval  run calm-ferry  (pending)" },
      { kind: "dim", text: "  Plan: guard parse_date against empty strings; add 3 tests." },
      { kind: "dim", text: "  cost so far $0.04 of $2.00" },
      { kind: "cmd", text: "navarch approve apr_01M54B2X…" },
      { kind: "ok", text: "approved · implement is starting in its own worktree" },
    ],
  },
  {
    id: "say",
    label: "Steer an agent",
    lines: [
      { kind: "cmd", text: "navarch run show calm-ferry" },
      { kind: "out", text: "status   executing" },
      { kind: "out", text: "flow     fix-issue (autonomy level 2)" },
      { kind: "dim", text: "  implement  codex  running  attempt 1/3" },
      { kind: "cmd", text: 'navarch say calm-ferry --now "Use pnpm, not npm"' },
      { kind: "ok", text: "sent · codex resumes its session with your instruction" },
    ],
  },
  {
    id: "chat",
    label: "Just ask",
    lines: [
      { kind: "cmd", text: "navarch" },
      { kind: "art", text: "●   │   ●  █   █  ███  █   █  ███  ████   ████ █   █" },
      { kind: "art", text: " ╲ ┌┴┐ ╱   ██  █ █   █ █   █ █   █ █   █ █     █   █" },
      { kind: "art", text: "──┤ ◉ ├──  █ █ █ █████ █   █ █████ ████  █     █████" },
      { kind: "art", text: " ╱ └┬┘ ╲   █  ██ █   █  █ █  █   █ █  █  █     █   █" },
      { kind: "art", text: "●   │   ●  █   █ █   █   █   █   █ █   █  ████ █   █" },
      { kind: "out", text: "orchestrate your fleet of coding agents" },
      { kind: "dim", text: "▪ Project     shop        ▪ Branch   main" },
      { kind: "dim", text: "▪ Workspace   ~/code/shop ▪ Agents   2 running" },
      { kind: "ok", text: "● System ready" },
      { kind: "you", text: "› why did the last run fail?" },
      { kind: "out", text: "witty-knarr failed at verify: `make lint` reported 2 files to" },
      { kind: "out", text: "reformat after 3 fix iterations. Want me to resume it?" },
      { kind: "you", text: "› yes" },
      { kind: "warn", text: "proposal: resume_run witty-knarr  [y/N] y" },
      { kind: "ok", text: "resumed · its failed tasks are ready again" },
    ],
  },
];

const active = ref(SESSIONS[0]!.id);
const shown = ref<Line[]>([]);
const typing = ref("");
let timer: ReturnType<typeof setTimeout> | undefined;
let reduced = false;

const wait = (ms: number) => new Promise<void>((r) => (timer = setTimeout(r, ms)));
let runId = 0;

async function play(id: string) {
  const mine = ++runId;
  clearTimeout(timer);
  shown.value = [];
  typing.value = "";
  const session = SESSIONS.find((s) => s.id === id)!;
  if (reduced) {
    shown.value = [...session.lines];
    return;
  }
  for (const line of session.lines) {
    if (mine !== runId) return;
    if (line.kind === "cmd" || line.kind === "you") {
      for (let i = 1; i <= line.text.length; i++) {
        typing.value = line.text.slice(0, i);
        await wait(18 + Math.random() * 30);
        if (mine !== runId) return;
      }
      await wait(260);
      typing.value = "";
    } else {
      await wait(line.kind === "dim" ? 380 : line.kind === "art" ? 120 : 520);
    }
    if (mine !== runId) return;
    shown.value = [...shown.value, line];
  }
}

function onKey(e: KeyboardEvent, i: number) {
  const next = e.key === "ArrowRight" ? i + 1 : e.key === "ArrowLeft" ? i - 1 : undefined;
  if (next === undefined) return;
  const s = SESSIONS[(next + SESSIONS.length) % SESSIONS.length]!;
  active.value = s.id;
  document.getElementById(`term-tab-${s.id}`)?.focus();
}

const root = ref<HTMLElement>();
let observer: IntersectionObserver | undefined;
let started = false;

watch(active, (id) => started && play(id));
onMounted(() => {
  reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduced) {
    started = true;
    void play(active.value);
    return;
  }
  // Starts typing when it scrolls into view, so the first session is not over before anyone looks.
  observer = new IntersectionObserver(([entry]) => {
    if (!entry?.isIntersecting || started) return;
    started = true;
    void play(active.value);
  }, { threshold: 0.35 });
  if (root.value) observer.observe(root.value);
});
onBeforeUnmount(() => {
  runId++;
  clearTimeout(timer);
  observer?.disconnect();
});

const CLASS: Record<Line["kind"], string> = {
  cmd: "text-text",
  you: "text-accent",
  out: "text-text/90",
  dim: "text-muted",
  ok: "text-success",
  warn: "text-warning",
  art: "text-accent",
  brand: "text-accent",
};
</script>

<template>
  <div ref="root" class="card overflow-hidden text-left">
    <div class="flex items-center gap-3 border-b border-border px-3">
      <div class="flex gap-1.5 py-3 pl-1" aria-hidden="true">
        <span class="h-2.5 w-2.5 rounded-full bg-edge" /><span class="h-2.5 w-2.5 rounded-full bg-edge" /><span class="h-2.5 w-2.5 rounded-full bg-edge" />
      </div>
      <div role="tablist" aria-label="Terminal sessions" class="flex overflow-x-auto">
        <button
          v-for="(s, i) in SESSIONS"
          :id="`term-tab-${s.id}`"
          :key="s.id"
          type="button"
          role="tab"
          :aria-selected="active === s.id"
          aria-controls="term-panel"
          :tabindex="active === s.id ? 0 : -1"
          class="relative whitespace-nowrap px-3 py-3 font-mono text-xs transition-colors sm:text-sm"
          :class="active === s.id ? 'text-text' : 'text-muted hover:text-text'"
          @click="active = s.id"
          @keydown="onKey($event, i)"
        >
          {{ s.label }}
          <span v-if="active === s.id" class="absolute inset-x-3 bottom-0 h-0.5 rounded bg-accent" aria-hidden="true" />
        </button>
      </div>
    </div>
    <div id="term-panel" role="tabpanel" :aria-labelledby="`term-tab-${active}`" class="min-h-[17rem] overflow-x-auto bg-bg/60 px-4 py-4 font-mono text-[0.76rem] leading-6 sm:px-5 sm:text-[0.82rem]">
      <p v-for="(l, i) in shown" :key="i" class="whitespace-pre" :class="CLASS[l.kind]">
        <span v-if="l.kind === 'cmd'" class="select-none text-accent">$ </span>{{ l.text }}
      </p>
      <p class="whitespace-pre text-text">
        <span v-if="!typing.startsWith('›')" class="select-none text-accent">$ </span>{{ typing }}<span class="caret" aria-hidden="true" />
      </p>
    </div>
  </div>
</template>

<style scoped>
.caret {
  display: inline-block;
  width: 0.55em;
  height: 1.1em;
  margin-left: 1px;
  vertical-align: -0.2em;
  background: var(--accent);
  animation: blink 1s steps(1) infinite;
}
@keyframes blink {
  50% {
    opacity: 0;
  }
}
</style>
