<script setup lang="ts">
import { AGENTS } from "../lib/site.ts";

/** The supported agents as a slow, endless strip; it stops on hover and for reduced motion. */
const row = [...AGENTS, ...AGENTS];
</script>

<template>
  <div class="marquee relative overflow-hidden py-2" role="list" aria-label="Supported agents">
    <div class="track flex w-max gap-3">
      <div
        v-for="(a, i) in row"
        :key="`${a.id}-${i}`"
        role="listitem"
        :aria-hidden="i >= AGENTS.length ? 'true' : undefined"
        class="flex items-center gap-3 rounded-full border border-border bg-surface px-4 py-2"
      >
        <span class="h-1.5 w-1.5 rounded-full bg-accent" aria-hidden="true" />
        <span class="whitespace-nowrap text-sm font-semibold">{{ a.name }}</span>
        <span class="whitespace-nowrap font-mono text-xs text-muted">{{ a.runs }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.marquee {
  mask-image: linear-gradient(90deg, transparent, #000 8%, #000 92%, transparent);
}
.track {
  animation: scroll 48s linear infinite;
}
.marquee:hover .track,
.marquee:focus-within .track {
  animation-play-state: paused;
}
@keyframes scroll {
  to {
    transform: translateX(calc(-50% - 0.375rem));
  }
}
@media (prefers-reduced-motion: reduce) {
  .track {
    animation: none;
    flex-wrap: wrap;
    width: auto;
    justify-content: center;
  }
  .marquee {
    mask-image: none;
  }
  /* Without motion the second copy is only a repeat. */
  .track > [aria-hidden="true"] {
    display: none;
  }
}
</style>
