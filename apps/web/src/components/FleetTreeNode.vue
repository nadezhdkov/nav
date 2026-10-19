<script setup lang="ts">
import { isTerminalRun } from "@navarch/contracts";
import { Bot, ChevronDown, ChevronRight, Clock, Crown, FolderGit2, GitBranch, GitMerge, Hand, MessageSquare, MessagesSquare, Sparkles } from "@lucide/vue";
import { Handle, Position } from "@vue-flow/core";
import { computed, inject } from "vue";
import { useI18n } from "vue-i18n";
import { iconFor, shortBranch } from "../lib/fleet.ts";
import { TREE_ACTIONS, type TreeNode } from "../lib/fleetTree.ts";
import { money, nodeLook, runLook, runTitle } from "../lib/status.ts";
import PromptBox from "./PromptBox.vue";
import StatusBadge from "./StatusBadge.vue";

/** One node of the Fleet tree (slice 10): a project, a run, an agent, or a lead's sub-agents. */
const props = defineProps<{ data: TreeNode }>();
const mergeTone = { pending: "tone-info", merging: "tone-info", resolving: "tone-warning", merged: "tone-success", conflict: "tone-danger" } as const;
const { t, locale } = useI18n();
const actions = inject(TREE_ACTIONS)!;

const focused = computed(() => actions.focused.value === props.data.id);
const selected = computed(() => actions.selected.value === props.data.id);
const agentNode = computed(() => (props.data.kind === "agent" ? props.data : null));
const look = computed(() => {
  const n = agentNode.value;
  if (n) return nodeLook[n.agent?.status ?? "not_started"];
  if (props.data.kind === "run") return runLook[props.data.run.status];
  if (props.data.kind === "group") return nodeLook[props.data.worst ?? "not_started"];
  return nodeLook.not_started;
});
const live = computed(() => agentNode.value?.agent?.status === "running");
const label = computed(() => {
  const n = agentNode.value;
  if (!n) return "";
  if (n.resolves) return t("tree.resolves", { key: n.resolves });
  return n.member?.title ?? n.agent?.node_id ?? "";
});
const canPrompt = computed(() => {
  const n = agentNode.value;
  // A message to an agent that ended would never be delivered.
  return Boolean(n?.agent && !isTerminalRun(n.run.status) && !["succeeded", "failed", "cancelled"].includes(n.agent.status));
});
const pending = computed(() => {
  const a = agentNode.value?.agent;
  return a ? a.pending_messages + actions.sentSince(a.id) : 0;
});
const until = (iso?: string) => (iso ? new Date(iso).toLocaleTimeString(locale.value, { hour: "2-digit", minute: "2-digit" }) : "");
const ring = computed(() => (focused.value ? "0 0 0 2px var(--bg), 0 0 0 4px var(--accent)" : selected.value ? "0 0 0 1px var(--accent)" : live.value ? "var(--glow)" : "var(--card-shadow)"));

function activate() {
  const d = props.data;
  if (d.kind === "run" || d.kind === "subagents") actions.toggle(d.id);
  else if (d.kind === "agent" && d.agent) actions.open(d.run.id, d.agent.node_id);
}
</script>

