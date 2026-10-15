<script setup lang="ts">
import type { FlowDefinition, TaskView } from "@navarch/contracts";
import { VueFlow, useVueFlow, type Edge, type Node } from "@vue-flow/core";
import { computed, nextTick, watch } from "vue";
import { useI18n } from "vue-i18n";
import { buildGraph, type GraphNode } from "../lib/graph.ts";
import LoopNode from "./LoopNode.vue";
import TaskNode from "./TaskNode.vue";

/** Read-only live TaskGraph (spec §6.2.4): one node per Flow node, coloured by its latest task. */
const props = defineProps<{
  flow: FlowDefinition;
  params: Record<string, number | string | boolean>;
  tasks: TaskView[];
  skipped: string[];
  selected: string | null;
}>();
const emit = defineEmits<{ select: [id: string | null] }>();
const { t } = useI18n();

const graph = computed(() => buildGraph(props.flow, props.tasks, props.skipped, props.params));

const nodes = computed<Node<GraphNode>[]>(() =>
  graph.value.nodes.map((n) => ({
    id: n.id,
    type: n.kind === "loop" ? "loop" : "task",
    position: n.position,
    data: n,
    ...(n.parent ? { parentNode: n.parent, extent: "parent" as const } : {}),
    selectable: n.kind !== "loop",
    focusable: n.kind !== "loop",
    selected: n.id === props.selected,
    style: { width: `${n.width}px`, height: `${n.height}px` },
    ariaLabel: `${n.label}: ${t(`status.${n.state}`)}`,
  })),
);

const edges = computed<Edge[]>(() =>
  graph.value.edges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    type: e.kind === "loop-back" || e.wrap ? "smoothstep" : "default",
    ...(e.kind === "loop-back" ? { sourceHandle: "back-out", targetHandle: "back-in" } : { sourceHandle: "out" }),
    animated: e.active,
    class: [e.kind, e.active ? "active" : ""].join(" "),
    focusable: false,
    selectable: false,
  })),
);

const { getSelectedNodes, fitView, onPaneReady } = useVueFlow();
watch(
  () => getSelectedNodes.value.map((n) => n.id),
  (ids) => {
    const id = ids[0] ?? null;
    if (id !== props.selected) emit("select", id);
  },
);
/** Fit the graph, but never below a readable zoom: wide Flows pan instead of shrinking. */
const fit = () => void fitView({ padding: 0.1, minZoom: 0.6, maxZoom: 1 });
onPaneReady(fit);
// Opening or closing the node panel resizes the canvas; refit once the new size is laid out.
watch(
  () => [props.flow, props.selected === null],
  async () => {
    await nextTick();
    setTimeout(fit, 80);
  },
);
</script>

<template>
  <div class="grid-canvas h-full w-full" role="region" :aria-label="t('run.graph')">
    <VueFlow
      :nodes="nodes"
      :edges="edges"
      :nodes-draggable="false"
      :nodes-connectable="false"
      :elements-selectable="true"
      :edges-focusable="false"
      :min-zoom="0.3"
      :max-zoom="1.5"
      :zoom-on-double-click="false"
      @pane-click="emit('select', null)"
    >
      <template #node-task="{ data }">
        <TaskNode :data="data" />
      </template>
      <template #node-loop="{ data }">
        <LoopNode :data="data" />
      </template>
    </VueFlow>
  </div>
</template>
