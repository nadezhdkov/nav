<script setup lang="ts">
import type { FlowProblem, SimulationResult } from "@navarch/contracts";
import { VueFlow, useVueFlow, type Connection, type Edge, type Node } from "@vue-flow/core";
import { computed, nextTick, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { DraftView, NodeType } from "../lib/flowDoc.ts";
import { buildStudioGraph, walkOrder, type StudioNode as StudioNodeData } from "../lib/studioGraph.ts";
import StudioLoop from "./StudioLoop.vue";
import StudioNode from "./StudioNode.vue";

/**
 * Flow Studio's editable canvas (ADR 0033). It only reports gestures: the view turns them into
 * edits of the YAML document, which is what the canvas draws again.
 */
const props = defineProps<{
  view: DraftView;
  problems: FlowProblem[];
  sim: SimulationResult | null;
  selected: string | null;
  readOnly: boolean;
}>();
const emit = defineEmits<{
  select: [id: string | null];
  connect: [source: string, target: string];
  remove: [id: string];
  /** A node dragged from the library: after `onto` (and connected), or disconnected on the empty canvas. */
  drop: [type: NodeType, onto: string | null];
  properties: [];
}>();
const { t } = useI18n();

const graph = computed(() => buildStudioGraph(props.view, props.problems, props.sim));

const nodes = computed<Node<StudioNodeData>[]>(() =>
  graph.value.nodes.map((n) => ({
    id: n.id,
    type: n.type === "loop" ? "loop" : "studio",
    position: n.position,
    data: n,
    ...(n.parent ? { parentNode: n.parent, extent: "parent" as const } : {}),
    selected: n.id === props.selected,
    style: { width: `${n.width}px`, height: `${n.height}px` },
    class: n.id === props.selected && n.type !== "loop" ? "studio-selected" : "",
  })),
);

const edges = computed<Edge[]>(() =>
  graph.value.edges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    type: e.kind === "loop-back" || e.wrap ? "smoothstep" : "default",
    ...(e.kind === "loop-back" ? { sourceHandle: "back-out", targetHandle: "back-in" } : { sourceHandle: "out" }),
    animated: e.simulated,
    class: [e.kind, e.simulated ? "active" : ""].join(" "),
    focusable: false,
    selectable: false,
  })),
);

const { fitView, onPaneReady } = useVueFlow();
const fit = () => void fitView({ padding: 0.15, minZoom: 0.6, maxZoom: 1 });
onPaneReady(fit);
watch(
  () => props.view.nodes.length,
  async () => {
    await nextTick();
    setTimeout(fit, 60);
  },
);

/** Connections only between top-level nodes, never into the trigger or onto itself. */
function valid(c: Connection): boolean {
  if (props.readOnly || c.source === c.target) return false;
  const byId = new Map(graph.value.nodes.map((n) => [n.id, n]));
  const target = byId.get(c.target);
  return !!target && !target.parent && target.type !== "trigger" && !byId.get(c.source)?.parent;
}

function onConnect(c: Connection) {
  if (valid(c)) emit("connect", c.source, c.target);
}

const dragOver = ref(false);
function onDrop(e: DragEvent) {
  dragOver.value = false;
  const type = e.dataTransfer?.getData("application/x-navarch-node") as NodeType | "";
  if (!type || props.readOnly) return;
  const onto = (e.target as HTMLElement | null)?.closest<HTMLElement>(".vue-flow__node")?.dataset.id ?? null;
  emit("drop", type, onto);
}

/** Arrow keys walk the nodes, Enter opens the properties, Delete removes (spec §15.4 keyboard). */
function onKey(e: KeyboardEvent) {
  if ((e.target as HTMLElement).closest("input, textarea, select")) return;
  const order = walkOrder(props.view);
  const i = props.selected ? order.indexOf(props.selected) : -1;
  if (["ArrowRight", "ArrowDown"].includes(e.key)) {
    emit("select", order[Math.min(order.length - 1, i + 1)] ?? null);
  } else if (["ArrowLeft", "ArrowUp"].includes(e.key)) {
    emit("select", order[Math.max(0, i - 1)] ?? null);
  } else if (e.key === "Enter" && props.selected) {
    emit("properties");
  } else if ((e.key === "Delete" || e.key === "Backspace") && props.selected && !props.readOnly) {
    emit("remove", props.selected);
  } else if (e.key === "Escape") {
    emit("select", null);
  } else return;
  e.preventDefault();
}
</script>

<template>
  <div
    class="grid-canvas relative h-full w-full outline-none focus-visible:outline-2 focus-visible:outline-accent"
    :class="{ 'drop-target': dragOver }"
    role="application"
    tabindex="0"
    :aria-label="t('studio.canvas')"
    :aria-describedby="'studio-canvas-help'"
    @keydown="onKey"
    @dragover.prevent="dragOver = !readOnly"
    @dragleave="dragOver = false"
    @drop.prevent="onDrop"
  >
    <p id="studio-canvas-help" class="sr-only">{{ t("studio.canvasHelp") }}</p>
    <VueFlow
      :nodes="nodes"
      :edges="edges"
      :nodes-draggable="false"
      :nodes-connectable="!readOnly"
      :elements-selectable="true"
      :edges-focusable="false"
      :is-valid-connection="valid"
      :delete-key-code="null"
      :min-zoom="0.3"
      :max-zoom="1.5"
      :zoom-on-double-click="false"
      @connect="onConnect"
      @node-click="({ node }) => emit('select', node.id)"
      @pane-click="emit('select', null)"
    >
      <template #node-studio="{ data }">
        <StudioNode :data="data" :read-only="readOnly" />
      </template>
      <template #node-loop="{ data }">
        <StudioLoop :data="data" :read-only="readOnly" :selected="data.id === selected" />
      </template>
    </VueFlow>
    <p v-if="!view.nodes.length" class="pointer-events-none absolute inset-0 grid place-items-center text-sm text-muted">{{ t("studio.empty") }}</p>
  </div>
</template>

<style scoped>
.drop-target {
  box-shadow: inset 0 0 0 2px var(--accent);
}
:deep(.studio-selected) > div {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
  border-radius: 0.5rem;
}
</style>