<template>
  <div
    class="relative h-full w-full overflow-hidden rounded-lg border bg-surface text-left"
    :class="[`tone-${look.tone}`, { pulse: live && !focused, 'cursor-pointer': data.kind !== 'project' && data.kind !== 'subagent' && data.kind !== 'group' }]"
    :style="{
      borderColor: selected ? 'var(--accent)' : data.kind === 'project' ? 'var(--border)' : 'color-mix(in srgb, var(--tone) 50%, var(--border))',
      boxShadow: ring,
    }"
    :data-tree-id="data.id"
    @click="activate"
  >
    <Handle id="in" type="target" :position="Position.Top" :connectable="false" />
    <Handle id="out" type="source" :position="Position.Bottom" :connectable="false" />
    <Handle id="side-in" type="target" :position="Position.Left" :connectable="false" />
    <Handle id="side-out" type="source" :position="Position.Right" :connectable="false" />
    <Handle id="up-out" type="source" :position="Position.Top" :connectable="false" />
    <Handle id="up-in" type="target" :position="Position.Bottom" :connectable="false" />

    <!-- Project -->
    <div v-if="data.kind === 'project'" class="flex h-full items-center gap-3 px-3">
      <span class="grid size-9 shrink-0 place-items-center rounded-md bg-surface-2 text-accent"><FolderGit2 :size="18" aria-hidden="true" /></span>
      <div class="min-w-0">
        <p class="truncate font-semibold">{{ data.project.id ? data.project.name : t("tree.otherRepos") }}</p>
        <p class="truncate text-xs text-muted">
          <template v-if="data.project.repo">{{ data.project.repo }} · </template>{{ t("tree.projectCounts", { runs: data.project.runs, running: data.project.running }) }}
        </p>
      </div>
    </div>

    <!-- Run -->
    <div v-else-if="data.kind === 'run'" class="flex h-full flex-col gap-1.5 px-3 py-2.5">
      <div class="flex items-center gap-2">
        <button
          type="button"
          class="nodrag grid size-6 shrink-0 place-items-center rounded text-muted hover:bg-surface-2"
          :aria-expanded="!data.collapsed"
          :aria-label="data.collapsed ? t('tree.expand') : t('tree.collapse')"
          @click.stop="actions.toggle(data.id)"
        >
          <component :is="data.collapsed ? ChevronRight : ChevronDown" :size="15" aria-hidden="true" />
        </button>
        <RouterLink :to="`/runs/${data.run.id}`" class="nodrag min-w-0 flex-1 truncate font-semibold hover:text-accent" :title="data.run.prompt" @click.stop>{{ runTitle(data.run) }}</RouterLink>
      </div>
      <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
        <StatusBadge :look="look" :status="data.run.status" />
        <span class="truncate text-xs text-muted">{{ data.run.flow ?? "–" }}<template v-if="!data.run.project_id"> · {{ data.run.repo_path.split("/").pop() }}</template></span>
      </div>
      <div v-if="data.run.progress" class="flex items-center gap-2 text-xs">
        <span class="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-2" aria-hidden="true">
          <span class="block h-full rounded-full bg-accent" :style="{ width: `${data.run.progress.total ? (100 * data.run.progress.done) / data.run.progress.total : 0}%` }" />
        </span>
        <span class="shrink-0 text-muted">{{ t("tree.progress", { done: data.run.progress.done, total: data.run.progress.total }) }}</span>
      </div>
      <div class="mt-auto flex items-center gap-2 text-xs">
        <span class="font-mono whitespace-nowrap">{{ money(data.run.cost_total) }} <span class="text-muted">{{ t("run.budget", { budget: money(data.run.budget) }) }}</span></span>
        <template v-if="data.collapsed">
          <span class="ml-auto whitespace-nowrap text-muted">{{ t("tree.agents", { n: data.agentCount }) }}</span>
          <StatusBadge v-if="data.worst" :look="nodeLook[data.worst]" :status="data.worst" />
        </template>
        <button
          v-else-if="data.run.team"
          type="button"
          class="nodrag ml-auto inline-flex min-h-7 items-center gap-1 rounded px-1.5 text-accent hover:bg-surface-2"
          @click.stop="actions.open(data.run.id, `${data.run.team.node_id}.lead`)"
        >
          <MessagesSquare :size="13" aria-hidden="true" />{{ t("tree.leadChat") }}
        </button>
      </div>
    </div>

    <!-- Agent: a Flow agent, a team lead or a member -->
    <div v-else-if="data.kind === 'agent'" class="flex h-full flex-col gap-1.5 px-3 py-2.5">
      <div class="flex items-center gap-2">
        <span class="grid size-8 shrink-0 place-items-center rounded-md bg-surface-2" style="color: var(--tone)">
          <component :is="data.role === 'lead' ? Crown : iconFor(data.member?.profile ?? data.agent?.profile ?? '')" :size="16" aria-hidden="true" />
        </span>
        <div class="min-w-0 flex-1">
          <p class="flex items-center gap-1.5">
            <span class="truncate font-medium">{{ label }}</span>
            <span v-if="data.role === 'lead'" class="shrink-0 rounded bg-accent px-1.5 text-[10px] font-semibold tracking-wide text-bg uppercase">{{ t("tree.lead") }}</span>
          </p>
          <p class="truncate text-xs text-muted">{{ data.member?.profile ?? data.agent?.profile }}<template v-if="data.role === 'lead' && data.team"> · {{ t("tree.turn", { turn: data.team.turn, max: data.team.max_turns ?? "–" }) }}</template></p>
        </div>
        <span v-if="pending" class="tone-info inline-flex shrink-0 items-center gap-1 text-xs" style="color: var(--tone)" :title="t('fleet.pendingMessages', { n: pending })">
          <MessageSquare :size="12" aria-hidden="true" />{{ pending }}
        </span>
      </div>

      <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
        <StatusBadge v-if="data.agent" :look="look" :status="data.agent.status" />
        <StatusBadge v-else :look="nodeLook.not_started" status="planned" />
        <span v-if="data.agent" class="min-w-0 truncate font-mono text-[11px] text-muted">{{ data.agent.model ?? data.agent.adapter }}</span>
        <span v-else-if="data.member?.prefer" class="min-w-0 truncate font-mono text-[11px] text-muted">{{ t("tree.prefers", { agent: data.member.prefer }) }}</span>
        <!-- A parallel member's merge back into the run's worktree (ADR 0029): icon and text, not color alone. -->
        <span v-if="data.member?.merge" :class="mergeTone[data.member.merge]" class="inline-flex shrink-0 items-center gap-1 text-[11px]" style="color: var(--tone)">
          <GitMerge :size="11" aria-hidden="true" />{{ t(`tree.merge.${data.member.merge}`) }}
        </span>
      </div>

      <p v-if="data.agent" class="flex items-center gap-2 text-[11px] text-muted">
        <span class="font-mono">{{ money(data.agent.cost) }}</span>
        <span v-if="data.agent.iteration > 1">×{{ data.agent.iteration }}</span>
        <span v-if="data.agent.branch" class="flex min-w-0 items-center gap-1 truncate font-mono" :title="data.agent.branch"><GitBranch :size="11" class="shrink-0" aria-hidden="true" />{{ shortBranch(data.agent.branch) }}</span>
      </p>

      <!-- What it is doing or waiting for: a question for the user first. -->
      <div v-if="data.role === 'lead' && data.team?.question" class="tone-warning min-h-0 flex-1 overflow-hidden rounded-md border px-2 py-1 text-xs" style="border-color: color-mix(in srgb, var(--tone) 45%, transparent)">
        <p class="flex items-center gap-1 font-semibold" style="color: var(--tone)"><Hand :size="12" aria-hidden="true" />{{ t("tree.waitingForYou") }}</p>
        <p class="line-clamp-2">{{ data.team.question }}</p>
      </div>
      <p v-else-if="data.agent?.waiting?.kind === 'quota'" class="tone-warning flex items-center gap-1 text-xs" style="color: var(--tone)">
        <Clock :size="12" aria-hidden="true" />{{ t("fleet.waitingQuota", { until: until(data.agent.waiting.until) }) }}
      </p>
      <p v-else-if="data.role === 'lead' && data.team?.summary" class="line-clamp-3 min-h-0 flex-1 text-xs text-muted">{{ data.team.summary }}</p>
      <p v-else-if="data.member?.summary" class="line-clamp-2 min-h-0 flex-1 text-xs text-muted">{{ data.member.summary }}</p>
      <p v-else-if="data.agent?.last_activity" class="line-clamp-2 min-h-0 flex-1 text-xs text-muted" :title="data.agent.last_activity.text">
        <span v-if="data.agent.last_activity.tool" class="font-mono text-fg">{{ data.agent.last_activity.tool }} · </span>{{ data.agent.last_activity.text }}
      </p>
      <p v-else-if="data.member && !data.agent" class="line-clamp-2 min-h-0 flex-1 text-xs text-muted">{{ t("tree.plannedHint", { turn: data.member.turn }) }}</p>
      <div v-else class="flex-1" />

      <div class="mt-auto">
        <PromptBox v-if="canPrompt && data.agent" :run-id="data.run.id" :task-id="data.agent.id" :label="label" @sent="actions.sent(data.agent.id)" />
      </div>
    </div>

    <!-- A group of members the lead put together -->
    <div v-else-if="data.kind === 'group'" class="flex h-full flex-col justify-center gap-0.5 px-3">
      <p class="flex items-center gap-1.5 truncate text-sm font-medium"><component :is="iconFor(data.name)" :size="14" class="shrink-0 text-muted" aria-hidden="true" /><span class="truncate">{{ data.name }}</span></p>
      <p class="text-xs text-muted">{{ t("tree.group", { n: data.members.length }) }}</p>
    </div>

    <!-- The lead's own sub-agents, folded by default -->
    <button
      v-else-if="data.kind === 'subagents'"
      type="button"
      class="nodrag flex h-full w-full items-center gap-2 px-3 text-xs text-muted hover:text-fg"
      :aria-expanded="data.expanded"
      @click.stop="actions.toggle(data.id)"
    >
      <component :is="data.expanded ? ChevronDown : ChevronRight" :size="14" aria-hidden="true" />
      <Sparkles :size="13" aria-hidden="true" />{{ t("tree.internal", { n: data.count }) }}
    </button>

    <div v-else-if="data.kind === 'subagent'" class="flex h-full flex-col justify-center gap-0.5 px-3 text-xs">
      <p class="flex items-center gap-1.5 truncate"><Bot :size="12" class="shrink-0 text-muted" aria-hidden="true" /><span class="truncate">{{ data.subagent.description }}</span></p>
      <p class="text-muted">{{ t("tree.internalTag") }} · {{ data.subagent.status === "started" ? t("tree.subStarted") : t("tree.subFinished") }}</p>
    </div>
  </div>
</template>
