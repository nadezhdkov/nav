<script setup lang="ts">
import { computed } from "vue";
import { encode } from "uqr";

/** A QR code as one SVG path (no innerHTML, so the strict CSP holds); dark on white for any scanner. */
const props = defineProps<{ value: string; label: string }>();

const qr = computed(() => encode(props.value, { ecc: "M", border: 2 }));
const path = computed(() => {
  const parts: string[] = [];
  qr.value.data.forEach((row, y) => row.forEach((on, x) => on && parts.push(`M${x} ${y}h1v1h-1z`)));
  return parts.join("");
});
</script>

<template>
  <svg :viewBox="`0 0 ${qr.size} ${qr.size}`" role="img" :aria-label="label" shape-rendering="crispEdges" class="rounded-lg bg-white">
    <path :d="path" fill="#000" />
  </svg>
</template>
