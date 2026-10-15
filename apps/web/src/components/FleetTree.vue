<script setup lang="ts">
import type { FleetView, ProjectView } from "@navarch/contracts";
import { VueFlow, useVueFlow, type Edge, type Node } from "@vue-flow/core";
import { computed, nextTick, provide, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { buildFleetTree, moveFocus, TREE_ACTIONS, type TreeMove, type TreeNode } from "../lib/fleetTree.ts";
import FleetTreeNode from "./FleetTreeNode.vue";

/**
 * The Fleet as a read-only tree on a canvas (slice 10): pan and zoom, no dragging or editing.
 * The keyboard walks the tree (arrows), Enter opens an agent or folds a run, Esc closes the panel.
 */
const props = defineProps<{
  view: FleetView;
  projects: Pick<ProjectView, "id" | "name" | "repo" | "path">[];
  collapsed: Set<string>;
  expanded: Set<string>;
  /** The tree node of the agent whose panel is open. */
  selected: string | null;
}>();
const emit = defineEmits<{ toggle: [id: string]; open: [runId: string, nodeId: string]; close: [] }>();
const { t } = useI18n();

const tree = computed(() => buildFleetTree(props.view, props.projects, props.collapsed, props.expanded));
const focused = ref<string | null>(null);
const selected = computed(() => props.selected);

// Instructions sent from cards count on the badge until the next fetch brings the real number.
const sentCounts = ref(new Map<string, number>());
watch(
  () => props.view.generated_at,
  () => (sentCounts.value = new Map()),
);

provide(TREE_ACTIONS, {
  focused,
  selected,
  toggle: (id) => emit("toggle", id),
  open: (runId, nodeId) => emit("open", runId, nodeId),
  sentSince: (taskId) => sentCounts.value.get(taskId) ?? 0,
  sent: (taskId) => {
    const next = new Map(sentCounts.value);
    next.set(taskId, (next.get(taskId) ?? 0) + 1);
    sentCounts.value = next;
  },
});

const nodes = computed<Node<TreeNode>[]>(() =>
  tree.value.nodes.map((n) => ({
    id: n.id,
    type: "tree",
    position: n.position,
    data: n,
    draggable: false,
    selectable: false,
    focusable: false,
    style: { width: `${n.width}px`, height: `${n.height}px` },
  })),
);

const edges = computed<Edge[]>(() =>
  tree.value.edges.map((e) => {
    const handles =
      e.kind === "after" ? { sourceHandle: "side-out", targetHandle: "side-in" } : e.kind === "reports" ? { sourceHandle: "up-out", targetHandle: "up-in" } : { sourceHandle: "out", targetHandle: "in" };
    const label = e.kind === "delegates" ? t("tree.delegates", { turn: e.turn ?? 1 }) : e.kind === "after" ? t("tree.after") : e.kind === "reports" ? t("tree.reports") : undefined;
    return {
      id: e.id,
      source: e.source,
      target: e.target,
      type: e.kind === "tree" || e.kind === "delegates" ? "smoothstep" : "default",
      ...handles,
      ...(label ? { label, labelBgPadding: [6, 3] as [number, number], labelBgBorderRadius: 4, labelShowBg: true } : {}),
      animated: e.animated,
      class: [`tree-${e.kind}`, e.animated ? "active" : ""].join(" "),
      focusable: false,
      selectable: false,
    };
  }),
);

const { fitView, setCenter, getViewport, onPaneReady } = useVueFlow("fleet-tree");
const fit = () => void fitView({ padding: 0.12, minZoom: 0.7, maxZoom: 1 });
onPaneReady(fit);
defineExpose({ fit });

const byId = computed(() => new Map(tree.value.nodes.map((n) => [n.id, n])));
const focusedNode = computed(() => (focused.value ? byId.value.get(focused.value) : undefined));
// A node folded away loses focus to its run.
watch(tree, () => {
  if (focused.value && !byId.value.has(focused.value)) focused.value = null;
});

function center(id: string) {
  const n = byId.value.get(id);
  if (n) void setCenter(n.position.x + n.width / 2, n.position.y + n.height / 2, { zoom: Math.max(getViewport().zoom, 0.7), duration: 200 });
}

const KEYS: Record<string, TreeMove> = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right" };
function onKey(e: KeyboardEvent) {
  const move = KEYS[e.key];
  if (move) {
    e.preventDefault();
    focused.value = moveFocus(tree.value.nodes, focused.value, move);
    if (focused.value) center(focused.value);
  } else if (e.key === "Enter" || e.key === " ") {
    const n = focusedNode.value;
    if (!n) return;
    e.preventDefault();
    if (n.kind === "run" || n.kind === "subagents") emit("toggle", n.id);
    else if (n.kind === "agent" && n.agent) emit("open", n.run.id, n.agent.node_id);
  } else if (e.key === "Escape") {
    emit("close");
  }
}

function onFocus() {
  if (!focused.value) focused.value = moveFocus(tree.value.nodes, null, "down");
}

/** What a screen reader hears for the focused node. */
const announce = computed(() => {
  const n = focusedNode.value;
  if (!n) return "";
  switch (n.kind) {
    case "project":
      return n.project.id ? n.project.name : t("tree.otherRepos");
    case "run":
      return `${n.run.prompt.split("\n")[0]}: ${t(`status.${n.run.status}`)}${n.collapsed ? `, ${t("tree.agents", { n: n.agentCount })}` : ""}`;
    case "agent":
      return `${n.role === "lead" ? `${t("tree.lead")} ` : ""}${n.member?.title ?? n.agent?.node_id}: ${t(`status.${n.agent?.status ?? "planned"}`)}`;
    case "subagents":
      return t("tree.internal", { n: n.count });
    case "subagent":
      return n.subagent.description;
  }
  return "";
});

// Folding a run changes the tree's size; keep the focused node in view.
watch(
  () => [props.collapsed.size, props.expanded.size],
  async () => {
    await nextTick();
    if (focused.value) center(focused.value);
  },
);
</script>

<template>
  <div
    class="grid-canvas relative h-full w-full outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset"
    role="application"
    :aria-roledescription="t('tree.roledescription')"
    tabindex="0"
    :aria-label="t('tree.canvas')"
    @keydown="onKey"
    @focus="onFocus"
  >
    <VueFlow
      id="fleet-tree"
      :nodes="nodes"
      :edges="edges"
      :nodes-draggable="false"
      :nodes-connectable="false"
      :elements-selectable="false"
      :edges-focusable="false"
      :nodes-focusable="false"
      :min-zoom="0.2"
      :max-zoom="1.5"
      :zoom-on-double-click="false"
      @pane-click="emit('close')"
    >
      <template #node-tree="{ data }">
        <FleetTreeNode :data="data" />
      </template>
    </VueFlow>
    <p class="sr-only" aria-live="polite">{{ announce }}</p>
  </div>
</template>
